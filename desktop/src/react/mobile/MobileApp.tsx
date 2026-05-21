import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { AppTitlebar } from '../components/app/AppTitlebar';
import { ChatPage } from '../components/app/ChatPage';
import { ChatSidebar } from '../components/app/ChatSidebar';
import { MainContent } from '../MainContent';
import { StatusBar } from '../components/StatusBar';
import { ToastContainer } from '../components/ToastContainer';
import { toggleSidebar } from '../components/SidebarLayout';
import { toggleJianSidebar } from '../stores/desk-actions';
import { togglePreviewPanel } from '../stores/preview-actions';
import { useStore } from '../stores';
import { createNewSession } from '../stores/session-actions';
import {
  initializeMobileRuntime,
  readMobileAuthSession,
  type MobilePrincipal,
} from './mobile-init';

type AuthState = 'checking' | 'login' | 'ready';
type LoginMode = 'device' | 'password';
const MOBILE_REQUIRED_SCOPES = Object.freeze(['chat', 'resources.read', 'files.read', 'files.write']);
const MOBILE_EDGE_GESTURE_WIDTH = 28;
const MOBILE_EDGE_GESTURE_MIN_DISTANCE = 56;
const MOBILE_EDGE_GESTURE_MAX_VERTICAL_DRIFT = 80;
const MOBILE_EDGE_GESTURE_DOMINANCE = 1.25;

const LazyPreviewPanel = lazy(() => import('../components/PreviewPanel').then(module => ({ default: module.PreviewPanel })));
const LazyMediaViewer = lazy(() => import('../components/shared/MediaViewer/MediaViewer').then(module => ({ default: module.MediaViewer })));
const LazyWorkspaceCompanionRail = lazy(() => import('../components/app/WorkspaceCompanionRail').then(module => ({ default: module.WorkspaceCompanionRail })));

type MobileEdgeGesture = {
  edge: 'left' | 'right';
  startX: number;
  startY: number;
  cancelled: boolean;
};

export function MobileApp(): React.ReactElement {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [principal, setPrincipal] = useState<MobilePrincipal | null>(null);
  const [loginMode, setLoginMode] = useState<LoginMode>('device');
  const [loginSecret, setLoginSecret] = useState('');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);

  const bootstrap = useCallback(async () => {
    const session = await readMobileAuthSession();
    if (!session.authenticated || !session.principal) {
      setAuthState('login');
      return;
    }
    if (!principalHasRequiredScopes(session.principal, MOBILE_REQUIRED_SCOPES)) {
      await apiJson('/api/web-auth/logout', { method: 'POST' }).catch(() => null);
      setPrincipal(null);
      setLoginError('当前登录缺少工作台权限，请重新输入访问密钥。');
      setAuthState('login');
      return;
    }
    await initializeMobileRuntime(session.principal);
    setPrincipal(session.principal);
    setAuthState('ready');
  }, []);

  useEffect(() => {
    let cancelled = false;
    bootstrap().catch((err) => {
      console.warn('[mobile] bootstrap failed', err);
      if (!cancelled) setAuthState('login');
    });
    return () => {
      cancelled = true;
    };
  }, [bootstrap]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginError(null);
    try {
      const body = loginMode === 'device'
        ? { credential: loginSecret.trim() }
        : { username: loginUsername.trim(), password: loginPassword };
      await apiJson('/api/web-auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setLoginSecret('');
      setLoginPassword('');
      await bootstrap();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : '登录失败');
    }
  };

  if (authState === 'checking') {
    return <MobileLoadingScreen />;
  }

  if (authState === 'login') {
    return (
      <MobileLoginScreen
        mode={loginMode}
        secret={loginSecret}
        username={loginUsername}
        password={loginPassword}
        error={loginError}
        onModeChange={(mode) => { setLoginMode(mode); setLoginError(null); }}
        onSecretChange={setLoginSecret}
        onUsernameChange={setLoginUsername}
        onPasswordChange={setLoginPassword}
        onSubmit={login}
      />
    );
  }

  return (
    <ErrorBoundary region="mobile">
      <MobileDesktopShell principal={principal} />
    </ErrorBoundary>
  );
}

function MobileDesktopShell({
  principal,
}: {
  principal: MobilePrincipal | null;
}) {
  const sidebarOpen = useStore(s => s.sidebarOpen);
  const jianOpen = useStore(s => s.jianOpen);
  const previewOpen = useStore(s => s.previewOpen);
  const mediaViewer = useStore(s => s.mediaViewer);
  const currentTab = useStore(s => s.currentTab);
  const sessions = useStore(s => s.sessions);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const isNarrow = useNarrowMobileViewport();
  const edgeGestureRef = useRef<MobileEdgeGesture | null>(null);
  const t = window.t ?? ((p: string) => p);

  const titlebarTitle = useMemo(() => {
    if (pendingNewSession) return t('sidebar.newChat');
    const currentSession = sessions.find(session => session.path === currentSessionPath);
    return currentSession?.title || currentSession?.firstMessage || t('session.untitled');
  }, [currentSessionPath, pendingNewSession, sessions, t]);

  useEffect(() => {
    useStore.setState({ currentTab: 'chat' });
  }, []);

  useEffect(() => {
    if (isNarrow) useStore.setState({ sidebarOpen: false, jianOpen: false });
  }, [isNarrow]);

  const showDrawerScrim = (sidebarOpen || jianOpen) && isNarrow;
  const openMobileDrawerFromGesture = useCallback((edge: MobileEdgeGesture['edge']) => {
    if (edge === 'left') {
      useStore.setState({ jianOpen: false });
      toggleSidebar(true);
      return;
    }
    useStore.setState({ sidebarOpen: false });
    toggleJianSidebar(true);
  }, []);

  const handleTouchStart = useCallback((event: React.TouchEvent<HTMLElement>) => {
    edgeGestureRef.current = null;
    if (!isNarrow || sidebarOpen || jianOpen || event.touches.length !== 1) return;
    if (shouldIgnoreMobileEdgeGestureTarget(event.target)) return;

    const touch = event.touches[0];
    const width = window.innerWidth || document.documentElement.clientWidth;
    if (touch.clientX <= MOBILE_EDGE_GESTURE_WIDTH) {
      edgeGestureRef.current = {
        edge: 'left',
        startX: touch.clientX,
        startY: touch.clientY,
        cancelled: false,
      };
      return;
    }
    if (touch.clientX >= width - MOBILE_EDGE_GESTURE_WIDTH) {
      edgeGestureRef.current = {
        edge: 'right',
        startX: touch.clientX,
        startY: touch.clientY,
        cancelled: false,
      };
    }
  }, [isNarrow, jianOpen, sidebarOpen]);

  const handleTouchMove = useCallback((event: React.TouchEvent<HTMLElement>) => {
    const gesture = edgeGestureRef.current;
    if (!gesture || event.touches.length !== 1) return;

    const touch = event.touches[0];
    const dx = touch.clientX - gesture.startX;
    const dy = touch.clientY - gesture.startY;
    const horizontalDistance = gesture.edge === 'left' ? dx : -dx;
    const verticalDistance = Math.abs(dy);

    if (verticalDistance > 18 && verticalDistance > Math.abs(dx)) {
      gesture.cancelled = true;
      return;
    }
    if (horizontalDistance > 12 && horizontalDistance > verticalDistance * MOBILE_EDGE_GESTURE_DOMINANCE) {
      event.preventDefault();
    }
  }, []);

  const handleTouchEnd = useCallback((event: React.TouchEvent<HTMLElement>) => {
    const gesture = edgeGestureRef.current;
    edgeGestureRef.current = null;
    if (!gesture || gesture.cancelled) return;
    const touch = event.changedTouches[0];
    if (!touch) return;

    const dx = touch.clientX - gesture.startX;
    const dy = touch.clientY - gesture.startY;
    const horizontalDistance = gesture.edge === 'left' ? dx : -dx;
    const verticalDistance = Math.abs(dy);
    const isDrawerSwipe = horizontalDistance >= MOBILE_EDGE_GESTURE_MIN_DISTANCE
      && verticalDistance <= MOBILE_EDGE_GESTURE_MAX_VERTICAL_DRIFT
      && horizontalDistance > verticalDistance * MOBILE_EDGE_GESTURE_DOMINANCE;
    if (!isDrawerSwipe) return;
    openMobileDrawerFromGesture(gesture.edge);
  }, [openMobileDrawerFromGesture]);

  return (
    <main
      className="mobile-desktop-root"
      data-mobile-principal={principal?.credentialKind || 'session'}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={() => { edgeGestureRef.current = null; }}
    >
      <AppTitlebar
        sidebarOpen={sidebarOpen}
        jianOpen={jianOpen}
        previewOpen={previewOpen}
        showPreviewToggle
        showNewSessionButton
        showChannelTabs={false}
        showWidgetButtons={false}
        centerTitle={titlebarTitle}
        onNewSession={() => void createNewSession()}
        onToggleSidebar={() => {
          if (!sidebarOpen) useStore.setState({ jianOpen: false });
          toggleSidebar(!sidebarOpen);
        }}
        onToggleJian={() => {
          if (!jianOpen) useStore.setState({ sidebarOpen: false });
          toggleJianSidebar(!jianOpen);
        }}
        onTogglePreview={() => {
          if (!previewOpen) useStore.setState({ sidebarOpen: false, jianOpen: false });
          togglePreviewPanel();
        }}
      />
      <div className="app mobile-desktop-app">
        <ChatSidebar
          open={sidebarOpen && currentTab === 'chat'}
          includeChannels={false}
          showSettingsButton={false}
          showActivityBars={false}
          onNewSession={() => void createNewSession()}
          onCollapse={() => toggleSidebar(false)}
          region="mobile-sidebar"
        />
        <MainContent>
          <ChatPage inputSurface="mobile" regionPrefix="mobile-" />
        </MainContent>
        {previewOpen && (
          <Suspense fallback={null}>
            <LazyPreviewPanel />
          </Suspense>
        )}
        {(!isNarrow || jianOpen) && (
          <Suspense fallback={<WorkspaceCompanionRailFallback open={jianOpen} />}>
            <LazyWorkspaceCompanionRail />
          </Suspense>
        )}
      </div>
      {showDrawerScrim && <button className="mobile-drawer-scrim" type="button" aria-label="关闭侧边栏" onClick={closeMobileDrawers} />}
      <StatusBar />
      {mediaViewer && (
        <Suspense fallback={null}>
          <LazyMediaViewer />
        </Suspense>
      )}
      <ToastContainer />
    </main>
  );
}

function WorkspaceCompanionRailFallback({ open }: { open: boolean }) {
  return (
    <aside className={`jian-sidebar${open ? '' : ' collapsed'}`} id="jianSidebar" data-mobile-workspace-loading="">
      <div className="resize-handle resize-handle-left" id="jianResizeHandle"></div>
      <div className="jian-sidebar-inner"></div>
    </aside>
  );
}

function MobileLoadingScreen() {
  return (
    <main className="onboarding">
      <section className="onboarding-step active">
        <img className="onboarding-avatar" src="./icon.png" alt="" />
        <h1 className="onboarding-title">Hana Mobile</h1>
        <p className="onboarding-subtitle">正在连接 Hana...</p>
      </section>
    </main>
  );
}

function MobileLoginScreen({
  mode,
  secret,
  username,
  password,
  error,
  onModeChange,
  onSecretChange,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
}: {
  mode: LoginMode;
  secret: string;
  username: string;
  password: string;
  error: string | null;
  onModeChange: (mode: LoginMode) => void;
  onSecretChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const loginDisabled = mode === 'device'
    ? !secret.trim()
    : !username.trim() || !password;

  return (
    <main className="onboarding">
      <form className="onboarding-step active" onSubmit={onSubmit}>
        <img className="onboarding-avatar" src="./icon.png" alt="" />
        <h1 className="onboarding-title">手机访问 Hana</h1>
        <p className="onboarding-subtitle">{mode === 'device'
          ? '输入桌面端为这台设备生成的访问密钥。登录后会改用 HttpOnly 会话 cookie。'
          : '使用桌面端设置的本地账号登录。局域网明文 HTTP 会被服务器拒绝，请使用本机、HTTPS 或可信 Tunnel。'}</p>

        <div className="provider-grid" role="tablist" aria-label="登录方式">
          <button type="button" role="tab" aria-selected={mode === 'device'} className={`provider-card${mode === 'device' ? ' selected' : ''}`} onClick={() => onModeChange('device')}>
            访问密钥
          </button>
          <button type="button" role="tab" aria-selected={mode === 'password'} className={`provider-card${mode === 'password' ? ' selected' : ''}`} onClick={() => onModeChange('password')}>
            用户名密码
          </button>
        </div>

        {mode === 'device' ? (
          <label className="custom-field">
            <span className="ob-field-label">访问密钥</span>
            <input className="ob-input" value={secret} onChange={(event) => onSecretChange(event.target.value)} autoComplete="one-time-code" spellCheck={false} />
          </label>
        ) : (
          <>
            <label className="custom-field">
              <span className="ob-field-label">用户名</span>
              <input className="ob-input" value={username} onChange={(event) => onUsernameChange(event.target.value)} autoComplete="username" spellCheck={false} />
            </label>
            <label className="custom-field">
              <span className="ob-field-label">密码</span>
              <input className="ob-input" value={password} onChange={(event) => onPasswordChange(event.target.value)} type="password" autoComplete="current-password" />
            </label>
            <p className="onboarding-subtitle">远程明文链路不接收账号密码，避免把长期凭证暴露在局域网或 Tunnel 中。</p>
          </>
        )}

        {error && <div className="ob-status error">{error}</div>}
        <div className="onboarding-actions">
          <button className="ob-btn ob-btn-primary" type="submit" disabled={loginDisabled}>登录</button>
        </div>
      </form>
    </main>
  );
}

function closeMobileDrawers() {
  useStore.setState({ sidebarOpen: false, jianOpen: false });
}

function shouldIgnoreMobileEdgeGestureTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, button, [contenteditable="true"], [data-mobile-gesture-ignore="true"]'));
}

function principalHasRequiredScopes(principal: MobilePrincipal, requiredScopes: readonly string[]): boolean {
  const scopes = Array.isArray(principal.scopes) ? principal.scopes : [];
  return requiredScopes.every((scope) => scopeAllows(scopes, scope));
}

function scopeAllows(scopes: string[], required: string): boolean {
  if (scopes.includes(required)) return true;
  const [namespace] = required.split('.');
  return scopes.includes(namespace) || scopes.includes(`${namespace}.*`);
}

function useNarrowMobileViewport(): boolean {
  const [isNarrow, setIsNarrow] = useState(() => {
    if (typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(max-width: 860px)').matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(max-width: 860px)');
    const apply = () => setIsNarrow(media.matches);
    apply();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
    media.addListener(apply);
    return () => media.removeListener(apply);
  }, []);

  return isNarrow;
}

async function apiJson<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      detail = data.detail || data.error || detail;
    } catch {}
    throw new Error(detail);
  }
  return await res.json() as T;
}
