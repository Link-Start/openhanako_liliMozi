import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readChatCss(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
    'utf8',
  );
}

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

function selectorsWithPointerAuto(css: string): string[] {
  const selectors: string[] = [];
  const rulePattern = /(?<selector>[^{}]+)\{(?<body>[^{}]+)\}/g;
  for (const match of css.matchAll(rulePattern)) {
    const body = match.groups?.body || '';
    if (/pointer-events:\s*auto/.test(body)) {
      selectors.push(match.groups?.selector.trim() || '');
    }
  }
  return selectors;
}

describe('ChatTimelineNavigator layout', () => {
  it('does not let the hover rail or expanded card steal clicks from chat content', () => {
    const css = readChatCss();
    const navBlock = cssBlock(css, '.timelineNav');
    const pointerAutoSelectors = selectorsWithPointerAuto(css);

    expect(navBlock).toMatch(/pointer-events:\s*none/);
    expect(pointerAutoSelectors.some(selector => selector.includes('.timelineNavExpanded .timelineCard'))).toBe(false);
    expect(pointerAutoSelectors.some(selector => selector.includes('.timelineNavExpanded .timelineMarker'))).toBe(false);
    expect(pointerAutoSelectors.some(selector => selector.includes('.timelineNavExpanded .timelineLabel'))).toBe(true);
    expect(pointerAutoSelectors.some(selector => selector.includes('.timelineLine'))).toBe(true);
  });
});
