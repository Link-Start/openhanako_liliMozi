// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionCollabDraftCard } from '../../components/chat/SessionCollabDraftCard';
import { AssistantMessage } from '../../components/chat/AssistantMessage';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true, result: null }), { status: 200 })),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

function sendBlock(overrides: Record<string, unknown> = {}) {
  return {
    type: 'suggestion_card',
    kind: 'session_send_draft',
    suggestionId: 'suggestion_send_1',
    status: 'pending',
    title: 'sid-target-1',
    description: 'original message',
    target: { type: 'session', sessionId: 'sid-target-1', sessionTitle: null, agentId: 'hanako', agentName: 'Hanako' },
    detail: {
      kind: 'session_send_draft',
      draft: { targetSessionId: 'sid-target-1', message: 'original message' },
    },
    actions: [{ id: 'view', kind: 'open' }],
    ...overrides,
  };
}

function createBlock(overrides: Record<string, unknown> = {}) {
  return {
    type: 'suggestion_card',
    kind: 'session_create_draft',
    suggestionId: 'suggestion_create_1',
    status: 'pending',
    title: 'Hanako',
    description: 'first message body',
    target: { type: 'agent', agentId: 'hanako', agentName: 'Hanako' },
    detail: {
      kind: 'session_create_draft',
      draft: { agentId: 'hanako', model: 'claude', title: '', firstMessage: 'first message body' },
    },
    actions: [{ id: 'view', kind: 'open' }],
    ...overrides,
  };
}

function renderCard(block: Record<string, unknown>, sessionPath = '/sessions/main.jsonl') {
  return render(<SessionCollabDraftCard block={block as any} sessionPath={sessionPath} />);
}

describe('SessionCollabDraftCard', () => {
  beforeEach(() => {
    window.t = ((key: string, params?: Record<string, string>) => {
      if (params) {
        return `${key}:${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')}`;
      }
      return key;
    }) as typeof window.t;
    useStore.setState({
      agents: [
        { id: 'hanako', name: 'Hanako', yuan: 'hanako', homeFolder: '/home/hanako' },
        { id: 'maomao', name: '毛毛', yuan: 'maomao', homeFolder: '/home/maomao' },
      ],
      agentName: 'Hanako',
      agentYuan: 'hanako',
      currentAgentId: 'hanako',
      streamingSessions: [],
      selectedMessageIdsBySession: {},
    } as never);
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(hanaFetch).mockResolvedValue(new Response(JSON.stringify({ ok: true, result: null }), { status: 200 }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders a send draft card with target identity and editable message', () => {
    renderCard(sendBlock());

    expect(screen.getByText('sid-target-1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('original message')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sessionCollab.confirmSend' })).toBeInTheDocument();
  });

  it('submits the edited message to /api/session-collab/apply and shows the sent state on success', async () => {
    renderCard(sendBlock());

    const textarea = screen.getByDisplayValue('original message');
    fireEvent.change(textarea, { target: { value: 'edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'sessionCollab.confirmSend' }));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/session-collab/apply', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          suggestionId: 'suggestion_send_1',
          draft: { targetSessionId: 'sid-target-1', message: 'edited' },
        }),
      }));
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'sessionCollab.confirmSend' })).not.toBeInTheDocument();
    });
  });

  it('shows the expired message and disables the confirm button on 404 draft_expired', async () => {
    vi.mocked(hanaFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'draft not found', code: 'draft_expired' }), { status: 404 }),
    );
    renderCard(sendBlock());

    fireEvent.click(screen.getByRole('button', { name: 'sessionCollab.confirmSend' }));

    await waitFor(() => {
      expect(screen.getByText('sessionCollab.expired')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'sessionCollab.confirmSend' })).toBeDisabled();
  });

  it('shows a retryable error on 500 apply_failed and allows re-submitting', async () => {
    vi.mocked(hanaFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'session_busy', code: 'apply_failed' }), { status: 500 }),
    );
    renderCard(sendBlock());

    const confirmBtn = screen.getByRole('button', { name: 'sessionCollab.confirmSend' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText(/sessionCollab\.sendFailed/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'sessionCollab.confirmSend' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'sessionCollab.confirmSend' }));
    await waitFor(() => {
      expect(vi.mocked(hanaFetch).mock.calls.length).toBe(2);
    });
  });

  it('renders a create draft card with an agent selector and the first message', () => {
    renderCard(createBlock());

    expect(screen.getByDisplayValue('first message body')).toBeInTheDocument();
    expect(screen.getAllByText('Hanako').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'sessionCollab.confirmCreate' })).toBeInTheDocument();
  });

  it('shows the half-created message with sessionId on 500 first_message_failed and stays retryable', async () => {
    vi.mocked(hanaFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'first_message_failed: boom', code: 'first_message_failed', sessionId: 'sid-new' }), { status: 500 }),
    );
    renderCard(createBlock());

    fireEvent.click(screen.getByRole('button', { name: 'sessionCollab.confirmCreate' }));

    await waitFor(() => {
      expect(screen.getByText(/sessionCollab\.halfCreated/)).toBeInTheDocument();
      expect(screen.getByText(/sid-new/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'sessionCollab.confirmCreate' })).not.toBeDisabled();
  });

  it('rejects locally on ignore without calling the apply API', () => {
    renderCard(sendBlock());

    fireEvent.click(screen.getByRole('button', { name: 'sessionCollab.ignore' }));

    expect(screen.queryByRole('button', { name: 'sessionCollab.confirmSend' })).not.toBeInTheDocument();
    expect(hanaFetch).not.toHaveBeenCalled();
  });

  it('AssistantMessage dispatches session_send_draft suggestion_card blocks to this card, not the automation fallback', () => {
    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        message={{
          id: 'assistant-session-collab-1',
          role: 'assistant',
          timestamp: Date.now(),
          blocks: [sendBlock()],
        } as any}
      />,
    );

    // 走到 SessionCollabDraftCard：send 卡的编辑区（textarea + 确认按钮）应该出现。
    expect(screen.getByDisplayValue('original message')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sessionCollab.confirmSend' })).toBeInTheDocument();
    // 不应该走 CronConfirmBlock 的 automation 通用兜底（那条路径没有 view/open 相关 aria-label）。
    expect(screen.queryByRole('button', { name: 'automation.openDraft' })).not.toBeInTheDocument();
  });
});
