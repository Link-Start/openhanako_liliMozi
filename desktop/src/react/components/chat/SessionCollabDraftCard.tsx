import { memo, useEffect, useState } from 'react';
import { ChatResourceCard } from './ChatResourceCard';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { SelectWidget, type SelectOption } from '@/ui';
import styles from './Chat.module.css';

/**
 * SessionCollabDraftCard — 跨 session 协作草稿确认卡（send / create）
 *
 * 渲染 `suggestion_card` 里 kind 为 `session_send_draft` / `session_create_draft`
 * 的 block：send 卡编辑目标 session 的消息正文，create 卡编辑目标 Agent 与首条消息。
 * 确认走 POST /api/session-collab/apply，draft 过期 / 执行中 / 部分失败均在卡片内提示。
 *
 * Parity 限制（v0 接受）：历史 session 重载后卡片状态回落到 block.status（多数情况下
 * 仍是 pending），但此时草稿在 server 端内存 store 里大概率已过期——点确认会拿到 404
 * draft_expired。这与 automation 建议卡的现状一致，暂不做持久化跟踪。
 */

type ApplyErrorState =
  | { code: 'draft_expired'; text: string }
  | { code: 'draft_in_flight'; text: string }
  | { code: 'first_message_failed'; text: string; sessionId?: string }
  | { code: 'apply_failed'; text: string };

function SessionCollabIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4h11l5 5v11H4z" />
      <path d="M9 9h6M9 13h6M9 17h3" />
    </svg>
  );
}

export const SessionCollabDraftCard = memo(function SessionCollabDraftCard({ block, sessionPath: _sessionPath }: { block: any; sessionPath?: string }) {
  const isCreate = block.kind === 'session_create_draft';
  const detail = block.detail || {};
  const draft = detail.draft || {};

  const agents = useStore(s => s.agents);
  const currentAgentId = useStore(s => s.currentAgentId);
  const fallbackAgentName = useStore(s => s.agentName) || 'Hanako';
  const fallbackAgentYuan = useStore(s => s.agentYuan) || 'hanako';

  const [status, setStatus] = useState(block.status);
  const [draftMessage, setDraftMessage] = useState<string>(
    ((isCreate ? draft.firstMessage : draft.message) as string) || '',
  );
  const [draftTitle, setDraftTitle] = useState<string>((draft.title as string) || '');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    (draft.agentId as string) || currentAgentId || agents[0]?.id || null,
  );
  const [errorState, setErrorState] = useState<ApplyErrorState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);

  useEffect(() => {
    setStatus(block.status);
  }, [block.status]);

  const effectiveAgentId = selectedAgentId || currentAgentId || agents[0]?.id || null;
  const selectedAgentInfo = resolveAgentDisplayInfo({
    id: effectiveAgentId,
    agents,
    fallbackAgentName,
    fallbackAgentYuan,
  });

  const pending = status === 'pending';
  const expired = errorState?.code === 'draft_expired';

  const handleApprove = async () => {
    if (submitting) return;
    setSubmitting(true);
    setErrorState(null);
    try {
      const editedDraft = isCreate
        ? { ...draft, agentId: effectiveAgentId, title: draftTitle, firstMessage: draftMessage }
        : { ...draft, message: draftMessage };
      const res = await hanaFetch('/api/session-collab/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestionId: block.suggestionId, draft: editedDraft }),
        throwOnHttpError: false,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setCreatedSessionId((data?.result?.sessionId as string) || null);
        setStatus('approved');
        return;
      }
      const code = data?.code;
      if (code === 'draft_expired') {
        setErrorState({ code: 'draft_expired', text: window.t('sessionCollab.expired') });
        return;
      }
      if (code === 'draft_in_flight') {
        setErrorState({ code: 'draft_in_flight', text: window.t('sessionCollab.inFlight') });
        return;
      }
      if (code === 'first_message_failed') {
        const sid = (data?.sessionId as string) || '';
        setErrorState({
          code: 'first_message_failed',
          sessionId: sid,
          text: window.t('sessionCollab.halfCreated', { id: sid }),
        });
        return;
      }
      setErrorState({
        code: 'apply_failed',
        text: window.t('sessionCollab.sendFailed', { error: (data?.error as string) || res.statusText }),
      });
    } catch (err: any) {
      setErrorState({
        code: 'apply_failed',
        text: window.t('sessionCollab.sendFailed', { error: err?.message || String(err) }),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleIgnore = () => {
    setStatus('rejected');
  };

  if (!pending) {
    const isApproved = status === 'approved';
    const subtitle = isApproved && isCreate && createdSessionId
      ? window.t('sessionCollab.createdSession', { id: createdSessionId })
      : block.description;
    return (
      <ChatResourceCard
        icon={<SessionCollabIcon />}
        title={block.title || window.t('sessionCollab.messageField')}
        subtitle={subtitle}
        statusLabel={isApproved ? window.t('common.approved') : window.t('common.rejected')}
        statusTone={isApproved ? 'success' : 'muted'}
        className={styles.sessionCollabDraftCard}
      />
    );
  }

  return (
    <ChatResourceCard
      icon={<SessionCollabIcon />}
      title={block.title || window.t('sessionCollab.messageField')}
      subtitle={block.description}
      className={styles.sessionCollabDraftCard}
      expandable={false}
      expanded
    >
      <div className={styles.sessionCollabDraftBody}>
        {isCreate && (
          <>
            <input
              className={styles.sessionCollabDraftTitleInput}
              value={draftTitle}
              onChange={e => setDraftTitle(e.target.value)}
              placeholder={window.t('automation.field.label')}
              spellCheck={false}
            />
            <label className={styles.automationDraftField}>
              <span>{window.t('automation.field.agent')}</span>
              <SelectWidget
                className={styles.automationDraftAgentSelect}
                triggerClassName={styles.automationDraftControlButton}
                popupClassName={styles.automationDraftAgentPopup}
                value={effectiveAgentId || ''}
                options={agents.map((agent: any): SelectOption => ({
                  value: agent.id,
                  label: agent.name || agent.id,
                }))}
                onChange={(value) => setSelectedAgentId(value)}
                align="start"
                density="comfortable"
                renderTrigger={(_option, isOpen) => (
                  <>
                    <AgentAvatar info={selectedAgentInfo} className={styles.automationDraftAgentAvatar} />
                    <span className={styles.automationDraftAgentName}>{selectedAgentInfo.displayName}</span>
                    <svg className={styles.automationDraftControlArrow} data-open={isOpen} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </>
                )}
                renderOption={(option, selected) => {
                  const info = resolveAgentDisplayInfo({
                    id: option.value,
                    agents,
                    fallbackAgentName: option.label,
                  });
                  return (
                    <span className={styles.automationDraftAgentOption} data-selected={selected}>
                      <AgentAvatar info={info} className={styles.automationDraftAgentAvatar} />
                      <span>{info.displayName}</span>
                    </span>
                  );
                }}
              />
            </label>
          </>
        )}
        <textarea
          className={styles.sessionCollabDraftTextarea}
          value={draftMessage}
          onChange={e => setDraftMessage(e.target.value)}
          aria-label={window.t('sessionCollab.messageField')}
          spellCheck={false}
        />
        {errorState && (
          <div className={styles.sessionCollabDraftError}>{errorState.text}</div>
        )}
        <div className={styles.automationDraftActions}>
          <button className={styles.automationDraftTextButton} type="button" onClick={handleIgnore}>
            {window.t('sessionCollab.ignore')}
          </button>
          <button
            className={styles.automationDraftPrimaryButton}
            type="button"
            onClick={handleApprove}
            disabled={submitting || expired}
          >
            {window.t(isCreate ? 'sessionCollab.confirmCreate' : 'sessionCollab.confirmSend')}
          </button>
        </div>
      </div>
    </ChatResourceCard>
  );
});
