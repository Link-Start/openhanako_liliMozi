/**
 * PreviewPanel — PreviewItem 预览/编辑面板
 *
 * 从 Zustand store 读取 previewItem 内容池，以及当前 workspace 恢复出的 activeTabId / previewOpen 状态。
 * 可编辑类型（有 filePath 的 markdown/code/csv）使用 CodeMirror 编辑器。
 *
 * 架构原则：
 * - 文件系统是 source of truth，编辑器直接对接文件
 * - PreviewItem content 仅作为前端视图快照，给复制/临时渲染预览使用
 * - 独立窗口由下阶段的 viewer spawn 机制负责（单向只读副本），本面板不做 detach/dock
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from '../stores';
import { selectPreviewItems, selectActiveTabId, selectMarkdownPreviewIds } from '../stores/preview-slice';
import { setMarkdownPreviewActive, upsertPreviewItem } from '../stores/preview-actions';
import { PreviewEditor, type PreviewEditorStats } from './PreviewEditor';
import { PreviewRenderer } from './preview/PreviewRenderer';
import { TabBar } from './preview/TabBar';
import { FloatingActions } from './preview/FloatingActions';
import { clearSelection, getSelectionCommitAnchorRect, scheduleCaptureSelection } from '../stores/selection-actions';
import type { PreviewItem } from '../types';
import { isRemoteWorkbenchContentRef, saveRemoteWorkbenchContent } from '../utils/remote-file-preview';
import { watchFileChanges } from '../services/file-change-events';
import { refreshPreviewItemsFromFile } from '../utils/preview-file-refresh';
import previewStyles from './Preview.module.css';

const EDITABLE_TYPES = new Set(['markdown', 'code', 'csv']);

function isEditable(previewItem: PreviewItem | null): boolean {
  if (!previewItem) return false;
  return EDITABLE_TYPES.has(previewItem.type)
    && (!!previewItem.filePath || isRemoteWorkbenchContentRef(previewItem.remoteContentRef));
}

function isMarkdownFile(previewItem: PreviewItem | null): boolean {
  return !!previewItem
    && previewItem.type === 'markdown'
    && (!!previewItem.filePath || isRemoteWorkbenchContentRef(previewItem.remoteContentRef));
}

function getEditorMode(previewItem: PreviewItem): 'markdown' | 'code' | 'csv' | 'text' {
  if (previewItem.type === 'markdown') return 'markdown';
  if (previewItem.type === 'csv') return 'csv';
  return 'code';
}

function countPreviewChars(text: string): number {
  return Array.from(text).length;
}

function formatMarkdownEditorStatus(stats: PreviewEditorStats): string {
  const fallback = `选中 ${stats.selectedChars} 字 · 共 ${stats.totalChars} 字`;
  const translated = window.t?.('preview.markdownEditorStatus', {
    selected: stats.selectedChars,
    total: stats.totalChars,
  });
  return translated && translated !== 'preview.markdownEditorStatus' ? translated : fallback;
}

function watchedPreviewFilePaths(previewItems: PreviewItem[], openTabs: string[]): string[] {
  const itemsById = new Map(previewItems.map(item => [item.id, item]));
  const paths = new Set<string>();
  for (const id of openTabs) {
    const item = itemsById.get(id);
    if (!item?.filePath) continue;
    if (item.storageKind === 'remote-content' || item.remoteContentRef) continue;
    paths.add(item.filePath);
  }
  return [...paths].sort();
}

function PreviewFileWatchBridge({ previewItems, openTabs }: { previewItems: PreviewItem[]; openTabs: string[] }) {
  const paths = useMemo(
    () => watchedPreviewFilePaths(previewItems, openTabs),
    [previewItems, openTabs],
  );
  const subscriptionsRef = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    const nextPaths = new Set(paths);
    for (const [filePath, unsubscribe] of subscriptionsRef.current) {
      if (nextPaths.has(filePath)) continue;
      unsubscribe();
      subscriptionsRef.current.delete(filePath);
    }

    for (const filePath of paths) {
      if (subscriptionsRef.current.has(filePath)) continue;
      const unsubscribe = watchFileChanges(filePath, (changedPath) => {
        void refreshPreviewItemsFromFile(changedPath);
      });
      subscriptionsRef.current.set(filePath, unsubscribe);
    }
  }, [paths]);

  useEffect(() => () => {
    for (const unsubscribe of subscriptionsRef.current.values()) unsubscribe();
    subscriptionsRef.current.clear();
  }, []);

  return null;
}

export function PreviewPanel() {
  const previewOpen = useStore(s => s.previewOpen);
  const activeTabId = useStore(selectActiveTabId);
  const previewItems = useStore(selectPreviewItems);
  const openTabs = useStore(s => s.openTabs);
  const markdownPreviewIds = useStore(selectMarkdownPreviewIds);
  const [editorStats, setEditorStats] = useState<PreviewEditorStats>({ selectedChars: 0, totalChars: 0 });

  const previewItem = previewItems.find(a => a.id === activeTabId) ?? null;
  const markdownPreviewActive = !!previewItem && markdownPreviewIds.includes(previewItem.id);
  const editable = isEditable(previewItem) && !markdownPreviewActive;
  const showMarkdownEditorStatus = editable && previewItem?.type === 'markdown';
  const saveDocument = useMemo(() => {
    const remoteRef = previewItem?.remoteContentRef;
    if (!isRemoteWorkbenchContentRef(remoteRef)) return undefined;
    return (content: string, expectedVersion?: PreviewItem['fileVersion']) =>
      saveRemoteWorkbenchContent(remoteRef, content, expectedVersion ?? null);
  }, [previewItem?.remoteContentRef]);

  const handleToggleMarkdownPreview = useCallback(() => {
    if (!previewItem || !isMarkdownFile(previewItem)) return;
    setMarkdownPreviewActive(previewItem.id, !markdownPreviewActive);
  }, [previewItem, markdownPreviewActive]);

  const handleEditorContentChange = useCallback((content: string, fileVersion?: PreviewItem['fileVersion']) => {
    if (!previewItem) return;
    upsertPreviewItem({
      ...previewItem,
      content,
      fileVersion: fileVersion === undefined ? previewItem.fileVersion : fileVersion,
    });
  }, [previewItem]);

  const handleEditorStatsChange = useCallback((stats: PreviewEditorStats) => {
    setEditorStats(stats);
  }, []);

  // DOM 模式选区捕获（非编辑模式下 mouseup 时检测选中文本）
  const handleMouseUp = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!previewItem || editable) return;
    scheduleCaptureSelection(previewItem, undefined, getSelectionCommitAnchorRect(event.nativeEvent));
  }, [previewItem, editable]);

  // 切换 tab 时清除选区
  useEffect(() => {
    clearSelection({ sourceKind: 'preview' });
    setEditorStats({
      selectedChars: 0,
      totalChars: previewItem?.type === 'markdown' ? countPreviewChars(previewItem.content) : 0,
    });
  }, [activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps -- tab 切换时用当前 active previewItem 初始化状态栏，后续由 PreviewEditor 回调接管

  return (
    <div
      className={`${previewStyles.previewPanel}${previewOpen ? '' : ` ${previewStyles.previewPanelCollapsed}`}`}
      id="previewPanel"
      data-preview-open={previewOpen ? 'true' : 'false'}
    >
      <PreviewFileWatchBridge previewItems={previewItems} openTabs={openTabs} />
      <div className="resize-handle resize-handle-left" id="previewResizeHandle"></div>
      <div className={previewStyles.previewPanelInner} data-preview-panel-inner="">
        <TabBar />
        <div className={previewStyles.previewBodyShell} data-preview-body-shell="">
          {previewOpen && previewItem && (
            <FloatingActions
              content={previewItem.content}
              filePath={previewItem.filePath}
              remoteContentRef={previewItem.remoteContentRef}
              contentType={previewItem.type}
              language={previewItem.language}
              showMarkdownPreviewToggle={isMarkdownFile(previewItem)}
              markdownPreviewActive={markdownPreviewActive}
              onToggleMarkdownPreview={handleToggleMarkdownPreview}
            />
          )}
          <div className={`jian-card ${previewStyles.previewPanelBody}`} id="previewBody" data-preview-panel-body="" onMouseUp={handleMouseUp}>
            {previewOpen && previewItem && !editable && (
              <PreviewRenderer previewItem={previewItem} />
            )}
            {previewOpen && previewItem && editable && (
              <PreviewEditor
                content={previewItem.content}
                filePath={previewItem.filePath}
                remoteContentRef={previewItem.remoteContentRef}
                fileVersion={previewItem.fileVersion ?? previewItem.remoteContentRef?.version ?? null}
                saveDocument={saveDocument}
                mode={getEditorMode(previewItem)}
                language={previewItem.language}
                onSelectionCommit={(view) => {
                  if (previewItem) scheduleCaptureSelection(previewItem, view);
                }}
                onStatsChange={handleEditorStatsChange}
                onContentChange={handleEditorContentChange}
              />
            )}
            {previewOpen && previewItem && showMarkdownEditorStatus && (
              <div
                className={previewStyles.markdownEditorStatus}
                data-testid="markdown-editor-status"
                aria-live="polite"
              >
                {formatMarkdownEditorStatus(editorStats)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
