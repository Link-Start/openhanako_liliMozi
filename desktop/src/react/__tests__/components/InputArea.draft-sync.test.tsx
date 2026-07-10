// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea } from '../../components/InputArea';
import { useStore } from '../../stores';

const editorState = vi.hoisted(() => ({
  doc: { type: 'doc', content: [] as unknown[] },
}));

const editorMocks = vi.hoisted(() => ({
  setContent: vi.fn(),
  clearContent: vi.fn(),
}));

vi.mock('@tiptap/react', () => ({
  useEditor: () => {
    const chain: Record<string, unknown> = {};
    chain.clearContent = vi.fn(() => chain);
    chain.deleteRange = vi.fn(() => chain);
    chain.insertContent = vi.fn(() => chain);
    chain.focus = vi.fn(() => chain);
    chain.run = vi.fn();
    const setContent = (...args: unknown[]) => {
      editorMocks.setContent(...args);
      const payload = args[0];
      if (payload === '' || payload == null) {
        editorState.doc = { type: 'doc', content: [] };
        return;
      }
      if (typeof payload === 'string') {
        editorState.doc = {
          type: 'doc',
          content: payload ? [{ type: 'paragraph', content: [{ type: 'text', text: payload }] }] : [],
        };
        return;
      }
      editorState.doc = payload as typeof editorState.doc;
    };
    return {
      commands: {
        focus: vi.fn(),
        clearContent: editorMocks.clearContent,
        scrollIntoView: vi.fn(),
        setContent,
        insertContent: vi.fn(),
      },
      chain: () => chain,
      getText: () => {
        const paragraph = editorState.doc.content?.[0] as { content?: Array<{ text?: string }> } | undefined;
        return paragraph?.content?.[0]?.text || '';
      },
      getJSON: () => editorState.doc,
      state: { tr: { setMeta: vi.fn(() => ({})) } },
      view: { dispatch: vi.fn() },
      on: vi.fn(),
      off: vi.fn(),
    };
  },
  EditorContent: () => React.createElement('div', { 'data-testid': 'editor' }),
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: () => ({}) },
}));

vi.mock('@tiptap/extension-placeholder', () => ({
  default: { configure: () => ({}) },
}));

vi.mock('../../components/input/extensions/skill-badge', () => ({
  SkillBadge: {},
}));

import { createTestTranslator } from '../helpers/i18n-test-strings';

const testT = createTestTranslator();

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: testT }),
}));

vi.mock('../../hooks/use-config', () => ({
  fetchConfig: vi.fn(async () => ({})),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async () => new Response(JSON.stringify({ models: {} }), { status: 200 })),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../stores/session-actions', () => ({
  ensureSession: vi.fn(),
  loadSessions: vi.fn(),
  upsertOptimisticSessionFirstMessage: vi.fn(),
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
  searchDeskFiles: vi.fn(async () => []),
  toggleJianSidebar: vi.fn(),
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: vi.fn(() => ({ send: vi.fn() })),
}));

vi.mock('../../MainContent', () => ({
  attachFilesFromPaths: vi.fn(),
}));

vi.mock('../../components/input/SlashCommandMenu', () => ({
  SlashCommandMenu: () => null,
}));

vi.mock('../../components/input/FileMentionMenu', () => ({
  FileMentionMenu: () => null,
}));

vi.mock('../../components/input/InputStatusBars', () => ({
  InputStatusBars: () => null,
}));

vi.mock('../../components/input/InputContextRow', () => ({
  InputContextRow: () => null,
}));

vi.mock('../../components/input/InputControlBar', () => ({
  InputControlBar: () => null,
}));

vi.mock('../../hooks/use-slash-items', () => ({
  useSkillSlashItems: () => [],
  useServerSlashCommandItems: () => [],
}));

vi.mock('../../utils/paste-upload-feedback', () => ({
  notifyPasteUploadFailure: vi.fn(),
}));

vi.mock('../../services/stream-resume', () => ({
  replayStreamResume: vi.fn(),
  isStreamResumeRebuilding: () => null,
  isStreamScopedMessage: () => false,
  updateSessionStreamMeta: vi.fn(),
}));

function paragraphDoc(text: string) {
  return {
    type: 'doc',
    content: text
      ? [{ type: 'paragraph', content: [{ type: 'text', text }] }]
      : [],
  };
}

function seedSessionComposer(text = '') {
  editorState.doc = paragraphDoc('');
  useStore.setState({
    currentSessionPath: '/session/draft-sync.jsonl',
    currentSessionId: 'sess_draft_sync',
    currentAgentId: 'hana',
    pendingNewSession: false,
    pendingDraftId: null,
    connected: true,
    welcomeVisible: false,
    streamingSessions: [],
    inlineErrors: {},
    attachedFiles: [],
    attachedFilesBySession: {},
    docContextAttached: false,
    quoteCandidate: null,
    quotedSelections: [],
    quotedSelection: null,
    models: [{
      id: 'deepseek-chat',
      provider: 'deepseek',
      name: 'DeepSeek Chat',
      input: ['text'],
      isCurrent: true,
    }],
    sessionModelsByPath: {},
    previewItems: [],
    previewOpen: false,
    chatSessions: {},
    serverPort: 3210,
    serverToken: null,
    modelSwitching: false,
    sessions: [{
      path: '/session/draft-sync.jsonl',
      sessionId: 'sess_draft_sync',
      agentId: 'hana',
      agentName: 'Hana',
    }],
    sessionLocatorsById: { sess_draft_sync: { path: '/session/draft-sync.jsonl' } },
    drafts: { sess_draft_sync: text },
    draftDocs: text ? { sess_draft_sync: paragraphDoc(text) } : {},
    draftsHydratedAt: Date.now(),
  } as never);
}

function seedPendingComposer(text = '晚上好啊') {
  editorState.doc = paragraphDoc('');
  useStore.setState({
    currentSessionPath: null,
    currentSessionId: null,
    currentAgentId: 'hana',
    pendingNewSession: true,
    pendingDraftId: 'draft-sync',
    connected: true,
    welcomeVisible: true,
    streamingSessions: [],
    inlineErrors: {},
    attachedFiles: [],
    attachedFilesBySession: {},
    docContextAttached: false,
    quoteCandidate: null,
    quotedSelections: [],
    quotedSelection: null,
    models: [{
      id: 'deepseek-chat',
      provider: 'deepseek',
      name: 'DeepSeek Chat',
      input: ['text'],
      isCurrent: true,
    }],
    sessionModelsByPath: {},
    previewItems: [],
    previewOpen: false,
    chatSessions: {},
    serverPort: 3210,
    serverToken: null,
    modelSwitching: false,
    sessions: [],
    sessionLocatorsById: {},
    drafts: { __home__: text },
    draftDocs: { __home__: paragraphDoc(text) },
    draftsHydratedAt: Date.now(),
  } as never);
}

function setContentCallsWithText(text: string) {
  return editorMocks.setContent.mock.calls.some((call) => {
    const payload = call[0];
    if (payload === '' || payload == null) return text === '';
    if (typeof payload === 'string') return payload.includes(text);
    const serialized = JSON.stringify(payload);
    return serialized.includes(text);
  });
}

describe('InputArea draft sync', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    editorState.doc = paragraphDoc('');
    window.platform = {} as typeof window.platform;
    delete (window as unknown as { hana?: unknown }).hana;
  });

  it('clears the live editor when clearDraft is called externally', async () => {
    seedSessionComposer('hello draft');

    render(React.createElement(InputArea));

    await waitFor(() => {
      expect(editorMocks.setContent).toHaveBeenCalled();
    });

    editorMocks.setContent.mockClear();
    useStore.getState().clearDraft('/session/draft-sync.jsonl');

    await waitFor(() => {
      expect(editorMocks.setContent).toHaveBeenCalledWith('', { emitUpdate: false });
    });
  });

  it('does not inject home draft text after pending activation when the session draft is empty', async () => {
    seedPendingComposer('晚上好啊');

    const { rerender } = render(React.createElement(InputArea));

    await waitFor(() => {
      expect(setContentCallsWithText('晚上好啊')).toBe(true);
    });

    editorMocks.setContent.mockClear();

    useStore.setState({
      currentSessionPath: '/session/activated.jsonl',
      currentSessionId: 'sess_activated',
      pendingNewSession: false,
      pendingDraftId: null,
      welcomeVisible: false,
      sessions: [{
        path: '/session/activated.jsonl',
        sessionId: 'sess_activated',
        agentId: 'hana',
        agentName: 'Hana',
      }],
      sessionLocatorsById: { sess_activated: { path: '/session/activated.jsonl' } },
      drafts: {},
      draftDocs: {},
    } as never);
    useStore.getState().clearDraft('__home__');

    rerender(React.createElement(InputArea));

    await waitFor(() => {
      expect(setContentCallsWithText('晚上好啊')).toBe(false);
      expect(editorMocks.setContent).toHaveBeenCalledWith('', { emitUpdate: false });
    });
  });
});
