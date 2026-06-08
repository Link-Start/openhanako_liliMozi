/**
 * stream-resume.ts — 流恢复逻辑（从 app-ws-shim.ts 迁移）
 *
 * 管理 per-session 流元数据、断线重连后的 stream resume 请求和事件重放。
 * 不依赖 ctx 注入，通过 Zustand store 访问状态。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- WS 消息协议为动态 JSON，类型无法静态收窄 */

import { streamBufferManager } from '../hooks/use-stream-buffer';
import { useStore } from '../stores';
import { getWebSocket } from './websocket';
import { clearChat } from '../stores/agent-actions';
import { loadMessages } from '../stores/session-actions';
import { registerStreamResumeMetaInvalidator } from '../stores/stream-invalidator';

// 延迟导入，打破循环依赖
let _handleServerMessage: ((msg: any) => void) | null = null;
let _applyStreamingStatus: ((isStreaming: boolean, sessionPath: string | null) => void) | null = null;

export function injectHandlers(
  handleServerMessage: (msg: any) => void,
  applyStreamingStatus: (isStreaming: boolean, sessionPath: string | null) => void,
): void {
  _handleServerMessage = handleServerMessage;
  _applyStreamingStatus = applyStreamingStatus;
}

// ── 流恢复版本计数 ──
const _streamResumeRebuildVersions: Record<string, number> = {};
let _streamResumeRebuildingFor: string | null = null;

// ── Session 流元数据（module-level，不走 Zustand） ──
const MAX_CONSUMED_SEQS = 10_000;

type SessionStreamMeta = {
  streamId: string | null;
  lastSeq: number;
  consumedSeqs: Set<number>;
};

const _sessionStreams: Record<string, SessionStreamMeta> = {};

export function invalidateSessionStreamMeta(sessionPath?: string): void {
  if (sessionPath == null) {
    for (const key of Object.keys(_sessionStreams)) delete _sessionStreams[key];
    return;
  }
  delete _sessionStreams[sessionPath];
}

export function getSessionStreamMeta(sessionPath?: string): SessionStreamMeta | null {
  const path = sessionPath || useStore.getState().currentSessionPath;
  if (!path) return null;
  if (!_sessionStreams[path]) {
    _sessionStreams[path] = { streamId: null, lastSeq: 0, consumedSeqs: new Set() };
  }
  return _sessionStreams[path];
}

export function isStreamScopedMessage(msg: any): boolean {
  return !!(msg && msg.sessionPath && (msg.streamId || Number.isFinite(msg.seq)));
}

export function updateSessionStreamMeta(meta: any = {}): boolean {
  const sessionPath = meta.sessionPath || useStore.getState().currentSessionPath;
  if (!sessionPath) return true;

  const entry = getSessionStreamMeta(sessionPath);
  if (!entry) return true;

  if (meta.streamId) {
    if (entry.streamId && entry.streamId !== meta.streamId) {
      entry.lastSeq = 0;
      entry.consumedSeqs.clear();
    }
    entry.streamId = meta.streamId;
  }

  if (Number.isFinite(meta.seq)) {
    const seq = Math.max(0, Math.floor(meta.seq));
    if (entry.consumedSeqs.has(seq)) return false;
    markConsumedSeq(entry, seq);
  }

  return true;
}

export function isStreamResumeRebuilding(): string | null {
  return _streamResumeRebuildingFor;
}

export function requestStreamResume(sessionPath?: string, opts: any = {}): void {
  const path = sessionPath || useStore.getState().currentSessionPath;
  const ws = getWebSocket();
  if (!path || !ws || ws.readyState !== WebSocket.OPEN) return;
  const meta = getSessionStreamMeta(path) || { streamId: null, lastSeq: 0 };
  const fromStart = !!opts.fromStart;
  const streamId = opts.streamId !== undefined ? opts.streamId : (meta.streamId || null);
  const sinceSeq = Number.isFinite(opts.sinceSeq)
    ? Math.max(0, Math.floor(opts.sinceSeq))
    : (fromStart ? 0 : (meta.lastSeq || 0));
  ws.send(JSON.stringify({
    type: 'resume_stream',
    sessionPath: path,
    streamId,
    sinceSeq,
  }));
}

// ── 流恢复 / 重建 ──

function nextResumeRebuildVersion(sessionPath: string): number {
  const next = (_streamResumeRebuildVersions[sessionPath] ?? 0) + 1;
  _streamResumeRebuildVersions[sessionPath] = next;
  return next;
}

function isLatestResumeRebuild(sessionPath: string, version: number): boolean {
  return _streamResumeRebuildVersions[sessionPath] === version;
}

function shouldHydrateCompletedEmptyResume(msg: any): boolean {
  if (msg.isStreaming) return false;
  if (!msg.streamId) return false;
  if (Array.isArray(msg.events) && msg.events.length > 0) return false;
  return Number.isFinite(msg.nextSeq) && msg.nextSeq > 1;
}

function resolveRuntimeStreaming(msg: any): boolean {
  return typeof msg.runtimeIsStreaming === 'boolean'
    ? msg.runtimeIsStreaming
    : !!msg.isStreaming;
}

function prepareStreamMeta(sessionPath: string, streamId: string | null, opts: { resetConsumed?: boolean } = {}): SessionStreamMeta | null {
  const meta = getSessionStreamMeta(sessionPath);
  if (!meta) return null;
  if (streamId) {
    if (meta.streamId && meta.streamId !== streamId) {
      meta.lastSeq = 0;
      meta.consumedSeqs.clear();
    }
    meta.streamId = streamId;
  }
  if (opts.resetConsumed) {
    meta.lastSeq = 0;
    meta.consumedSeqs.clear();
  }
  return meta;
}

function markConsumedSeq(meta: SessionStreamMeta, seq: unknown): void {
  const value = Number(seq);
  if (!Number.isFinite(value)) return;
  const normalized = Math.max(0, Math.floor(value));
  meta.lastSeq = Math.max(meta.lastSeq || 0, normalized);
  meta.consumedSeqs.add(normalized);
  pruneConsumedSeqs(meta);
}

function pruneConsumedSeqs(meta: SessionStreamMeta): void {
  if (meta.consumedSeqs.size <= MAX_CONSUMED_SEQS) return;
  const sorted = [...meta.consumedSeqs].sort((a, b) => a - b);
  const removeCount = meta.consumedSeqs.size - MAX_CONSUMED_SEQS;
  for (let i = 0; i < removeCount; i += 1) {
    meta.consumedSeqs.delete(sorted[i]);
  }
}

function dispatchReplayEvent(sessionPath: string, streamId: string | null, entry: any, meta: SessionStreamMeta | null): void {
  const seq = Number.isFinite(entry?.seq) ? Math.max(0, Math.floor(Number(entry.seq))) : null;
  if (seq !== null && meta?.consumedSeqs.has(seq)) return;

  _handleServerMessage?.({
    ...entry.event,
    sessionPath,
    streamId,
    seq: entry.seq,
    __fromReplay: true,
  });

  if (seq !== null && meta) {
    markConsumedSeq(meta, seq);
  }
}

async function rebuildSessionFromResume(msg: any, opts: { finishTurnBeforeHydrate?: boolean } = {}): Promise<void> {
  const currentSessionPath = useStore.getState().currentSessionPath;
  const sessionPath = msg.sessionPath || currentSessionPath;
  if (!sessionPath) return;

  const isCurrentSession = sessionPath === currentSessionPath;
  const myVersion = nextResumeRebuildVersion(sessionPath);
  if (isCurrentSession) _streamResumeRebuildingFor = sessionPath;
  try {
    if (opts.finishTurnBeforeHydrate) {
      streamBufferManager.finishTurn(sessionPath);
    } else {
      // 清掉旧 buffer 防止脏写
      streamBufferManager.clear(sessionPath);
    }

    if (isCurrentSession) {
      clearChat();
    } else {
      useStore.getState().clearSession?.(sessionPath);
    }
    await loadMessages(sessionPath);

    if (!isLatestResumeRebuild(sessionPath, myVersion)) return;
    if (isCurrentSession && useStore.getState().currentSessionPath !== sessionPath) return;

    const streamId = msg.streamId || null;
    const meta = prepareStreamMeta(sessionPath, streamId, { resetConsumed: true });

    for (const entry of msg.events || []) {
      dispatchReplayEvent(sessionPath, streamId, entry, meta);
    }

    if (meta && Number.isFinite(msg.nextSeq)) {
      meta.lastSeq = Math.max(meta.lastSeq || 0, Math.max(0, msg.nextSeq - 1));
    }

    _applyStreamingStatus?.(resolveRuntimeStreaming(msg), sessionPath);

    const ws = getWebSocket();
    if (isCurrentSession && useStore.getState().currentSessionPath === sessionPath && ws?.readyState === WebSocket.OPEN && msg.isStreaming) {
      requestStreamResume(sessionPath);
    }
  } finally {
    if (isLatestResumeRebuild(sessionPath, myVersion) && _streamResumeRebuildingFor === sessionPath) {
      _streamResumeRebuildingFor = null;
    }
  }
}

export function replayStreamResume(msg: any): void {
  const currentSessionPath = useStore.getState().currentSessionPath;
  const sessionPath = msg.sessionPath || currentSessionPath;
  if (!sessionPath) return;

  const completedEmptyResume = shouldHydrateCompletedEmptyResume(msg);
  if (msg.reset || msg.truncated || completedEmptyResume) {
    rebuildSessionFromResume(msg, { finishTurnBeforeHydrate: completedEmptyResume }).catch((err) => {
      console.error('[stream] rebuild failed:', err);
      _streamResumeRebuildingFor = null;
    });
    return;
  }

  const streamId = msg.streamId || null;
  const meta = prepareStreamMeta(sessionPath, streamId);

  for (const entry of msg.events || []) {
    dispatchReplayEvent(sessionPath, streamId, entry, meta);
  }

  if (meta && Number.isFinite(msg.nextSeq)) {
    meta.lastSeq = Math.max(meta.lastSeq || 0, Math.max(0, msg.nextSeq - 1));
  }

  _applyStreamingStatus?.(resolveRuntimeStreaming(msg), sessionPath);
}

registerStreamResumeMetaInvalidator((sessionPath) => {
  invalidateSessionStreamMeta(sessionPath);
});
