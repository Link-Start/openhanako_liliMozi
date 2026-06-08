/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toSlash, baseName, parseCSV, isImageFile, parseMoodFromContent, injectCopyButtons } from '../../utils/format';

describe('toSlash', () => {
  it('反斜杠转正斜杠', () => {
    expect(toSlash('C:\\Users\\test\\file.txt')).toBe('C:/Users/test/file.txt');
  });

  it('已是正斜杠不变', () => {
    expect(toSlash('/usr/local/bin')).toBe('/usr/local/bin');
  });

  it('空字符串返回空', () => {
    expect(toSlash('')).toBe('');
  });
});

describe('baseName', () => {
  it('提取文件名（正斜杠）', () => {
    expect(baseName('/path/to/file.txt')).toBe('file.txt');
  });

  it('提取文件名（反斜杠）', () => {
    expect(baseName('C:\\path\\to\\file.txt')).toBe('file.txt');
  });

  it('无路径分隔符返回原文', () => {
    expect(baseName('file.txt')).toBe('file.txt');
  });
});

describe('parseCSV', () => {
  it('解析简单 CSV', () => {
    const result = parseCSV('a,b,c\n1,2,3');
    expect(result).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('处理带引号的字段', () => {
    const result = parseCSV('"hello, world",b\n1,2');
    expect(result[0][0]).toBe('hello, world');
  });

  it('处理引号内的转义引号', () => {
    const result = parseCSV('"say ""hi""",b');
    expect(result[0][0]).toBe('say "hi"');
  });

  it('空输入返回空数组', () => {
    expect(parseCSV('')).toEqual([]);
  });

  it('跳过空行', () => {
    const result = parseCSV('a,b\n\nc,d');
    expect(result).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('isImageFile', () => {
  it('常见图片格式返回 true', () => {
    expect(isImageFile('photo.png')).toBe(true);
    expect(isImageFile('photo.jpg')).toBe(true);
    expect(isImageFile('photo.jpeg')).toBe(true);
    expect(isImageFile('photo.gif')).toBe(true);
    expect(isImageFile('photo.webp')).toBe(true);
    expect(isImageFile('photo.svg')).toBe(true);
  });

  it('非图片格式返回 false', () => {
    expect(isImageFile('doc.pdf')).toBe(false);
    expect(isImageFile('code.ts')).toBe(false);
    expect(isImageFile('data.json')).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(isImageFile('PHOTO.PNG')).toBe(true);
    expect(isImageFile('Photo.Jpg')).toBe(true);
  });
});

describe('parseMoodFromContent (format.ts)', () => {
  it('解析 mood 标签', () => {
    const result = parseMoodFromContent('<mood>content</mood>\nText.');
    expect(result.mood).toBe('content');
    expect(result.text).toBe('Text.');
  });

  it('无 mood 标签', () => {
    const result = parseMoodFromContent('plain text');
    expect(result.mood).toBeNull();
    expect(result.text).toBe('plain text');
  });
});

describe('injectCopyButtons', () => {
  beforeEach(() => {
    window.t = ((key: string) => {
      if (key === 'attach.copy') return '复制';
      if (key === 'attach.copied') return '已复制';
      return key;
    }) as typeof window.t;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  it('pre 被 .code-block-wrap 包裹，按钮是 wrapper 的直接子元素而非 pre 的子元素', () => {
    const container = document.createElement('div');
    container.innerHTML = '<pre><code>const x = 1;</code></pre>';

    injectCopyButtons(container);

    const wrapper = container.querySelector<HTMLDivElement>('.code-block-wrap');
    expect(wrapper).toBeInstanceOf(HTMLDivElement);

    const pre = wrapper?.querySelector('pre');
    expect(pre).toBeInstanceOf(HTMLPreElement);

    // 按钮是 wrapper 的直接子，不是 pre 的子
    const btn = wrapper?.querySelector(':scope > .copy-btn');
    expect(btn).toBeInstanceOf(HTMLButtonElement);
    expect(pre?.querySelector('.copy-btn')).toBeNull();
  });

  it('adds an icon-only copy button and shows copied state after click', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement('div');
    container.innerHTML = '<pre><code>const x = 1;</code></pre>';

    injectCopyButtons(container);

    const button = container.querySelector<HTMLButtonElement>('.copy-btn');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button?.querySelector('svg.copy-btn-icon')).toBeInstanceOf(SVGSVGElement);
    expect(button?.textContent).toBe('');
    expect(button?.dataset.copied).toBe('false');
    expect(button?.dataset.copiedLabel).toBe('已复制');
    expect(button?.getAttribute('aria-label')).toBe('复制');

    button?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('const x = 1;');
    expect(button?.dataset.copied).toBe('true');
    expect(button?.getAttribute('aria-label')).toBe('已复制');
  });

  it('.mermaid-source 的 pre 不被包裹、不加按钮', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <div class="mermaid-diagram">
        <pre class="mermaid-source"><code>graph TD; A-->B</code></pre>
        <div class="mermaid-rendered"></div>
      </div>
    `;

    injectCopyButtons(container);

    // mermaid pre 不应被 wrapper 包裹
    const mermaidPre = container.querySelector('pre.mermaid-source');
    expect(mermaidPre?.parentElement?.classList.contains('code-block-wrap')).toBe(false);
    // mermaid pre 内不应有复制按钮
    expect(mermaidPre?.querySelector('.copy-btn')).toBeNull();
    // wrapper 也不应存在
    expect(container.querySelector('.code-block-wrap')).toBeNull();
  });

  it('重复调用不重复套 wrapper、不重复加按钮', () => {
    const container = document.createElement('div');
    container.innerHTML = '<pre><code>hello</code></pre>';

    injectCopyButtons(container);
    injectCopyButtons(container);

    expect(container.querySelectorAll('.code-block-wrap').length).toBe(1);
    expect(container.querySelectorAll('.copy-btn').length).toBe(1);
  });

  it('混合场景：普通代码块被套 wrapper，mermaid 不动', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <pre><code>normal code</code></pre>
      <div class="mermaid-diagram">
        <pre class="mermaid-source"><code>graph TD; A-->B</code></pre>
        <div class="mermaid-rendered"></div>
      </div>
    `;

    injectCopyButtons(container);

    expect(container.querySelectorAll('.code-block-wrap').length).toBe(1);
    expect(container.querySelectorAll('.copy-btn').length).toBe(1);
    expect(container.querySelector('pre.mermaid-source')?.parentElement?.classList.contains('code-block-wrap')).toBe(false);
  });
});
