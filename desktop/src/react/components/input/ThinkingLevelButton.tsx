import { useCallback, useMemo } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { useStore } from '../../stores';
import { normalizeThinkingLevel, type ThinkingLevel } from '../../stores/model-slice';
import { SelectWidget, type SelectOption } from '@/ui';
import styles from './InputArea.module.css';

const ALL_THINKING_LEVELS: ThinkingLevel[] = ['off', 'medium', 'high', 'xhigh'];

export function ThinkingLevelButton({ level, onChange, modelXhigh }: {
  level: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  modelXhigh: boolean;
}) {
  const { t } = useI18n();
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const activeLevel = normalizeThinkingLevel(level);

  const availableLevels = useMemo(() => {
    return ALL_THINKING_LEVELS.filter(lv => lv !== 'xhigh' || modelXhigh);
  }, [modelXhigh]);

  const selectLevel = useCallback(async (next: ThinkingLevel) => {
    try {
      const useSessionThinking = !!currentSessionPath && !pendingNewSession;
      if (!useSessionThinking) {
        const res = await hanaFetch('/api/session-thinking-level', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level: next }),
        });
        const data = await res.json();
        if (!res.ok || data?.ok === false) {
          throw new Error(data?.error || 'failed to save thinking level');
        }
        const normalized = normalizeThinkingLevel((data?.thinkingLevel || next) as ThinkingLevel);
        useStore.getState().setPendingNewSessionThinkingLevel(normalized);
        onChange(normalized);
        return;
      }
      const res = await hanaFetch('/api/session-thinking-level', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionPath: currentSessionPath, level: next }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || 'failed to save thinking level');
      }
      onChange(normalizeThinkingLevel((data?.thinkingLevel || next) as ThinkingLevel));
    } catch (err) {
      console.error('[thinking-level] save failed:', err);
    }
  }, [currentSessionPath, onChange, pendingNewSession]);

  const tLevel = (key: string, fallback: string) => {
    const v = t(key);
    return v !== key ? v : fallback;
  };

  const isOff = activeLevel === 'off';

  const options: SelectOption[] = availableLevels.map(lv => ({
    value: lv,
    label: tLevel(`input.thinkingLevel.${lv}`, lv),
    description: tLevel(`input.thinkingDesc.${lv}`, ''),
  }));

  return (
    <SelectWidget
      className={styles['thinking-selector']}
      options={options}
      value={activeLevel}
      onChange={(v) => selectLevel(v as ThinkingLevel)}
      align="end"
      placement="top"
      offset={4}
      popupMinWidth={160}
      triggerBare
      triggerClassName={`${styles['thinking-pill']}${isOff ? '' : ` ${styles.active}`}`}
      renderTrigger={() => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18h6" /><path d="M10 22h4" />
          <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8 6 6 0 006 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5" />
          {isOff && <line x1="4" y1="4" x2="20" y2="20" strokeWidth="1.5" />}
        </svg>
      )}
    />
  );
}
