import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '../../stores';
import { sessionScopedListIncludes, sessionScopedValue } from '../../stores/session-slice';
import { loadMoreMessages } from '../../stores/session-actions';
import { getSelectionCommitAnchorRect, scheduleCaptureChatSelection } from '../../stores/selection-actions';
import { useBoxSelection } from '../../hooks/use-box-selection';
import { useContinuousBottomScroll } from '../../hooks/use-continuous-bottom-scroll';
import type { ChatListItem } from '../../stores/chat-types';
import { ChatTimelineNavigator } from './ChatTimelineNavigator';
import { ChatTranscript } from './ChatTranscript';
import { buildTimelineAnchors, type TimelineAnchor } from './timeline-anchors';
import styles from './Chat.module.css';

const EMPTY_ITEMS: ChatListItem[] = [];
const EMPTY_TIMELINE_ANCHORS: TimelineAnchor[] = [];
const LOAD_MORE_THRESHOLD = 200;
const SCROLL_THRESHOLD = 50;
const TIMELINE_HOVER_ZONE_PX = 64;
const TIMELINE_TOP_OFFSET_PX = 76;
const TIMELINE_HEIGHT_RATIO = 0.5;

export interface ChatScrollButtonState {
  el: HTMLElement | null;
  visible: boolean;
  scrollToBottom: (() => void) | null;
}

export interface ChatMessageSurfaceProps {
  sessionPath: string;
  active?: boolean;
  variant?: 'default' | 'card';
  onScrollButtonChange?: (state: ChatScrollButtonState) => void;
}

export const ChatMessageSurface = memo(function ChatMessageSurface({
  sessionPath,
  active = true,
  variant = 'default',
  onScrollButtonChange,
}: ChatMessageSurfaceProps) {
  const items = useStore(s => sessionScopedValue(s, s.chatSessions, sessionPath)?.items || EMPTY_ITEMS);
  const hasMore = useStore(s => sessionScopedValue(s, s.chatSessions, sessionPath)?.hasMore ?? false);
  const loadingMore = useStore(s => sessionScopedValue(s, s.chatSessions, sessionPath)?.loadingMore ?? false);
  const isSessionStreaming = useStore(s => sessionScopedListIncludes(s, s.streamingSessions, sessionPath));
  const sessionAgentId = useStore(s => s.sessions.find(se => se.path === sessionPath)?.agentId ?? null);
  const sessionReadOnly = useStore(s => s.sessions.find(se => se.path === sessionPath)?.agentDeleted === true);
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const messageElementsRef = useRef(new Map<string, HTMLDivElement>());
  const [timelineRailVisible, setTimelineRailVisible] = useState(false);
  const [timelinePrepared, setTimelinePrepared] = useState(false);
  const bottomScroll = useContinuousBottomScroll({
    scrollRef: ref,
    contentRef,
    active,
    stickyThreshold: SCROLL_THRESHOLD,
  });
  const timelineAnchors = useMemo(() => (
    active && timelinePrepared ? buildTimelineAnchors(items) : EMPTY_TIMELINE_ANCHORS
  ), [active, items, timelinePrepared]);
  const emitScrollButton = useCallback((state: ChatScrollButtonState) => {
    onScrollButtonChange?.(state);
  }, [onScrollButtonChange]);
  const registerMessageElement = useCallback((messageId: string, element: HTMLDivElement | null) => {
    if (element) {
      messageElementsRef.current.set(messageId, element);
    } else {
      messageElementsRef.current.delete(messageId);
    }
  }, []);
  const orderedIds = useMemo(() => {
    const ids: string[] = [];
    for (const it of items) {
      if (it.type === 'message') ids.push(it.data.id);
    }
    return ids;
  }, [items]);
  const boxSelection = useBoxSelection({ messageElementsRef, orderedIds, sessionPath, active });
  const handleCaptureSelection = useCallback((event: ReactMouseEvent<HTMLDivElement> | ReactKeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    scheduleCaptureChatSelection(sessionPath, getSelectionCommitAnchorRect(event.nativeEvent));
  }, [active, sessionPath]);
  const handleShellPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const xFromRight = rect.right - event.clientX;
    const yFromTop = event.clientY - rect.top;
    const inRailX = xFromRight >= 0 && xFromRight <= TIMELINE_HOVER_ZONE_PX;
    const inRailY = yFromTop >= TIMELINE_TOP_OFFSET_PX
      && yFromTop <= TIMELINE_TOP_OFFSET_PX + rect.height * TIMELINE_HEIGHT_RATIO;
    setTimelineRailVisible(inRailX && inRailY);
    if (active && inRailX && inRailY) setTimelinePrepared(true);
  }, [active]);
  const handleShellPointerLeave = useCallback(() => {
    setTimelineRailVisible(false);
  }, []);

  useEffect(() => {
    if (active) return;
    setTimelineRailVisible(false);
    setTimelinePrepared(false);
  }, [active]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      const sticky = bottomScroll.checkSticky();
      if (active) {
        emitScrollButton({
          el,
          visible: !sticky,
          scrollToBottom: () => {
            bottomScroll.scrollToBottom({ mode: 'follow', forceSticky: true });
          },
        });
      }
      if (el.scrollTop < LOAD_MORE_THRESHOLD) {
        const state = useStore.getState();
        const session = sessionScopedValue(state, state.chatSessions, sessionPath);
        if (session?.hasMore && !session.loadingMore) {
          loadMoreMessages(sessionPath);
        }
      }
      el.classList.add(styles['is-scrolling']);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        el.classList.remove(styles['is-scrolling']);
      }, 800);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    if (active) {
      emitScrollButton({
        el,
        visible: !bottomScroll.checkSticky(),
        scrollToBottom: () => {
          bottomScroll.scrollToBottom({ mode: 'follow', forceSticky: true });
        },
      });
    }
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (hideTimer) clearTimeout(hideTimer);
      emitScrollButton({ el: null, visible: false, scrollToBottom: null });
    };
  }, [active, bottomScroll, emitScrollButton, sessionPath]);

  const prevFirstId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const firstId = items.find((item) => item.type === 'message')?.data.id;
    const el = ref.current;
    if (el && prevFirstId.current && firstId !== prevFirstId.current) {
      const prevHeight = el.dataset.prevScrollHeight;
      if (prevHeight) {
        el.scrollTop += el.scrollHeight - Number(prevHeight);
      }
    }
    prevFirstId.current = firstId;
  }, [items]);

  useEffect(() => {
    const el = ref.current;
    if (el && loadingMore) {
      el.dataset.prevScrollHeight = String(el.scrollHeight);
    }
  }, [loadingMore]);

  useLayoutEffect(() => {
    if (active) bottomScroll.armInstantLanding();
  }, [active, bottomScroll]);

  const scrolledOnce = useRef(false);
  useLayoutEffect(() => {
    if (scrolledOnce.current) return;
    if (items.length > 0) {
      bottomScroll.scrollToBottom({ mode: 'instant', forceSticky: true });
      scrolledOnce.current = true;
    }
  }, [bottomScroll, items.length]);

  const prevLen = useRef(items.length);
  useEffect(() => {
    if (items.length > prevLen.current && active) {
      const last = items[items.length - 1];
      if (last?.type === 'message' && last.data.role === 'user') {
        bottomScroll.scrollToBottom({ mode: 'instant', forceSticky: true });
      } else {
        bottomScroll.followBottom();
      }
    }
    prevLen.current = items.length;
  }, [items, items.length, active, bottomScroll]);

  const shellClassName = variant === 'card'
    ? `${styles.sessionShell} ${styles.cardSessionShell}`
    : `${styles.sessionShell}${active ? ` ${styles.sessionShellActive}` : ''}`;

  return (
    <div
      className={shellClassName}
      data-active={active ? 'true' : 'false'}
      onPointerMove={handleShellPointerMove}
      onPointerLeave={handleShellPointerLeave}
      style={{
        visibility: active ? 'visible' : 'hidden',
        zIndex: active ? 1 : 0,
        pointerEvents: active ? 'auto' : 'none',
      }}
    >
      <div
        ref={ref}
        className={styles.sessionPanel}
        data-chat-selection-root=""
        data-session-path={sessionPath}
        onPointerDown={boxSelection.onPointerDown}
        onClickCapture={boxSelection.onClickCapture}
        onMouseUp={handleCaptureSelection}
        onKeyUp={handleCaptureSelection}
      >
        <div
          ref={contentRef}
          className={`${styles.sessionMessages}${boxSelection.selectionModeActive ? ` ${styles.selectionModeActive}` : ''}`}
        >
          {hasMore && (
            <div className={styles.loadMoreHint}>
              {loadingMore ? '...' : ''}
            </div>
          )}
          <ChatTranscript
            items={items}
            sessionPath={sessionPath}
            agentId={sessionAgentId}
            readOnly={sessionReadOnly}
            registerMessageElement={registerMessageElement}
            enableProcessFold
          />
          {isSessionStreaming && (
            <div className={styles.typingIndicator} />
          )}
          <div className={styles.sessionFooter} />
        </div>
      </div>
      <ChatTimelineNavigator
        anchors={timelineAnchors}
        scrollRef={ref}
        contentRef={contentRef}
        messageElementsRef={messageElementsRef}
        active={active}
        railVisible={timelineRailVisible}
      />
      {boxSelection.box && (
        <div
          className={styles.selectionBox}
          style={{
            left: boxSelection.box.left,
            top: boxSelection.box.top,
            width: boxSelection.box.right - boxSelection.box.left,
            height: boxSelection.box.bottom - boxSelection.box.top,
          }}
        />
      )}
    </div>
  );
});
