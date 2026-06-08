import { useEffect, useMemo, useState } from 'react';
import { useAutoUpdateState } from '../../hooks/use-auto-update-state';
import type { AutoUpdateState } from '../../types';
import styles from './SidebarNoticeSlot.module.css';

const DISMISSED_UPDATE_KEY = 'hana-sidebar-update-dismissed-key';

type NoticeStorage = Pick<Storage, 'getItem' | 'setItem'>;

interface SidebarUpdateNoticeCardProps {
  state: AutoUpdateState | null;
  onInstall?: () => void | Promise<unknown>;
  storage?: NoticeStorage | null;
}

const tr = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

function safeStorage(): NoticeStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readDismissedKey(storage: NoticeStorage | null): string | null {
  try {
    return storage?.getItem(DISMISSED_UPDATE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeDismissedKey(storage: NoticeStorage | null, key: string): void {
  try {
    storage?.setItem(DISMISSED_UPDATE_KEY, key);
  } catch {
    // Ignore storage failures; the in-memory dismissed state still hides the card for this mount.
  }
}

function updateNoticeKey(state: AutoUpdateState | null): string | null {
  if (!state || state.status !== 'downloaded') return null;
  return state.version ? `version:${state.version}` : `status:${state.status}`;
}

function UpdateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function updateTitle(state: AutoUpdateState): string {
  return tr('settings.about.updateReadyInstall', { version: state.version ?? '' });
}

export function SidebarUpdateNoticeCard({
  state,
  onInstall,
  storage,
}: SidebarUpdateNoticeCardProps) {
  const resolvedStorage = storage === undefined ? safeStorage() : storage;
  const noticeKey = updateNoticeKey(state);
  const [dismissedKey, setDismissedKey] = useState<string | null>(() => readDismissedKey(resolvedStorage));

  useEffect(() => {
    setDismissedKey(readDismissedKey(resolvedStorage));
  }, [noticeKey, resolvedStorage]);

  const content = useMemo(() => {
    if (!state || !noticeKey || dismissedKey === noticeKey) return null;
    return {
      title: updateTitle(state),
    };
  }, [dismissedKey, noticeKey, state]);

  if (!state || !noticeKey || !content) return null;

  const dismiss = () => {
    writeDismissedKey(resolvedStorage, noticeKey);
    setDismissedKey(noticeKey);
  };

  return (
    <div className={styles.slot}>
      <section className={styles.card} role="status" aria-live="polite">
        <span className={styles.icon}>
          <UpdateIcon />
        </span>
        <div className={styles.content}>
          <div className={styles.title}>{content.title}</div>
          {state.status === 'downloaded' && onInstall && (
            <div className={styles.actions}>
              <button type="button" className={styles.actionButton} onClick={() => void onInstall()}>
                <span>{tr('settings.about.updateInstallNow')}</span>
                <UpdateIcon />
              </button>
            </div>
          )}
        </div>
        <button type="button" className={styles.closeButton} aria-label={tr('window.close')} onClick={dismiss}>
          <CloseIcon />
        </button>
      </section>
    </div>
  );
}

export function SidebarNoticeSlot() {
  const updateState = useAutoUpdateState();
  return (
    <SidebarUpdateNoticeCard
      state={updateState}
      onInstall={() => window.hana?.autoUpdateInstall?.()}
    />
  );
}
