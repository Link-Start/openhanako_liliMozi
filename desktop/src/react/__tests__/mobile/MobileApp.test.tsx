// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { MobileApp } from '../../mobile/MobileApp';
import registry from '../../../shared/theme-registry';

vi.mock('../../components/InputArea', async () => {
  const ReactModule = await import('react');
  return {
    InputArea: ({ surface }: { surface?: string }) => ReactModule.createElement('div', {
      'data-testid': 'desktop-input-area',
      'data-surface': surface || 'desktop',
      contentEditable: true,
      role: 'textbox',
      tabIndex: 0,
    }),
  };
});

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }
}

describe('MobileApp', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    MockWebSocket.instances = [];
    document.documentElement.removeAttribute('data-platform');
    resetStoreForMobileTest();
    window.t = ((key: string) => key) as typeof window.t;
    window.i18n = {
      locale: 'zh',
      defaultName: 'Hanako',
      _data: {},
      _agentOverrides: {},
      load: vi.fn(async function load(this: typeof window.i18n, locale: string) {
        this.locale = locale.startsWith('zh') ? 'zh' : locale;
      }),
      setAgentOverrides: vi.fn(),
      t: (key: string) => key,
    };
    window.setTheme = vi.fn();
    window.setSerifFont = vi.fn();
    window.setPaperTexture = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the access-key login when no browser session exists', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ authenticated: false, principal: null }));

    render(<MobileApp />);

    expect(await screen.findByText('手机访问 Hana')).toBeInTheDocument();
    expect(screen.getByLabelText('访问密钥')).toBeInTheDocument();
  });

  it('can submit a username and password login without sending a device credential', async () => {
    let sessionCalls = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        sessionCalls += 1;
        return Promise.resolve(jsonResponse(sessionCalls === 1
          ? { authenticated: false, principal: null }
          : { authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write'], 'password') }));
      }
      if (url.includes('/api/web-auth/login')) return Promise.resolve(jsonResponse({ ok: true }));
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);

    fireEvent.click(await screen.findByRole('tab', { name: '用户名密码' }));
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'hana-owner' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => {
      const loginCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/api/web-auth/login'));
      expect(loginCall).toBeTruthy();
      const body = JSON.parse(String(loginCall?.[1]?.body));
      expect(body).toEqual({ username: 'hana-owner', password: 'secret-password' });
      expect(body).not.toHaveProperty('credential');
    });
  });

  it('returns stale browser sessions without file scopes to login', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat']) }));
      }
      if (url.includes('/api/web-auth/logout')) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url)));
    });

    render(<MobileApp />);

    expect(await screen.findByText('手机访问 Hana')).toBeInTheDocument();
    expect(screen.getByText('当前登录缺少工作台权限，请重新输入访问密钥。')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/web-auth/logout', expect.objectContaining({
      method: 'POST',
    }));
  });

  it('returns stale browser sessions without resource scope to login', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'files.read', 'files.write']) }));
      }
      if (url.includes('/api/web-auth/logout')) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url)));
    });

    render(<MobileApp />);

    expect(await screen.findByText('手机访问 Hana')).toBeInTheDocument();
    expect(screen.getByText('当前登录缺少工作台权限，请重新输入访问密钥。')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/web-auth/logout', expect.objectContaining({
      method: 'POST',
    }));
  });

  it('loads chat sessions, desktop input surface, and workbench files for an authenticated phone', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);

    expect(await waitForMobileChatReady()).toHaveTextContent('日常记录');
    expect(screen.getByTestId('desktop-input-area')).toHaveAttribute('data-surface', 'mobile');
    expect(document.querySelector('.titlebar')).toBeInTheDocument();
    expect(titlebarNewSessionButton()).toHaveAttribute('data-mobile-titlebar-action', 'new-session');
    expect(screen.getByLabelText('titlebar.currentChatTitle')).toHaveTextContent('日常记录');
    expect(document.querySelector('.sidebar')).toBeInTheDocument();
    expect(document.querySelector('.jian-sidebar')).toBeInTheDocument();
    expect(useStore.getState().homeFolder).toBe('/workspace');
    expect(useStore.getState().selectedFolder).toBe('/workspace');
    expect(useStore.getState().agents[0]).toMatchObject({
      id: 'hana',
      homeFolder: '/workspace',
      chatModel: { id: 'deepseek-chat', provider: 'deepseek' },
    });
    fireEvent.click(screen.getByTitle('sidebar.jian'));
    expect(await screen.findByText('note.md')).toBeInTheDocument();
  });

  it('opens workbench files through the mobile content route using the desktop preview panel', async () => {
    document.documentElement.setAttribute('data-platform', 'web');
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);

    await waitForMobileChatReady();
    fireEvent.click(screen.getByTitle('sidebar.jian'));
    fireEvent.click(await screen.findByRole('treeitem', { name: /note\.md/ }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => {
        const url = String(input);
        return url.includes('/api/mobile/workbench/content')
          && url.includes('name=note.md')
          && url.includes('rootId=default');
      })).toBe(true);
      expect(useStore.getState().previewOpen).toBe(true);
      expect(useStore.getState().previewItems.some(item => item.content.includes('来自手机工作台预览'))).toBe(true);
    });
  });

  it('uses the desktop new-session draft flow on mobile instead of creating an empty session immediately', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    fireEvent.click(titlebarNewSessionButton());

    expect(useStore.getState().pendingNewSession).toBe(true);
    expect(useStore.getState().welcomeVisible).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/sessions/new'))).toBe(false);
    expect(screen.getByLabelText('titlebar.currentChatTitle')).toHaveTextContent('sidebar.newChat');
  });

  it('leaves mobile keyboard viewport handling to the browser', async () => {
    stubNarrowViewport(true);
    const viewport = installVisualViewportStub({ height: 700, offsetTop: 0 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    const shell = mobileShell();
    expect(shell).not.toHaveAttribute('data-mobile-keyboard-open');
    expect(shell.style.getPropertyValue('--mobile-layout-height')).toBe('');
    expect(shell.style.getPropertyValue('--mobile-keyboard-offset')).toBe('');

    fireEvent.focusIn(screen.getByTestId('desktop-input-area'));
    viewport.height = 420;
    act(() => {
      viewport.dispatchEvent(new Event('resize'));
    });

    expect(shell).not.toHaveAttribute('data-mobile-keyboard-open');
    expect(shell.style.getPropertyValue('--mobile-layout-height')).toBe('');
    expect(shell.style.getPropertyValue('--mobile-keyboard-offset')).toBe('');
  });

  it('renders server-broadcast user messages through the desktop websocket handler', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);

    await waitForMobileChatReady();
    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'session_user_message',
          sessionPath: '/hana/sessions/one.jsonl',
          message: { id: 'u-mobile-1', text: '手机端发来的消息' },
        }),
      } as MessageEvent);
    });

    expect(await screen.findAllByText('手机端发来的消息')).not.toHaveLength(0);
  });

  it('shows server-created sessions from another LAN client without waiting for a refetch payload', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);

    await waitForMobileChatReady();
    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'session_created',
          sessionPath: '/hana/sessions/from-desktop.jsonl',
          session: {
            path: '/hana/sessions/from-desktop.jsonl',
            title: '电脑新会话',
            firstMessage: 'desktop created',
            modified: '2026-05-16T12:00:00.000Z',
            messageCount: 1,
            agentId: 'hana',
            agentName: 'Hana',
            cwd: '/workspace',
          },
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(useStore.getState().sessions.some(session => session.path === '/hana/sessions/from-desktop.jsonl')).toBe(true);
      expect(screen.getByText('电脑新会话')).toBeInTheDocument();
    });
  });

  it('opens the session drawer from a left-edge swipe on narrow mobile', async () => {
    stubNarrowViewport(true);
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    await waitFor(() => expect(useStore.getState().sidebarOpen).toBe(false));

    fireEvent.touchStart(mobileShell(), {
      touches: [{ clientX: 8, clientY: 220 }],
    });
    fireEvent.touchMove(mobileShell(), {
      touches: [{ clientX: 78, clientY: 228 }],
    });
    fireEvent.touchEnd(mobileShell(), {
      changedTouches: [{ clientX: 82, clientY: 230 }],
    });

    expect(useStore.getState().sidebarOpen).toBe(true);
    expect(useStore.getState().jianOpen).toBe(false);
  });

  it('opens the workbench drawer from a right-edge swipe on narrow mobile', async () => {
    stubNarrowViewport(true);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    await waitFor(() => expect(useStore.getState().jianOpen).toBe(false));

    fireEvent.touchStart(mobileShell(), {
      touches: [{ clientX: 382, clientY: 220 }],
    });
    fireEvent.touchMove(mobileShell(), {
      touches: [{ clientX: 305, clientY: 226 }],
    });
    fireEvent.touchEnd(mobileShell(), {
      changedTouches: [{ clientX: 300, clientY: 228 }],
    });

    expect(useStore.getState().jianOpen).toBe(true);
    expect(useStore.getState().sidebarOpen).toBe(false);
  });

  it('does not open mobile drawers from non-edge swipes', async () => {
    stubNarrowViewport(true);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    await waitFor(() => expect(useStore.getState().sidebarOpen).toBe(false));

    fireEvent.touchStart(mobileShell(), {
      touches: [{ clientX: 120, clientY: 220 }],
    });
    fireEvent.touchMove(mobileShell(), {
      touches: [{ clientX: 200, clientY: 225 }],
    });
    fireEvent.touchEnd(mobileShell(), {
      changedTouches: [{ clientX: 205, clientY: 225 }],
    });

    expect(useStore.getState().sidebarOpen).toBe(false);
    expect(useStore.getState().jianOpen).toBe(false);
  });
});

function principal(scopes: string[], credentialKind = 'device_credential') {
  return {
    kind: credentialKind === 'password' ? 'account_user' : 'device',
    credentialKind,
    connectionKind: 'lan',
    trustState: 'lan',
    serverId: 'server_1',
    userId: 'user_1',
    studioId: 'studio_1',
    scopes,
  };
}

function jsonResponseForMobile(url: string, _options?: RequestInit): unknown {
  if (url.includes('/api/server/identity')) {
    return {
      serverId: 'server_1',
      userId: 'user_1',
      studioId: 'studio_1',
      label: 'Hana Studio',
      studioLabel: 'Hana Studio',
      userLabel: 'Owner',
      connectionKind: 'local',
      trustState: 'local',
      credentialKind: 'loopback_token',
      capabilities: ['chat', 'resources', 'files'],
    };
  }
  if (url.includes('/api/mobile/bootstrap')) {
    return {
      locale: 'zh-CN',
      agentName: 'Hana',
      userName: 'Owner',
      currentAgentId: 'hana',
      agentYuan: 'hanako',
      homeFolder: '/workspace',
      cwdHistory: ['/workspace'],
      avatars: { agent: false, user: false },
      agents: [{
        id: 'hana',
        name: 'Hana',
        yuan: 'hanako',
        isPrimary: true,
        hasAvatar: false,
        homeFolder: '/workspace',
        chatModel: { id: 'deepseek-chat', provider: 'deepseek' },
      }],
      appearance: { theme: registry.DEFAULT_THEME, serif: true, paperTexture: false },
    };
  }
  if (url.includes('/api/models')) {
    return { models: [{ id: 'deepseek-chat', name: 'DeepSeek', provider: 'deepseek', isCurrent: true }], activeModel: null };
  }
  if (url.includes('/api/desk/files')) {
    return {
      basePath: '/workspace',
      subdir: '',
      files: [{ name: 'note.md', isDir: false, size: 12, mtime: '2026-05-16T00:00:00.000Z' }],
    };
  }
  if (url.includes('/api/mobile/workbench/content')) {
    return '# Mobile Note\n\n来自手机工作台预览';
  }
  if (url.includes('/api/desk/jian')) {
    return { content: null };
  }
  if (url.includes('/api/sessions/messages')) {
    return { messages: [], blocks: [], todos: [], hasMore: false, sessionFiles: [] };
  }
  if (url.includes('/api/sessions')) {
    return [
      { path: '/hana/sessions/one.jsonl', title: '日常记录', firstMessage: '', modified: '2026-05-16T00:00:00.000Z', messageCount: 2, agentId: 'hana', agentName: 'Hana', cwd: '/workspace' },
    ];
  }
  return {};
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data,
    text: async () => typeof data === 'string' ? data : JSON.stringify(data),
    headers: new Headers(),
  } as Response;
}

function stubNarrowViewport(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

function installVisualViewportStub({
  height,
  offsetTop,
}: {
  height: number;
  offsetTop: number;
}): EventTarget & { height: number; width: number; offsetTop: number; offsetLeft: number; scale: number } {
  const viewport = new EventTarget() as EventTarget & {
    height: number;
    width: number;
    offsetTop: number;
    offsetLeft: number;
    scale: number;
  };
  viewport.height = height;
  viewport.width = 390;
  viewport.offsetTop = offsetTop;
  viewport.offsetLeft = 0;
  viewport.scale = 1;
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  });
  return viewport;
}

function mobileShell(): HTMLElement {
  const shell = document.querySelector<HTMLElement>('.mobile-desktop-root');
  if (!shell) throw new Error('mobile shell not found');
  return shell;
}

function titlebarNewSessionButton(): HTMLElement {
  const button = document.querySelector<HTMLElement>('[data-mobile-titlebar-action="new-session"]');
  if (!button) throw new Error('mobile titlebar new-session button not found');
  return button;
}

async function waitForMobileChatReady(): Promise<HTMLElement> {
  return await screen.findByLabelText('titlebar.currentChatTitle');
}

function resetStoreForMobileTest(): void {
  useStore.setState({
    serverPort: null,
    serverToken: null,
    serverConnections: {},
    activeServerConnectionId: null,
    activeServerConnection: null,
    connected: false,
    wsState: 'disconnected',
    sessions: [],
    currentSessionPath: null,
    pendingSessionSwitchPath: null,
    pendingNewSession: false,
    chatSessions: {},
    sessionRegistryFilesByPath: {},
    sessionModelsByPath: {},
    _loadMessagesVersion: {},
    streamingSessions: [],
    previewItems: [],
    openTabs: [],
    activeTabId: null,
    previewOpen: false,
    agents: [],
    currentAgentId: null,
    agentName: 'Hanako',
    userName: 'User',
    agentAvatarUrl: null,
    userAvatarUrl: null,
    models: [],
    currentModel: null,
    locale: 'zh',
    currentTab: 'chat',
    sidebarOpen: true,
    jianOpen: false,
    jianAutoCollapsed: false,
    sidebarAutoCollapsed: false,
    deskBasePath: '',
    deskCurrentPath: '',
    deskFiles: [],
    deskTreeFilesByPath: {},
    deskExpandedPaths: [],
    deskDirtyTreePaths: [],
    deskSelectedPath: '',
    deskJianContent: null,
    cwdSkills: [],
    cwdSkillsOpen: false,
    jianDrawerOpen: false,
    rightWorkspaceTab: 'workspace',
    jianView: 'desk',
    activePanel: null,
  });
}
