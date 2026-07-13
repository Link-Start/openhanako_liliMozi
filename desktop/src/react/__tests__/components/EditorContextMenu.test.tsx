/**
 * @vitest-environment jsdom
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorContextMenu } from '../../components/preview/EditorContextMenu';
import { collectMarkdownBlocks } from '../../editor/markdown-blocks';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function renderBlockMenu(doc: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView({
    parent: container,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
    }),
  });
  const target = collectMarkdownBlocks(view.state)[0];
  const onBlockMenuClose = vi.fn();

  render(
    <EditorContextMenu
      getView={() => view}
      containerRef={{ current: container }}
      mode="markdown"
      blockMenuRequest={{ id: 1, position: { x: 20, y: 20 }, target }}
      onBlockMenuClose={onBlockMenuClose}
    />,
  );
  return { view, onBlockMenuClose };
}

describe('EditorContextMenu block target', () => {
  it('reuses the format menu while hiding selection-only inline actions', async () => {
    const { view, onBlockMenuClose } = renderBlockMenu('Paragraph');

    expect(await screen.findByTitle('标题 1')).toBeTruthy();
    expect(screen.queryByTitle('粗体')).toBeNull();
    fireEvent.click(screen.getByTitle('标题 1'));

    expect(view.state.doc.toString()).toBe('# Paragraph');
    expect(onBlockMenuClose).toHaveBeenCalled();
    view.destroy();
  });

  it('applies multi-line block commands to the complete parser block', async () => {
    const { view } = renderBlockMenu('line one\nline two');

    fireEvent.click(await screen.findByTitle('引用'));

    expect(view.state.doc.toString()).toBe('> line one\n> line two');
    view.destroy();
  });
});
