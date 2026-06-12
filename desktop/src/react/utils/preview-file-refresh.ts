import { useStore } from '../stores';
import { upsertPreviewItem } from '../stores/preview-actions';
import type { PreviewItem } from '../types';
import { readFileForPreviewType } from './preview-file-content';

const refreshGenerations = new Map<string, number>();

function beginRefresh(filePath: string): number {
  const next = (refreshGenerations.get(filePath) ?? 0) + 1;
  refreshGenerations.set(filePath, next);
  return next;
}

function isLatestRefresh(filePath: string, generation: number): boolean {
  return refreshGenerations.get(filePath) === generation;
}

function showMissingFileNotice(item: PreviewItem, filePath: string): void {
  if (typeof window === 'undefined') return;
  const fallback = `File is no longer available: ${item.title || filePath}`;
  const translated = window.t?.('preview.fileMissing', { title: item.title || filePath });
  const text = translated && translated !== 'preview.fileMissing' ? translated : fallback;
  window.dispatchEvent(new CustomEvent('hana-inline-notice', {
    detail: { text, type: 'error' },
  }));
}

export function __resetPreviewFileRefreshStateForTests(): void {
  refreshGenerations.clear();
}

export async function refreshPreviewItemsFromFile(filePath: string): Promise<void> {
  const generation = beginRefresh(filePath);
  const state = useStore.getState();
  for (const item of state.previewItems || []) {
    if (item.filePath !== filePath) continue;
    const read = await readFileForPreviewType(filePath, item.type);
    if (!isLatestRefresh(filePath, generation)) return;
    if (!read) {
      showMissingFileNotice(item, filePath);
      upsertPreviewItem({
        ...item,
        status: 'missing',
        missingAt: Date.now(),
      });
      continue;
    }
    upsertPreviewItem({
      ...item,
      content: read.content,
      sourceUrl: read.sourceUrl ?? item.sourceUrl,
      fileVersion: read.fileVersion ?? item.fileVersion,
      status: 'available',
      missingAt: null,
    });
  }
}
