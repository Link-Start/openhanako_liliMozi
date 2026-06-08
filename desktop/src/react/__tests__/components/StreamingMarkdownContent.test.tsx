// @vitest-environment jsdom

import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingMarkdownContent } from '../../components/chat/StreamingMarkdownContent';

describe('StreamingMarkdownContent', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame');
    vi.spyOn(window, 'cancelAnimationFrame');
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders active prose through markdown html instead of a plain-text fallback', () => {
    const { container, rerender } = render(
      <StreamingMarkdownContent source="旧正文" html="<p>旧正文</p>" active />,
    );

    expect(container.textContent?.trim()).toBe('旧正文');
    const root = container.querySelector('.md-content');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('data-stream-plain-text')).toBeNull();
    expect(root?.querySelector('p')?.textContent).toBe('旧正文');
    expect(root?.querySelector('[data-stream-tail-chunk="true"]')).toBeNull();

    rerender(
      <StreamingMarkdownContent source="旧正文新正文继续出现" html="<p>旧正文新正文继续出现</p>" active />,
    );

    expect(container.querySelector('.md-content')).toBe(root);
    expect(container.querySelector('p')?.textContent).toBe('旧正文新正文继续出现');
    expect(container.querySelector('[data-stream-tail-chunk="true"]')).toBeNull();
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('matches final markdown paragraph structure while prose is streaming', () => {
    const source = '第一段。\n\n第二段。';
    const html = '<p>第一段。</p>\n<p>第二段。</p>';

    const { container } = render(
      <StreamingMarkdownContent source={source} html={html} active />,
    );

    const paragraphs = Array.from(container.querySelectorAll('.md-content > p'));
    expect(paragraphs.map(p => p.textContent)).toEqual(['第一段。', '第二段。']);
  });

  it('updates prose immediately through the upstream 30Hz flush instead of local text animation debt', () => {
    const { container, rerender } = render(
      <StreamingMarkdownContent source="你好" html="<p>你好</p>" active />,
    );

    rerender(
      <StreamingMarkdownContent source="你好世界" html="<p>你好世界</p>" active />,
    );

    expect(container.textContent?.trim()).toBe('你好世界');
  });

  it('hard-catches up 80-character prose backlogs without waiting for animation debt', () => {
    const source = '开头';
    const largeTarget = `${source}${'一'.repeat(80)}`;
    const { container, rerender } = render(
      <StreamingMarkdownContent source={source} html={`<p>${source}</p>`} active />,
    );

    rerender(
      <StreamingMarkdownContent source={largeTarget} html={`<p>${largeTarget}</p>`} active />,
    );

    expect(container.textContent?.trim()).toBe(largeTarget);
    expect(container.querySelector('[data-stream-plain-text="true"]')).toBeNull();
  });

  it('renders final prose with markdown html when streaming is complete', () => {
    const { container } = render(
      <StreamingMarkdownContent source="完成正文" html="<p>完成正文</p>" active={false} />,
    );

    expect(container.querySelector('.md-content')?.getAttribute('data-stream-plain-text')).toBeNull();
    expect(container.querySelector('p')?.textContent).toBe('完成正文');
  });

  it('does not typewriter complex markdown blocks', () => {
    const source = '```ts\nconst x = 1;\n```';
    const html = '<pre><code>const x = 1;</code></pre>';

    const { container } = render(
      <StreamingMarkdownContent source={source} html={html} active />,
    );

    expect(container.textContent).toContain('const x = 1;');
    expect(container.querySelector('[data-stream-tail-chunk="true"]')).toBeNull();
    expect(container.querySelector('[class*="streamMarkdownBlockEnter"]')).not.toBeNull();
  });

  it('keeps complex markdown mounted while streaming updates arrive', () => {
    const source = '```ts\nconst x = 1;\n```';
    const html = '<pre><code>const x = 1;</code></pre>';
    const { container, rerender } = render(
      <StreamingMarkdownContent source={source} html={html} active />,
    );
    const root = container.querySelector('.md-content');

    rerender(
      <StreamingMarkdownContent
        source={`${source}\n\n后续说明`}
        html="<pre><code>const x = 1;</code></pre><p>后续说明</p>"
        active
      />,
    );

    expect(container.querySelector('.md-content')).toBe(root);
    expect(container.textContent).toContain('后续说明');
  });

  it('does not typewriter backtick-sensitive inline markdown while streaming', () => {
    const source = '这里有 `inline code`，后续文字也要稳定显示。';
    const html = '<p>这里有 <code>inline code</code>，后续文字也要稳定显示。</p>';

    const { container } = render(
      <StreamingMarkdownContent source={source} html={html} active />,
    );

    expect(container.textContent).toContain('后续文字也要稳定显示。');
    expect(container.querySelector('[data-stream-tail-chunk="true"]')).toBeNull();
    expect(container.querySelector('[class*="streamMarkdownBlockEnter"]')).not.toBeNull();
  });

  it('keeps common markdown formatting rendered while streaming', () => {
    const source = [
      '## 小标题',
      '',
      '- 第一项',
      '- **重点项**',
      '',
      '> 引用',
      '',
      '[链接](https://example.com)',
    ].join('\n');
    const html = [
      '<h2>小标题</h2>',
      '<ul><li>第一项</li><li><strong>重点项</strong></li></ul>',
      '<blockquote><p>引用</p></blockquote>',
      '<p><a href="https://example.com">链接</a></p>',
    ].join('');

    const { container } = render(
      <StreamingMarkdownContent source={source} html={html} active />,
    );

    expect(container.querySelector('[data-stream-plain-text="true"]')).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('小标题');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('strong')?.textContent).toBe('重点项');
    expect(container.querySelector('blockquote')?.textContent).toContain('引用');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });

  it('does not fall back to plain text when rendered html contains formatting', () => {
    const source = '重点';
    const html = '<p><strong>重点</strong></p>';

    const { container } = render(
      <StreamingMarkdownContent source={source} html={html} active />,
    );

    expect(container.querySelector('[data-stream-plain-text="true"]')).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('重点');
  });

  it('uses identical markdown html structure while streaming and after completion', () => {
    const source = [
      '## 小标题',
      '',
      '第一段 **重点**。',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '> 引用',
    ].join('\n');
    const html = [
      '<h2>小标题</h2>',
      '<p>第一段 <strong>重点</strong>。</p>',
      '<ul><li>第一项</li><li>第二项</li></ul>',
      '<blockquote><p>引用</p></blockquote>',
    ].join('');

    const activeRender = render(
      <StreamingMarkdownContent source={source} html={html} active />,
    );
    const activeRoot = activeRender.container.querySelector('.md-content');
    expect(activeRoot?.getAttribute('data-stream-plain-text')).toBeNull();
    const activeInnerHtml = activeRoot?.innerHTML;
    activeRender.unmount();

    const finalRender = render(
      <StreamingMarkdownContent source={source} html={html} active={false} />,
    );
    const finalRoot = finalRender.container.querySelector('.md-content');

    expect(finalRoot?.getAttribute('data-stream-plain-text')).toBeNull();
    expect(activeInnerHtml).toBe(finalRoot?.innerHTML);
  });

  it('keeps stream motion off React animation frames and limits CSS to opacity or tiny transforms', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
    const animations = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/animations.css'),
      'utf8',
    );
    const tailBlock = css.match(/\.streamTailChunk\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const cardBlock = css.match(/\.mediaGenerationCard\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const toolBlock = Array.from(css.matchAll(/\.toolGroup::before\s*\{(?<body>[^}]*)\}/g))
      .map(match => match.groups?.body || '')
      .find(body => body.includes('hana-tool-bar-in')) || '';

    expect(tailBlock).toContain('hana-stream-tail-in');
    expect(tailBlock).not.toContain('requestAnimationFrame');
    expect(cardBlock).toContain('hana-chat-soft-up-in');
    expect(toolBlock).toContain('hana-tool-bar-in');
    expect(animations).toContain('@keyframes hana-stream-tail-in');
    expect(animations).toContain('@keyframes hana-chat-soft-down-in');
    expect(animations).toContain('@keyframes hana-chat-soft-up-in');
    expect(animations).toContain('@keyframes hana-tool-bar-in');
  });
});
