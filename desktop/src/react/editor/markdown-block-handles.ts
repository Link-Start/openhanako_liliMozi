import { Transaction } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import {
  buildMarkdownBlockMove,
  collectMarkdownBlocks,
  type MarkdownBlock,
  type MarkdownBlockPlacement,
} from './markdown-blocks';

export type MarkdownBlockMenuTarget = MarkdownBlock;

export interface MarkdownBlockMenuRequest {
  readonly id: number;
  readonly position: { x: number; y: number };
  readonly target: MarkdownBlockMenuTarget;
}

interface MarkdownBlockHandleOptions {
  readonly readOnly?: boolean;
  readonly onOpenMenu: (request: MarkdownBlockMenuRequest) => void;
}

const HANDLE_SIZE = 24;
const HANDLE_GAP = 4;
const HANDLE_RAIL_WIDTH = HANDLE_SIZE + HANDLE_GAP;
const DRAG_THRESHOLD = 4;

function blockMatches(left: MarkdownBlock, right: MarkdownBlock): boolean {
  return left.from === right.from
    && left.to === right.to
    && left.type === right.type
    && left.source === right.source;
}

function blockAtCurrentPosition(view: EditorView, candidate: MarkdownBlock): MarkdownBlock | null {
  return collectMarkdownBlocks(view.state).find(block => blockMatches(block, candidate)) ?? null;
}

function translation(ownerWindow: Window, key: string, fallback: string): string {
  const translated = ownerWindow.t?.(key);
  return translated && translated !== key ? translated : fallback;
}

function createGripIcon(doc: Document): SVGSVGElement {
  const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 14 14');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');

  for (const x of [4, 10]) {
    for (const y of [3, 7, 11]) {
      const dot = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
      dot.setAttribute('x1', String(x));
      dot.setAttribute('x2', String(x));
      dot.setAttribute('y1', String(y));
      dot.setAttribute('y2', String(y));
      icon.appendChild(dot);
    }
  }
  return icon;
}

class MarkdownBlockHandleView {
  private readonly rail: HTMLDivElement;
  private readonly dropIndicator: HTMLDivElement;
  private readonly ownerWindow: Window;
  private blocks: MarkdownBlock[] = [];
  private draggedBlock: MarkdownBlock | null = null;
  private dropTarget: { block: MarkdownBlock; placement: MarkdownBlockPlacement } | null = null;
  private pendingDrag: {
    block: MarkdownBlock;
    button: HTMLButtonElement;
    pointerId: number;
    startY: number;
  } | null = null;
  private suppressClick = false;
  private frameId: number | null = null;
  private requestId = 0;

  constructor(
    private readonly view: EditorView,
    private readonly options: MarkdownBlockHandleOptions,
  ) {
    const doc = view.dom.ownerDocument;
    this.ownerWindow = doc.defaultView ?? window;
    this.rail = doc.createElement('div');
    this.rail.className = 'cm-markdown-block-rail';
    this.rail.setAttribute('aria-hidden', options.readOnly ? 'true' : 'false');

    this.dropIndicator = doc.createElement('div');
    this.dropIndicator.className = 'cm-markdown-block-drop-indicator';
    this.dropIndicator.hidden = true;

    view.dom.append(this.rail, this.dropIndicator);
    view.scrollDOM.addEventListener('scroll', this.scheduleRender, { passive: true });
    this.ownerWindow.addEventListener('resize', this.scheduleRender);
    this.scheduleRender();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      this.scheduleRender();
    }
  }

  destroy(): void {
    if (this.frameId !== null) this.ownerWindow.cancelAnimationFrame(this.frameId);
    this.view.scrollDOM.removeEventListener('scroll', this.scheduleRender);
    this.ownerWindow.removeEventListener('resize', this.scheduleRender);
    this.rail.remove();
    this.dropIndicator.remove();
  }

  private readonly scheduleRender = (): void => {
    if (this.frameId !== null) return;
    this.frameId = this.ownerWindow.requestAnimationFrame(() => {
      this.frameId = null;
      this.render();
    });
  };

  private render(): void {
    if (this.pendingDrag) return;
    this.blocks = collectMarkdownBlocks(this.view.state);
    this.rail.replaceChildren();
    if (this.options.readOnly || this.blocks.length === 0) return;

    const editorRect = this.view.dom.getBoundingClientRect();
    const visibleBlocks = this.blocks.filter(block => (
      block.to >= this.view.viewport.from && block.from <= this.view.viewport.to
    ));

    for (const block of visibleBlocks) {
      const start = this.view.coordsAtPos(block.from, 1);
      if (!start) continue;
      const nextBlock = this.blocks[this.blocks.indexOf(block) + 1];
      const nextStart = nextBlock ? this.view.coordsAtPos(nextBlock.from, 1) : null;
      const end = this.view.coordsAtPos(block.to, -1);
      const top = start.top - editorRect.top;
      const naturalBottom = nextStart?.top ?? end?.bottom ?? (start.bottom + HANDLE_SIZE);
      const height = Math.max(HANDLE_SIZE, naturalBottom - start.top);

      const item = this.view.dom.ownerDocument.createElement('div');
      item.className = 'cm-markdown-block-rail-item';
      item.style.left = `${start.left - editorRect.left - HANDLE_RAIL_WIDTH}px`;
      item.style.top = `${top}px`;
      item.style.height = `${height}px`;
      item.dataset.blockFrom = String(block.from);

      const button = this.view.dom.ownerDocument.createElement('button');
      const blockActionsLabel = translation(this.ownerWindow, 'ctx.blockActions', 'Block actions');
      button.type = 'button';
      button.className = 'cm-markdown-block-handle';
      button.title = blockActionsLabel;
      button.setAttribute('aria-label', blockActionsLabel);
      button.appendChild(createGripIcon(this.view.dom.ownerDocument));
      button.addEventListener('mousedown', event => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (this.suppressClick) return;
        const current = blockAtCurrentPosition(this.view, block);
        if (!current) return;
        const rect = button.getBoundingClientRect();
        this.options.onOpenMenu({
          id: ++this.requestId,
          position: { x: rect.right, y: rect.top },
          target: current,
        });
      });
      button.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        const current = blockAtCurrentPosition(this.view, block);
        if (!current) return;
        if (this.frameId !== null) {
          this.ownerWindow.cancelAnimationFrame(this.frameId);
          this.frameId = null;
        }
        this.pendingDrag = {
          block: current,
          button,
          pointerId: event.pointerId,
          startY: event.clientY,
        };
        button.setPointerCapture?.(event.pointerId);
      });
      button.addEventListener('pointermove', event => {
        const pending = this.pendingDrag;
        if (!pending || pending.pointerId !== event.pointerId) return;
        if (!this.draggedBlock && Math.abs(event.clientY - pending.startY) < DRAG_THRESHOLD) return;
        if (!this.draggedBlock) {
          this.draggedBlock = pending.block;
          pending.button.classList.add('is-dragging');
          this.suppressClick = true;
        }
        event.preventDefault();
        event.stopPropagation();
        this.updateDropTarget(event.clientY);
      });
      button.addEventListener('pointerup', event => {
        const pending = this.pendingDrag;
        if (!pending || pending.pointerId !== event.pointerId) return;
        if (this.draggedBlock) {
          event.preventDefault();
          event.stopPropagation();
          this.commitDrop();
          this.ownerWindow.setTimeout(() => { this.suppressClick = false; }, 0);
        }
        button.releasePointerCapture?.(event.pointerId);
        pending.button.classList.remove('is-dragging');
        this.pendingDrag = null;
        this.scheduleRender();
      });
      button.addEventListener('pointercancel', event => {
        if (this.pendingDrag?.pointerId !== event.pointerId) return;
        this.pendingDrag.button.classList.remove('is-dragging');
        this.pendingDrag = null;
        this.suppressClick = false;
        this.clearDragState();
        this.scheduleRender();
      });

      item.appendChild(button);
      this.rail.appendChild(item);
    }
  }

  private updateDropTarget(clientY: number): void {
    if (!this.draggedBlock) return;
    const draggedBlock = this.draggedBlock;
    const candidates = this.blocks
      .filter(block => !blockMatches(block, draggedBlock))
      .map(block => ({
        block,
        start: this.view.coordsAtPos(block.from, 1),
        end: this.view.coordsAtPos(block.to, -1),
      }))
      .filter((candidate): candidate is {
        block: MarkdownBlock;
        start: { top: number; bottom: number; left: number; right: number };
        end: { top: number; bottom: number; left: number; right: number };
      } => Boolean(candidate.start && candidate.end));
    if (candidates.length === 0) return;

    let nextTarget: { block: MarkdownBlock; placement: MarkdownBlockPlacement } = {
      block: candidates[candidates.length - 1].block,
      placement: 'after',
    };
    for (const { block, start, end } of candidates) {
      const midpoint = start.top + ((end.bottom - start.top) / 2);
      if (clientY < midpoint) {
        nextTarget = { block, placement: 'before' };
        break;
      }
      nextTarget = { block, placement: 'after' };
    }
    this.dropTarget = nextTarget;
    this.showDropIndicator(nextTarget.block, nextTarget.placement);
  }

  private commitDrop(): void {
    const source = this.draggedBlock ? blockAtCurrentPosition(this.view, this.draggedBlock) : null;
    const target = this.dropTarget
      ? blockAtCurrentPosition(this.view, this.dropTarget.block)
      : null;
    const placement = this.dropTarget?.placement ?? 'before';
    if (!source || !target) {
      this.clearDragState();
      return;
    }
    const move = buildMarkdownBlockMove(this.view.state, source, target, placement);
    this.clearDragState();
    if (!move) return;

    this.view.dispatch({
      changes: move.changes,
      selection: { anchor: move.selectionAnchor },
      scrollIntoView: true,
      annotations: Transaction.userEvent.of('move.drop'),
    });
    this.view.focus();
  }

  private showDropIndicator(target: MarkdownBlock, placement: MarkdownBlockPlacement): void {
    const editorRect = this.view.dom.getBoundingClientRect();
    const start = this.view.coordsAtPos(target.from, 1);
    const end = this.view.coordsAtPos(target.to, -1);
    if (!start || !end) return;
    const top = (placement === 'before' ? start.top : end.bottom) - editorRect.top;
    this.dropIndicator.style.left = `${Math.max(0, start.left - editorRect.left - HANDLE_RAIL_WIDTH)}px`;
    this.dropIndicator.style.top = `${top}px`;
    this.dropIndicator.style.width = `${Math.max(HANDLE_SIZE, editorRect.right - start.left)}px`;
    this.dropIndicator.hidden = false;
  }

  private clearDragState(): void {
    this.draggedBlock = null;
    this.dropTarget = null;
    this.dropIndicator.hidden = true;
  }
}

export function markdownBlockHandlePlugin(options: MarkdownBlockHandleOptions) {
  return ViewPlugin.define(view => new MarkdownBlockHandleView(view, options));
}
