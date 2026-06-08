/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PreviewPanel } from '../../components/PreviewPanel';
import { useStore, type StoreState } from '../../stores';
import type { PlatformApi } from '../../types';

describe('PreviewPanel markdown editor status', () => {
  let fileChangedHandler: ((filePath: string) => void) | null;

  beforeEach(() => {
    fileChangedHandler = null;
    window.t = ((key: string) => key) as typeof window.t;
    Range.prototype.getClientRects = vi.fn(() => [] as unknown as DOMRectList);
    Range.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    }));
    window.platform = {
      watchFile: vi.fn(async () => true),
      unwatchFile: vi.fn(async () => true),
      onFileChanged: vi.fn((handler: (filePath: string) => void) => {
        fileChangedHandler = handler;
      }),
      readFileSnapshot: vi.fn(async (filePath: string) => ({
        content: filePath.endsWith('inactive.ts') ? 'export const value = 2;\n' : '外部更新',
        version: { mtimeMs: 20, size: 23, sha256: 'fresh' },
      })),
      writeFile: vi.fn(async () => true),
      writeFileIfUnchanged: vi.fn(async () => ({
        ok: true,
        conflict: false,
        version: { mtimeMs: 2, size: 10, sha256: 'next' },
      })),
    } as unknown as PlatformApi;
    useStore.setState({
      previewOpen: true,
      previewItems: [{
        id: 'note',
        type: 'markdown',
        title: 'note.md',
        content: '你好ab',
        filePath: '/tmp/hana-note.md',
      }],
      openTabs: ['note'],
      activeTabId: 'note',
      markdownPreviewIds: [],
      quoteCandidate: null,
      quotedSelections: [],
      quotedSelection: null,
    } as Partial<StoreState>);
  });

  afterEach(() => {
    cleanup();
    useStore.setState({
      previewOpen: false,
      previewItems: [],
      openTabs: [],
      activeTabId: null,
      markdownPreviewIds: [],
      quoteCandidate: null,
      quotedSelections: [],
      quotedSelection: null,
    } as Partial<StoreState>);
  });

  it('shows selected and total character counts for editable markdown', () => {
    render(<PreviewPanel />);

    expect(screen.getByTestId('markdown-editor-status')).toHaveTextContent('选中 0 字 · 共 4 字');
  });

  it('uses the shared panel spacing and card chrome for the preview editor card', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/Preview.module.css'),
      'utf8',
    );
    const shellBlock = css.match(/\.previewBodyShell\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const bodyBlock = css.match(/\.previewPanelBody\s*\{[\s\S]*?\}/)?.[0] ?? '';

    render(<PreviewPanel />);

    expect(document.getElementById('previewBody')).toHaveClass('jian-card');
    expect(shellBlock).toMatch(/margin:\s*var\(--panel-edge-gap\);/);
    expect(bodyBlock).toMatch(/background:\s*var\(--panel-card-bg\);/);
    expect(bodyBlock).toMatch(/border-radius:\s*var\(--panel-card-radius\);/);
    expect(bodyBlock).toMatch(/border:\s*var\(--panel-card-border\);/);
    expect(bodyBlock).toMatch(/box-shadow:\s*var\(--panel-card-shadow\);/);
  });

  it('treats remote workbench markdown files as editable', () => {
    useStore.setState({
      previewItems: [{
        id: 'remote-note',
        type: 'markdown',
        title: 'remote.md',
        content: '远程ab',
        ext: 'md',
        storageKind: 'remote-content',
        remoteContentRef: {
          kind: 'mobile-workbench',
          rootId: 'default',
          subdir: '',
          name: 'remote.md',
          contentPath: '/api/mobile/workbench/content?rootId=default&subdir=&name=remote.md',
          version: { mtimeMs: 10, size: 8 },
        },
      }],
      openTabs: ['remote-note'],
      activeTabId: 'remote-note',
      markdownPreviewIds: [],
    } as Partial<StoreState>);

    render(<PreviewPanel />);

    expect(screen.getByTestId('markdown-editor-status')).toHaveTextContent('选中 0 字 · 共 4 字');
  });

  it('refreshes an inactive open preview tab when its backing file changes', async () => {
    useStore.setState({
      previewOpen: true,
      previewItems: [
        {
          id: 'note',
          type: 'markdown',
          title: 'note.md',
          content: '你好ab',
          filePath: '/tmp/hana-note.md',
        },
        {
          id: 'inactive',
          type: 'code',
          title: 'inactive.ts',
          content: 'export const value = 1;\n',
          filePath: '/tmp/inactive.ts',
          ext: 'ts',
          language: 'ts',
        },
      ],
      openTabs: ['note', 'inactive'],
      activeTabId: 'note',
      markdownPreviewIds: [],
    } as Partial<StoreState>);

    render(<PreviewPanel />);

    fileChangedHandler?.('/tmp/inactive.ts');

    await waitFor(() => {
      const inactive = useStore.getState().previewItems.find(item => item.id === 'inactive');
      expect(inactive?.content).toBe('export const value = 2;\n');
      expect(inactive?.fileVersion).toEqual({ mtimeMs: 20, size: 23, sha256: 'fresh' });
    });
  });

  it('keeps retained file watches alive when the open tab set changes', async () => {
    useStore.setState({
      previewOpen: true,
      previewItems: [
        {
          id: 'note',
          type: 'markdown',
          title: 'note.md',
          content: '你好ab',
          filePath: '/tmp/hana-note.md',
        },
        {
          id: 'inactive',
          type: 'code',
          title: 'inactive.ts',
          content: 'export const value = 1;\n',
          filePath: '/tmp/inactive.ts',
          ext: 'ts',
          language: 'ts',
        },
        {
          id: 'extra',
          type: 'markdown',
          title: 'extra.md',
          content: 'extra',
          filePath: '/tmp/extra.md',
        },
      ],
      openTabs: ['note', 'inactive'],
      activeTabId: 'note',
      markdownPreviewIds: [],
    } as Partial<StoreState>);

    render(<PreviewPanel />);

    await waitFor(() => {
      expect(window.platform?.watchFile).toHaveBeenCalledWith('/tmp/hana-note.md');
      expect(window.platform?.watchFile).toHaveBeenCalledWith('/tmp/inactive.ts');
    });

    vi.mocked(window.platform!.unwatchFile!).mockClear();

    useStore.setState({ openTabs: ['note', 'inactive', 'extra'] } as Partial<StoreState>);

    await waitFor(() => {
      expect(window.platform?.watchFile).toHaveBeenCalledWith('/tmp/extra.md');
    });
    expect(window.platform?.unwatchFile).not.toHaveBeenCalledWith('/tmp/hana-note.md');
    expect(window.platform?.unwatchFile).not.toHaveBeenCalledWith('/tmp/inactive.ts');

    useStore.setState({ openTabs: ['note', 'extra'] } as Partial<StoreState>);

    await waitFor(() => {
      expect(window.platform?.unwatchFile).toHaveBeenCalledWith('/tmp/inactive.ts');
    });
    expect(window.platform?.unwatchFile).not.toHaveBeenCalledWith('/tmp/hana-note.md');
    expect(window.platform?.unwatchFile).not.toHaveBeenCalledWith('/tmp/extra.md');
  });
});
