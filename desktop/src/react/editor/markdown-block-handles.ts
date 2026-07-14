import { EditorSelection, Transaction } from '@codemirror/state';
import {
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
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

const HANDLE_WIDTH = 20;
const HANDLE_HEIGHT = 24;
const HANDLE_GAP = 8;
const HANDLE_RAIL_WIDTH = HANDLE_WIDTH + HANDLE_GAP;
const DROP_INDICATOR_INSET = 8;
const DRAG_THRESHOLD = 4;
const FENCE_LINE_RE = /^ {0,3}(?:`{3,}|~{3,})/;

type EditorCoordinates = NonNullable<ReturnType<EditorView['coordsAtPos']>>;

interface MeasuredMarkdownBlock {
  readonly start: EditorCoordinates;
  readonly end: EditorCoordinates;
  readonly left: number;
  readonly textBounds: { left: number; right: number } | null;
}

interface MarkdownBlockRailItemLayout {
  readonly block: MarkdownBlock;
  readonly measurement: MeasuredMarkdownBlock;
  readonly left: number;
  readonly top: number;
  readonly height: number;
  readonly handleTop: number;
}

interface MarkdownBlockRailLayout {
  readonly items: MarkdownBlockRailItemLayout[];
}

function lineCoordinates(
  view: EditorView,
  lineNumber: number,
  edge: 'start' | 'end',
): EditorCoordinates | null {
  const line = view.state.doc.line(lineNumber);
  const positions = edge === 'start'
    ? [line.from, line.to]
    : [line.to, line.from];
  const visited = new Set<number>();
  for (const position of positions) {
    if (visited.has(position)) continue;
    visited.add(position);
    const coordinates = view.coordsAtPos(position, edge === 'start' ? 1 : -1);
    if (coordinates) return coordinates;
  }
  return null;
}

function measurableLineNumbers(view: EditorView, block: MarkdownBlock): number[] {
  const all: number[] = [];
  const withoutFences: number[] = [];
  for (let lineNumber = block.startLine; lineNumber <= block.endLine; lineNumber += 1) {
    all.push(lineNumber);
    if (!FENCE_LINE_RE.test(view.state.doc.line(lineNumber).text)) withoutFences.push(lineNumber);
  }
  return withoutFences.length > 0 ? withoutFences : all;
}

function renderedLineCoordinates(
  view: EditorView,
  lineNumber: number,
  edge: 'start' | 'end',
): EditorCoordinates | null {
  const horizontal = lineCoordinates(view, lineNumber, edge);
  if (!horizontal) return null;
  const line = view.state.doc.line(lineNumber);
  const lineBlock = view.lineBlockAt(line.from);
  const top = view.documentTop + (lineBlock.top * view.scaleY);
  const firstVisualBoundary = view.moveToLineBoundary(EditorSelection.cursor(line.from), true, true);
  const height = firstVisualBoundary.head < line.to
    ? horizontal.bottom - horizontal.top
    : lineBlock.height * view.scaleY;
  return {
    ...horizontal,
    top,
    bottom: top + height,
  };
}

function renderedLineElement(view: EditorView, lineNumber: number): HTMLElement | null {
  const line = view.state.doc.line(lineNumber);
  const { node } = view.domAtPos(line.from, 1);
  let element = node.nodeType === Node.ELEMENT_NODE
    ? node as HTMLElement
    : node.parentElement;
  while (element && element !== view.contentDOM) {
    if (element.classList.contains('cm-line')) return element;
    element = element.parentElement;
  }
  return null;
}

function measureMarkdownBlock(view: EditorView, block: MarkdownBlock): MeasuredMarkdownBlock | null {
  let start: EditorCoordinates | null = null;
  let end: EditorCoordinates | null = null;
  let left = Number.POSITIVE_INFINITY;
  let textLeft = Number.POSITIVE_INFINITY;
  let textRight = Number.NEGATIVE_INFINITY;

  const lineNumbers = measurableLineNumbers(view, block);
  for (const lineNumber of lineNumbers) {
    const coordinates = renderedLineCoordinates(view, lineNumber, 'start');
    if (!coordinates) continue;
    start ??= coordinates;
    left = Math.min(left, coordinates.left);
    const lineElement = renderedLineElement(view, lineNumber);
    if (lineElement) {
      const lineRect = lineElement.getBoundingClientRect();
      textLeft = Math.min(textLeft, lineRect.left);
      textRight = Math.max(textRight, lineRect.right);
    }
  }
  for (let index = lineNumbers.length - 1; index >= 0; index -= 1) {
    end = renderedLineCoordinates(view, lineNumbers[index], 'end');
    if (end) break;
  }

  if (!start || !end || !Number.isFinite(left)) return null;
  const textBounds = Number.isFinite(textLeft) && Number.isFinite(textRight) && textRight > textLeft
    ? { left: textLeft, right: textRight }
    : null;
  return { start, end, left, textBounds };
}

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
  private measuredBlocks: Array<{
    block: MarkdownBlock;
    measurement: MeasuredMarkdownBlock;
  }> = [];
  private draggedBlock: MarkdownBlock | null = null;
  private dropTarget: { block: MarkdownBlock; placement: MarkdownBlockPlacement } | null = null;
  private pendingDrag: {
    block: MarkdownBlock;
    button: HTMLButtonElement;
    pointerId: number;
    startX: number;
    startY: number;
  } | null = null;
  private dragPreview: HTMLElement | null = null;
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
    this.dropIndicator.setAttribute('aria-hidden', 'true');

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
    this.removeDragPreview();
    this.view.scrollDOM.removeEventListener('scroll', this.scheduleRender);
    this.ownerWindow.removeEventListener('resize', this.scheduleRender);
    this.rail.remove();
    this.dropIndicator.remove();
  }

  private readonly scheduleRender = (): void => {
    if (this.frameId !== null) return;
    this.frameId = this.ownerWindow.requestAnimationFrame(() => {
      this.frameId = null;
      const layout = this.readLayout();
      if (layout) this.render(layout);
    });
  };

  private readLayout(): MarkdownBlockRailLayout | null {
    if (this.pendingDrag) return null;
    const blocks = collectMarkdownBlocks(this.view.state);
    if (this.options.readOnly || blocks.length === 0) return { items: [] };
    const editorRect = this.view.dom.getBoundingClientRect();
    const visibleBlocks = blocks.filter(block => (
      block.to >= this.view.viewport.from && block.from <= this.view.viewport.to
    ));
    const items: MarkdownBlockRailItemLayout[] = [];

    for (const block of visibleBlocks) {
      const measurement = measureMarkdownBlock(this.view, block);
      if (!measurement) continue;
      const { start, end, left } = measurement;
      items.push({
        block,
        measurement,
        left: Math.max(HANDLE_GAP, left - editorRect.left - HANDLE_RAIL_WIDTH),
        top: start.top - editorRect.top,
        height: Math.max(HANDLE_HEIGHT, end.bottom - start.top),
        handleTop: Math.max(0, (start.bottom - start.top - HANDLE_HEIGHT) / 2),
      });
    }
    return { items };
  }

  private render(layout: MarkdownBlockRailLayout): void {
    if (this.pendingDrag) return;
    this.measuredBlocks = layout.items.map(({ block, measurement }) => ({ block, measurement }));
    this.rail.replaceChildren();
    if (this.options.readOnly || layout.items.length === 0) return;

    for (const { block, left, top, height, handleTop } of layout.items) {
      const item = this.view.dom.ownerDocument.createElement('div');
      item.className = 'cm-markdown-block-rail-item';
      item.style.left = `${left}px`;
      item.style.top = `${top}px`;
      item.style.height = `${height}px`;
      item.dataset.blockFrom = String(block.from);

      const button = this.view.dom.ownerDocument.createElement('button');
      const blockActionsLabel = translation(this.ownerWindow, 'ctx.blockActions', 'Block actions');
      button.type = 'button';
      button.className = 'cm-markdown-block-handle';
      button.style.top = `${handleTop}px`;
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
          startX: event.clientX,
          startY: event.clientY,
        };
        button.setPointerCapture?.(event.pointerId);
      });
      button.addEventListener('pointermove', event => {
        const pending = this.pendingDrag;
        if (!pending || pending.pointerId !== event.pointerId) return;
        const deltaX = event.clientX - pending.startX;
        const deltaY = event.clientY - pending.startY;
        if (!this.draggedBlock && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
        if (!this.draggedBlock) {
          this.draggedBlock = pending.block;
          pending.button.classList.add('is-dragging');
          this.suppressClick = true;
          this.createDragPreview(pending.block);
        }
        event.preventDefault();
        event.stopPropagation();
        this.moveDragPreview(deltaX, deltaY);
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

  private renderedLineElements(block: MarkdownBlock): HTMLElement[] {
    const elements = new Set<HTMLElement>();
    for (const lineNumber of measurableLineNumbers(this.view, block)) {
      const element = renderedLineElement(this.view, lineNumber);
      if (element) elements.add(element);
    }
    return [...elements];
  }

  private createDragPreview(block: MarkdownBlock): void {
    this.removeDragPreview();
    const lines = this.renderedLineElements(block);
    if (lines.length === 0) return;

    const editorRect = this.view.dom.getBoundingClientRect();
    const scaleX = this.view.scaleX || 1;
    const scaleY = this.view.scaleY || 1;
    const measurements = lines.map(element => ({ element, rect: element.getBoundingClientRect() }));
    const left = Math.min(...measurements.map(({ rect }) => rect.left));
    const top = Math.min(...measurements.map(({ rect }) => rect.top));
    const right = Math.max(...measurements.map(({ rect }) => rect.right));
    const bottom = Math.max(...measurements.map(({ rect }) => rect.bottom));
    const preview = this.view.dom.ownerDocument.createElement('div');
    preview.className = 'cm-markdown-block-drag-preview';
    preview.setAttribute('aria-hidden', 'true');
    preview.style.left = `${(left - editorRect.left) / scaleX}px`;
    preview.style.top = `${(top - editorRect.top) / scaleY}px`;
    preview.style.width = `${(right - left) / scaleX}px`;
    preview.style.height = `${(bottom - top) / scaleY}px`;

    for (const { element, rect } of measurements) {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.classList.remove(
        'cm-markdown-block-drag-source',
        'cm-markdown-block-drag-source-first',
        'cm-markdown-block-drag-source-last',
        'cm-markdown-block-drop-target',
        'cm-markdown-block-drop-target-first',
        'cm-markdown-block-drop-target-last',
      );
      clone.removeAttribute('contenteditable');
      clone.querySelectorAll<HTMLElement>('[contenteditable]').forEach(node => {
        node.removeAttribute('contenteditable');
      });
      clone.style.position = 'absolute';
      clone.style.left = `${(rect.left - left) / scaleX}px`;
      clone.style.top = `${(rect.top - top) / scaleY}px`;
      clone.style.width = `${rect.width / scaleX}px`;
      clone.style.minHeight = `${rect.height / scaleY}px`;
      clone.style.margin = '0';
      clone.style.maxWidth = 'none';
      clone.style.pointerEvents = 'none';
      preview.appendChild(clone);
    }

    this.view.dom.appendChild(preview);
    this.dragPreview = preview;
  }

  private moveDragPreview(deltaX: number, deltaY: number): void {
    if (!this.dragPreview) return;
    const x = deltaX / (this.view.scaleX || 1);
    const y = deltaY / (this.view.scaleY || 1);
    this.dragPreview.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  private removeDragPreview(): void {
    this.dragPreview?.remove();
    this.dragPreview = null;
  }

  private updateDropTarget(clientY: number): void {
    if (!this.draggedBlock) return;
    const draggedBlock = this.draggedBlock;
    const candidates = this.measuredBlocks.filter(({ block }) => !blockMatches(block, draggedBlock));
    if (candidates.length === 0) return;

    let nextTarget: { block: MarkdownBlock; placement: MarkdownBlockPlacement } = {
      block: candidates[candidates.length - 1].block,
      placement: 'after',
    };
    for (const { block, measurement: { start, end } } of candidates) {
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
    const measurement = this.measuredBlocks.find(({ block }) => blockMatches(block, target))?.measurement;
    if (!measurement) return;
    const { start, end, textBounds } = measurement;
    if (!textBounds) {
      this.dropIndicator.classList.remove('is-visible');
      return;
    }
    const top = (placement === 'before' ? start.top : end.bottom) - editorRect.top;
    const inset = Math.min(DROP_INDICATOR_INSET, (textBounds.right - textBounds.left) / 2);
    const indicatorLeft = textBounds.left + inset;
    const indicatorRight = textBounds.right - inset;
    this.dropIndicator.style.left = `${indicatorLeft - editorRect.left}px`;
    this.dropIndicator.style.top = `${top}px`;
    this.dropIndicator.style.width = `${Math.max(0, indicatorRight - indicatorLeft)}px`;
    this.dropIndicator.classList.add('is-visible');
  }

  private clearDragState(): void {
    this.draggedBlock = null;
    this.dropTarget = null;
    this.dropIndicator.classList.remove('is-visible');
    this.removeDragPreview();
  }
}

export function markdownBlockHandlePlugin(options: MarkdownBlockHandleOptions) {
  return ViewPlugin.define(view => new MarkdownBlockHandleView(view, options));
}
