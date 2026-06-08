import { describe, expect, it } from 'vitest';
import {
  pickQuickChatRuntimeAgent,
  shouldAdoptRuntimeAgentForQuickChat,
} from '../quick-chat-runtime';

describe('quick chat runtime state', () => {
  it('prefers the current persisted agent from a fresh agent list', () => {
    const agent = pickQuickChatRuntimeAgent([
      { id: 'hana', name: 'Hana', isPrimary: true },
      { id: 'ming', name: 'Ming', isCurrent: true },
    ]);

    expect(agent?.id).toBe('ming');
  });

  it('keeps an existing detached session bound to its original agent', () => {
    expect(shouldAdoptRuntimeAgentForQuickChat('/sessions/quick.jsonl')).toBe(false);
  });

  it('adopts the runtime agent before a detached session exists', () => {
    expect(shouldAdoptRuntimeAgentForQuickChat(null)).toBe(true);
  });
});
