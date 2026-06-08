/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeMock = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}));

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => storeMock.state,
  },
}));

import { takeArticleScreenshot, takeScreenshot } from '../../utils/screenshot';

describe('screenshot utils', () => {
  const notices: Array<{ text: string; type: string; deskDir?: string }> = [];
  const noticeHandler = (event: Event) => {
    notices.push((event as CustomEvent).detail);
  };

  beforeEach(() => {
    notices.length = 0;
    const storage = new Map<string, string>();
    storeMock.state = {
      homeFolder: '/tmp/hana-home',
      chatSessions: {},
      selectedIdsBySession: {},
      currentAgentId: null,
      agentName: 'Hana',
      userName: '我',
      beginScreenshotTask: vi.fn(),
      updateScreenshotProgress: vi.fn(),
      endScreenshotTask: vi.fn(),
    };
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
      clear: vi.fn(() => storage.clear()),
    });
    window.i18n = { locale: 'zh' } as typeof window.i18n;
    window.addEventListener('hana-inline-notice', noticeHandler);
    (window as any).t = (key: string) => (
      key === 'common.screenshotFailed' ? '截图保存失败'
        : key === 'common.screenshotSaved' ? '截图已保存'
          : key
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.removeEventListener('hana-inline-notice', noticeHandler);
    delete (window as any).hana;
    delete (window as any).t;
    delete (window as any).i18n;
  });

  it('主进程 IPC reject 时，给用户发出明确失败提示而不是变成未处理异常', async () => {
    (window as any).hana = {
      screenshotRender: vi.fn().mockRejectedValue(new Error('disk full')),
    };

    await expect(takeArticleScreenshot('# hello')).resolves.toBeUndefined();

    expect((window as any).hana.screenshotRender).toHaveBeenCalledOnce();
    expect(notices).toEqual([
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('disk full'),
      }),
    ]);
  });

  it('Markdown article screenshots carry source file context for relative attachments', async () => {
    (window as any).hana = {
      screenshotRender: vi.fn().mockResolvedValue({ success: true, dir: '/tmp/hana-home/截图' }),
    };

    await expect(takeArticleScreenshot('![](<文本附件/a.png>)', {
      filePath: '/vault/note.md',
      articleType: 'markdown',
    })).resolves.toBeUndefined();

    expect((window as any).hana.screenshotRender).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'article',
      markdown: '![](<文本附件/a.png>)',
      filePath: '/vault/note.md',
      articleType: 'markdown',
    }));
  });

  it('code article screenshots carry type and language so code files render as code blocks', async () => {
    (window as any).hana = {
      screenshotRender: vi.fn().mockResolvedValue({ success: true, dir: '/tmp/hana-home/截图' }),
    };

    await expect(takeArticleScreenshot('const x = 1;', {
      filePath: '/vault/app.ts',
      articleType: 'code',
      language: 'ts',
    })).resolves.toBeUndefined();

    expect((window as any).hana.screenshotRender).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'article',
      markdown: 'const x = 1;',
      filePath: '/vault/app.ts',
      articleType: 'code',
      language: 'ts',
    }));
  });

  it('screenshot font follows the reading font when no screenshot override is selected', async () => {
    localStorage.setItem('hana-font-serif', '0');
    (window as any).hana = {
      screenshotRender: vi.fn().mockResolvedValue({ success: true, dir: '/tmp/hana-home/截图' }),
    };

    await expect(takeArticleScreenshot('# hello')).resolves.toBeUndefined();

    expect((window as any).hana.screenshotRender).toHaveBeenCalledWith(expect.objectContaining({
      fontFamily: expect.stringContaining('Inter'),
    }));
  });

  it('screenshot font can override the reading font explicitly', async () => {
    localStorage.setItem('hana-font-serif', '0');
    localStorage.setItem('hana-screenshot-font', 'serif');
    (window as any).hana = {
      screenshotRender: vi.fn().mockResolvedValue({ success: true, dir: '/tmp/hana-home/截图' }),
    };

    await expect(takeArticleScreenshot('# hello')).resolves.toBeUndefined();

    expect((window as any).hana.screenshotRender).toHaveBeenCalledWith(expect.objectContaining({
      fontFamily: expect.stringContaining('Noto Serif SC'),
    }));
  });

  it('按截图页更新页码，并按选中的消息块数推进总进度', async () => {
    const sessionPath = '/session/a.jsonl';
    storeMock.state = {
      ...storeMock.state,
      selectedIdsBySession: {
        [sessionPath]: ['u1', 'a1', 'u2', 'a2'],
      },
      chatSessions: {
        [sessionPath]: {
          hasMore: false,
          loadingMore: false,
          items: [
            { type: 'message', data: { id: 'u1', role: 'user', text: '问'.repeat(6000) } },
            { type: 'message', data: { id: 'a1', role: 'assistant', blocks: [{ type: 'text', html: `<p>${'答'.repeat(6000)}</p>` }] } },
            { type: 'message', data: { id: 'u2', role: 'user', text: '再问'.repeat(3000) } },
            { type: 'message', data: { id: 'a2', role: 'assistant', blocks: [{ type: 'text', html: `<p>${'再答'.repeat(3000)}</p>` }] } },
          ],
        },
      },
    };
    (window as any).hana = {
      screenshotRender: vi.fn().mockResolvedValue({ success: true, dir: '/tmp/hana-home/截图' }),
      getServerPort: vi.fn().mockResolvedValue(null),
      getServerToken: vi.fn().mockResolvedValue(null),
    };

    await expect(takeScreenshot('u1', sessionPath)).resolves.toBeUndefined();

    expect(storeMock.state.beginScreenshotTask).toHaveBeenCalledWith({
      completedBlocks: 0,
      totalBlocks: 4,
      currentPage: 1,
      totalPages: 2,
    });
    expect(storeMock.state.updateScreenshotProgress).toHaveBeenCalledWith({ currentPage: 1 });
    expect(storeMock.state.updateScreenshotProgress).toHaveBeenCalledWith({ completedBlocks: 2 });
    expect(storeMock.state.updateScreenshotProgress).toHaveBeenCalledWith({ currentPage: 2 });
    expect(storeMock.state.updateScreenshotProgress).toHaveBeenCalledWith({ completedBlocks: 4 });
    expect(storeMock.state.endScreenshotTask).toHaveBeenCalledOnce();
    expect((window as any).hana.screenshotRender).toHaveBeenCalledTimes(2);
    expect((window as any).hana.screenshotRender).toHaveBeenNthCalledWith(1, expect.objectContaining({
      locale: 'zh',
      segmentIndex: 1,
      segmentTotal: 2,
    }));
    expect((window as any).hana.screenshotRender).toHaveBeenNthCalledWith(2, expect.objectContaining({
      segmentIndex: 2,
      segmentTotal: 2,
    }));
  });

  it('自定义头像缺失时，截图 payload 仍烧录普通聊天 UI 的默认头像', async () => {
    const sessionPath = '/session/default-avatars.jsonl';
    storeMock.state = {
      ...storeMock.state,
      currentAgentId: 'hana',
      agentName: 'Hana',
      agentYuan: 'hanako',
      userName: '唐',
      selectedIdsBySession: {
        [sessionPath]: ['u1', 'a1'],
      },
      chatSessions: {
        [sessionPath]: {
          hasMore: false,
          loadingMore: false,
          items: [
            { type: 'message', data: { id: 'u1', role: 'user', text: '你好' } },
            { type: 'message', data: { id: 'a1', role: 'assistant', blocks: [{ type: 'text', html: '<p>你好</p>' }] } },
          ],
        },
      },
    };

    const pngBlob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('assets/Hanako.png')) {
        return new Response(pngBlob, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    (window as any).hana = {
      screenshotRender: vi.fn().mockResolvedValue({ success: true, dir: '/tmp/hana-home/截图' }),
      getServerPort: vi.fn().mockResolvedValue(null),
      getServerToken: vi.fn().mockResolvedValue(null),
    };

    await expect(takeScreenshot('u1', sessionPath)).resolves.toBeUndefined();

    const payload = (window as any).hana.screenshotRender.mock.calls[0][0];
    expect(payload.messages[0].avatarDataUrl).toMatch(/^data:image\/svg\+xml/);
    expect(decodeURIComponent(payload.messages[0].avatarDataUrl)).toContain('唐');
    expect(payload.messages[1].avatarDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('assets/Hanako.png'));
  });

  it('用户消息截图 payload 保留非图片附件的语义块', async () => {
    const sessionPath = '/session/attachments.jsonl';
    storeMock.state = {
      ...storeMock.state,
      selectedIdsBySession: {
        [sessionPath]: ['u1'],
      },
      chatSessions: {
        [sessionPath]: {
          hasMore: false,
          loadingMore: false,
          items: [
            {
              type: 'message',
              data: {
                id: 'u1',
                role: 'user',
                text: '附件在这里',
                attachments: [
                  {
                    path: '/tmp/voice.wav',
                    name: 'voice.wav',
                    isDir: false,
                    mimeType: 'audio/wav',
                    presentation: 'voice-input',
                    listed: false,
                    waveform: {
                      version: 1,
                      peaks: [0.2, 0.7, 0.4],
                      durationMs: 1200,
                      source: 'computed',
                    },
                    transcription: {
                      status: 'ready',
                      text: '今晚我们先把语音输入跑通。',
                    },
                  },
                  { path: '/tmp/readme.md', name: 'readme.md', isDir: false, mimeType: 'text/markdown' },
                ],
              },
            },
          ],
        },
      },
    };
    (window as any).hana = {
      screenshotRender: vi.fn().mockResolvedValue({ success: true, dir: '/tmp/hana-home/截图' }),
      getServerPort: vi.fn().mockResolvedValue(null),
      getServerToken: vi.fn().mockResolvedValue(null),
    };

    await expect(takeScreenshot('u1', sessionPath)).resolves.toBeUndefined();

    const payload = (window as any).hana.screenshotRender.mock.calls[0][0];
    expect(payload.messages[0].blocks).toEqual([
      { type: 'markdown', content: '附件在这里' },
      {
        type: 'attachment',
        kind: 'audio',
        name: 'voice.wav',
        presentation: 'voice-input',
        waveform: {
          version: 1,
          peaks: [0.2, 0.7, 0.4],
          durationMs: 1200,
          source: 'computed',
        },
        transcription: {
          status: 'ready',
          text: '今晚我们先把语音输入跑通。',
        },
      },
      { type: 'attachment', kind: 'markdown', name: 'readme.md' },
    ]);
  });
});
