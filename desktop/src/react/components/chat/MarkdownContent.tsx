/**
 * MarkdownContent — 渲染预处理好的 markdown HTML
 *
 * 用 dangerouslySetInnerHTML 设置内容，
 * useEffect 注入代码块复制按钮。
 */

import { memo, useCallback, useRef, useEffect, useLayoutEffect, useState, type MouseEvent } from 'react';
import { injectCopyButtons } from '../../utils/format';
import { useMermaidDiagrams } from '../../hooks/use-mermaid-diagrams';
import { splitGraphemes } from '../../utils/grapheme';
import { openInternalLink, resolveLinkTarget, type LinkOpenContext } from '../../utils/link-open';
import { LinkContextMenu, type LinkContextMenuState } from '../shared/LinkContextMenu';
import styles from './Chat.module.css';

interface Props {
  html: string;
  className?: string;
  tailFadeCount?: number;
  linkContext?: LinkOpenContext;
}

function shouldSkipTailFadeNode(node: Text): boolean {
  const parent = node.parentElement;
  return !parent || !!parent.closest('pre, code, table, .katex, .mermaid, svg, button');
}

function clearTailFade(root: HTMLElement): void {
  const tailSpans = Array.from(root.querySelectorAll<HTMLElement>(
    '[data-stream-tail-char="true"], [data-stream-tail-chunk="true"]'
  ));
  for (const span of tailSpans) {
    span.replaceWith(document.createTextNode(span.textContent || ''));
  }
  if (tailSpans.length > 0) root.normalize();
}

function applyTailFade(root: HTMLElement, count: number): void {
  clearTailFade(root);
  if (count <= 0) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    if (text.nodeValue && text.nodeValue.trim() && !shouldSkipTailFadeNode(text)) {
      textNodes.push(text);
    }
    current = walker.nextNode();
  }

  const tailNodes: Array<{ node: Text; segments: string[]; take: number }> = [];
  let remaining = count;
  for (let i = textNodes.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const node = textNodes[i];
    const segments = splitGraphemes(node.nodeValue || '');
    if (segments.length === 0) continue;
    const take = Math.min(remaining, segments.length);
    tailNodes.push({ node, segments, take });
    remaining -= take;
  }

  for (const item of tailNodes.reverse()) {
    const splitAt = item.segments.length - item.take;
    const before = item.segments.slice(0, splitAt).join('');
    const tail = item.segments.slice(splitAt).join('');
    const fragment = document.createDocumentFragment();
    if (before) fragment.appendChild(document.createTextNode(before));
    if (tail) {
      // eslint-disable-next-line no-restricted-syntax -- post-render markdown stream tail decoration needs DOM text-node surgery
      const span = document.createElement('span');
      span.className = styles.streamTailChunk;
      span.dataset.streamTailChunk = 'true';
      span.textContent = tail;
      fragment.appendChild(span);
    }
    item.node.parentNode?.replaceChild(fragment, item.node);
  }
}

export const MarkdownContent = memo(function MarkdownContent({ html, className, tailFadeCount = 0, linkContext }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [linkMenu, setLinkMenu] = useState<LinkContextMenuState | null>(null);
  const classes = className ? `md-content ${className}` : 'md-content';

  const findAnchor = useCallback((event: MouseEvent): HTMLAnchorElement | null => {
    const root = ref.current;
    const target = event.target;
    if (!root || !(target instanceof Element)) return null;
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor || !root.contains(anchor)) return null;
    return anchor;
  }, []);

  const handleClick = useCallback((event: MouseEvent) => {
    const anchor = findAnchor(event);
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    const context = {
      ...linkContext,
      label: anchor.textContent?.trim() || linkContext?.label,
    };
    if (resolveLinkTarget(href, context).kind === 'anchor') return;
    event.preventDefault();
    event.stopPropagation();
    void openInternalLink(href, context);
  }, [findAnchor, linkContext]);

  const handleContextMenu = useCallback((event: MouseEvent) => {
    const anchor = findAnchor(event);
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    setLinkMenu({
      href: anchor.getAttribute('href') || '',
      context: {
        ...linkContext,
        label: anchor.textContent?.trim() || linkContext?.label,
      },
      position: { x: event.clientX, y: event.clientY },
    });
  }, [findAnchor, linkContext]);

  useLayoutEffect(() => {
    if (!ref.current) return;
    applyTailFade(ref.current, tailFadeCount);
  }, [html, tailFadeCount]);

  useEffect(() => {
    if (!ref.current) return;
    injectCopyButtons(ref.current);
  }, [html]);
  useMermaidDiagrams(ref, [html]);

  return (
    <>
      <div
        ref={ref}
        className={classes}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {linkMenu && (
        <LinkContextMenu
          state={linkMenu}
          onClose={() => setLinkMenu(null)}
        />
      )}
    </>
  );
});
