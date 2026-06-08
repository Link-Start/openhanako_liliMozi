import { describe, expect, it, vi } from 'vitest';
import {
  createMediaDetails,
  cancelTask,
  completeTask,
  defineBusHandler,
  defineCommand,
  defineExtension,
  definePlugin,
  defineProvider,
  defineTool,
  failTask,
  HANA_BUS_SKIP,
  createAgent,
  createSession,
  getAgentProfile,
  getSession,
  generateImage,
  listUsageEntries,
  listAgents,
  listMediaProviders,
  listSessions,
  resolveMediaModel,
  registerTask,
  requestBus,
  sampleText,
  scheduleTask,
  sendSessionMessage,
  subscribeSessionEvents,
  sessionFileToMediaItem,
  subscribeUsageEvents,
  unscheduleTask,
  updateTask,
  updateAgent,
  updateSession,
} from '@hana/plugin-runtime';

describe('plugin runtime SDK', () => {
  it('defines tools with stable fields and default parameters', async () => {
    const execute = vi.fn(async (input: { query: string }) => `search:${input.query}`);
    const tool = defineTool({
      name: 'search',
      description: 'Search things',
      execute,
    });

    expect(tool).toMatchObject({
      name: 'search',
      description: 'Search things',
      parameters: { type: 'object', properties: {} },
    });
    await expect(tool.execute({ query: 'hana' }, {} as any)).resolves.toBe('search:hana');
  });

  it('defines commands with stable slash fields', async () => {
    const handler = vi.fn(async () => ({ reply: 'pong' }));
    const command = defineCommand({
      name: 'ping',
      aliases: ['p'],
      description: 'Ping command',
      permission: 'anyone',
      scope: 'session',
      handler,
    });

    expect(command).toMatchObject({
      name: 'ping',
      aliases: ['p'],
      description: 'Ping command',
      permission: 'anyone',
      scope: 'session',
    });
    await expect(command.handler?.({} as any)).resolves.toEqual({ reply: 'pong' });
  });

  it('defines providers without altering provider metadata', () => {
    const provider = defineProvider({
      id: 'demo-provider',
      displayName: 'Demo Provider',
      authType: 'none',
      runtime: {
        kind: 'local-cli',
        protocolId: 'local-cli-media',
        command: {
          executable: 'demo-image-cli',
          args: [
            { literal: 'generate' },
            { option: '--prompt', from: 'prompt' },
            { option: '--output', from: 'outputDir' },
          ],
          timeoutMs: 120000,
          output: { kind: 'file_glob', directory: 'outputDir', pattern: '*.png' },
        },
      },
      capabilities: {
        chat: { projection: 'none' },
        media: {
          imageGeneration: {
            models: [{
              id: 'demo-image',
              displayName: 'Demo Image',
              protocolId: 'local-cli-media',
              inputs: ['text'],
              outputs: ['image'],
            }],
          },
        },
      },
    });

    expect(provider).toEqual({
      id: 'demo-provider',
      displayName: 'Demo Provider',
      authType: 'none',
      runtime: {
        kind: 'local-cli',
        protocolId: 'local-cli-media',
        command: {
          executable: 'demo-image-cli',
          args: [
            { literal: 'generate' },
            { option: '--prompt', from: 'prompt' },
            { option: '--output', from: 'outputDir' },
          ],
          timeoutMs: 120000,
          output: { kind: 'file_glob', directory: 'outputDir', pattern: '*.png' },
        },
      },
      capabilities: {
        chat: { projection: 'none' },
        media: {
          imageGeneration: {
            models: [{
              id: 'demo-image',
              displayName: 'Demo Image',
              protocolId: 'local-cli-media',
              inputs: ['text'],
              outputs: ['image'],
            }],
          },
        },
      },
    });
  });

  it('defines extensions as direct Pi SDK factories', () => {
    const factory = vi.fn();
    const extension = defineExtension(factory);
    const pi = {};

    extension(pi);

    expect(factory).toHaveBeenCalledWith(pi);
  });

  it('defines lifecycle plugins compatible with PluginManager injection', async () => {
    const disposable = vi.fn();
    const onload = vi.fn((_ctx, helpers) => {
      helpers.register(disposable);
    });
    const onunload = vi.fn();
    const PluginClass = definePlugin({ onload, onunload });
    const instance = new PluginClass();
    const register = vi.fn();
    const ctx = { pluginId: 'demo', dataDir: '/tmp/demo' };

    instance.ctx = ctx as any;
    instance.register = register;
    if (!instance.onload || !instance.onunload) {
      throw new Error('definePlugin must create lifecycle methods');
    }
    await instance.onload();
    await instance.onunload();

    expect(onload).toHaveBeenCalledWith(ctx, { register });
    expect(register).toHaveBeenCalledWith(disposable);
    expect(onunload).toHaveBeenCalledWith(ctx);
  });

  it('defines bus handlers without hiding EventBus ownership', async () => {
    const handle = vi.fn(async (payload: { text: string }) => ({ ok: payload.text === 'hello' }));
    const handler = defineBusHandler({
      type: 'bridge:send',
      handle,
    });
    const ctx = { pluginId: 'demo' };

    await expect(handler.handle({ text: 'hello' }, ctx as any)).resolves.toEqual({ ok: true });
    expect(handler.type).toBe('bridge:send');
    expect(handle).toHaveBeenCalledWith({ text: 'hello' }, ctx);
  });

  it('exports the shared EventBus SKIP symbol for chained handlers', () => {
    expect(HANA_BUS_SKIP).toBe(Symbol.for('hana.event-bus.skip'));
  });

  it('requests bus handlers through the context bus with explicit payload and options', async () => {
    const request = vi.fn(async () => ({ sent: true }));
    const ctx = {
      bus: { request },
    };

    await expect(
      requestBus(ctx as any, 'session:send', { text: 'hello' }, { timeoutMs: 5000 }),
    ).resolves.toEqual({ sent: true });

    expect(request).toHaveBeenCalledWith('session:send', { text: 'hello' }, { timeoutMs: 5000 });
  });

  it('wraps session, agent, model, and media bus calls with typed helpers', async () => {
    const unsubscribe = vi.fn();
    const request = vi.fn(async (type: string, payload: unknown) => {
      if (type === 'session:create') return { sessionPath: '/s/new.jsonl', agentId: 'agent-a' };
      if (type === 'session:get') return { session: { path: (payload as any).sessionPath } };
      if (type === 'session:list') return { sessions: [] };
      if (type === 'session:update') return { ok: true, session: { path: (payload as any).sessionPath } };
      if (type === 'session:send') return { accepted: true, sessionPath: (payload as any).sessionPath };
      if (type === 'agent:list') return { agents: [] };
      if (type === 'agent:profile') return { profile: { id: (payload as any).agentId, name: 'A' } };
      if (type === 'agent:create') return { agent: { id: 'plugin-agent', name: 'Plugin Agent' } };
      if (type === 'agent:update') return { ok: true, agent: { id: (payload as any).agentId } };
      if (type === 'model:sample-text') return { text: 'sample' };
      if (type === 'provider:media-providers') return { providers: {} };
      if (type === 'provider:resolve-media-model') return { providerId: 'openai', modelId: 'gpt-image-1', protocolId: 'openai-images' };
      if (type === 'media:generate-image') return { ok: true, batchId: 'batch-1' };
      throw new Error(type);
    });
    const subscribe = vi.fn(() => unsubscribe);
    const ctx = { pluginId: 'tavern', bus: { request, subscribe } };

    await createSession(ctx as any, { agentId: 'agent-a', kind: 'tavern', visibility: 'plugin_private' });
    await getSession(ctx as any, '/s/new.jsonl');
    await listSessions(ctx as any, { ownerPluginId: 'tavern' });
    await updateSession(ctx as any, '/s/new.jsonl', { pinned: true });
    await sendSessionMessage(ctx as any, '/s/new.jsonl', {
      text: 'hello',
      context: { beforeUser: 'world lore' },
    });
    subscribeSessionEvents(ctx as any, '/s/new.jsonl', () => {});
    await listAgents(ctx as any, { includePluginPrivate: true });
    await getAgentProfile(ctx as any, 'agent-a');
    await createAgent(ctx as any, { name: 'Plugin Agent', visibility: 'plugin_private' });
    await updateAgent(ctx as any, 'plugin-agent', { visibility: 'public' });
    await sampleText(ctx as any, { messages: [{ role: 'user', content: 'sample' }] });
    await listMediaProviders(ctx as any, { capability: 'image_generation' });
    await resolveMediaModel(ctx as any, { providerId: 'openai', modelId: 'gpt-image-1' });
    await generateImage(ctx as any, { sessionPath: '/s/new.jsonl', prompt: 'a quiet room' });

    expect(request).toHaveBeenCalledWith('session:create', {
      agentId: 'agent-a',
      kind: 'tavern',
      visibility: 'plugin_private',
      ownerPluginId: 'tavern',
    }, undefined);
    expect(request).toHaveBeenCalledWith('session:send', {
      sessionPath: '/s/new.jsonl',
      text: 'hello',
      context: { beforeUser: 'world lore', metadata: { pluginId: 'tavern' } },
    }, undefined);
    expect(subscribe).toHaveBeenCalledWith(expect.any(Function), {
      sessionPath: '/s/new.jsonl',
    });
    expect(request).toHaveBeenCalledWith('agent:create', {
      name: 'Plugin Agent',
      visibility: 'plugin_private',
      ownerPluginId: 'tavern',
    }, undefined);
    expect(request).toHaveBeenCalledWith('media:generate-image', {
      sessionPath: '/s/new.jsonl',
      prompt: 'a quiet room',
      pluginId: 'tavern',
    }, undefined);
  });

  it('wraps task bus calls with typed helper payloads', async () => {
    const request = vi.fn(async (type: string) => {
      if (type === 'task:cancel') return { result: 'aborted', canceled: true };
      if (type === 'task:schedule') return { ok: true, schedule: { scheduleId: 'daily', type: 'digest' } };
      if (type === 'task:unschedule') return { ok: true, removed: true };
      return { ok: true, task: { taskId: 't1', type: 'render', status: 'running' } };
    });
    const ctx = { bus: { request } };

    await registerTask(ctx as any, { taskId: 't1', type: 'render', parentSessionPath: '/s/a' });
    await updateTask(ctx as any, { taskId: 't1', progress: { current: 1, total: 2 } });
    await completeTask(ctx as any, 't1', { ok: true });
    await failTask(ctx as any, 't1', 'nope');
    await cancelTask(ctx as any, 't1', 'user');
    await scheduleTask(ctx as any, { scheduleId: 'daily', type: 'digest', intervalMs: 60_000 });
    await unscheduleTask(ctx as any, 'daily');

    expect(request).toHaveBeenCalledWith('task:register', { taskId: 't1', type: 'render', parentSessionPath: '/s/a' }, undefined);
    expect(request).toHaveBeenCalledWith('task:update', { taskId: 't1', progress: { current: 1, total: 2 } }, undefined);
    expect(request).toHaveBeenCalledWith('task:complete', { taskId: 't1', result: { ok: true } }, undefined);
    expect(request).toHaveBeenCalledWith('task:fail', { taskId: 't1', error: 'nope' }, undefined);
    expect(request).toHaveBeenCalledWith('task:cancel', { taskId: 't1', reason: 'user' }, undefined);
    expect(request).toHaveBeenCalledWith('task:schedule', { scheduleId: 'daily', type: 'digest', intervalMs: 60_000 }, undefined);
    expect(request).toHaveBeenCalledWith('task:unschedule', { scheduleId: 'daily' }, undefined);
  });

  it('wraps usage list and live usage subscriptions with typed helpers', async () => {
    const request = vi.fn(async () => ({
      entries: [{ requestId: 'req-1', schemaVersion: 1 }],
      nextCursor: null,
    }));
    const subscribe = vi.fn((callback: (event: unknown, sessionPath?: string | null) => void, filter?: unknown) => {
      callback({ type: 'llm_usage', entry: { requestId: 'req-2' } }, '/sessions/a.jsonl');
      return () => {};
    });
    const ctx = { bus: { request, subscribe } };
    const events: unknown[] = [];

    await expect(listUsageEntries(ctx as any, { limit: 25 })).resolves.toEqual({
      entries: [{ requestId: 'req-1', schemaVersion: 1 }],
      nextCursor: null,
    });
    subscribeUsageEvents(ctx as any, (entry, meta) => {
      events.push({ entry, meta });
    });

    expect(request).toHaveBeenCalledWith('usage:list', { limit: 25 }, undefined);
    expect(subscribe).toHaveBeenCalledWith(expect.any(Function), { types: ['llm_usage'] });
    expect(events).toEqual([
      { entry: { requestId: 'req-2' }, meta: { sessionPath: '/sessions/a.jsonl' } },
    ]);
  });

  it('converts SessionFile records into structured media items', () => {
    expect(sessionFileToMediaItem({
      id: 'sf_1',
      fileId: 'sf_file_id',
      sessionPath: '/sessions/demo.jsonl',
      filePath: '/tmp/demo.png',
      displayName: 'demo image',
      mime: 'image/png',
      kind: 'image',
    })).toEqual({
      type: 'session_file',
      fileId: 'sf_file_id',
      sessionPath: '/sessions/demo.jsonl',
      filePath: '/tmp/demo.png',
      label: 'demo image',
      mime: 'image/png',
      kind: 'image',
    });
  });

  it('requires SessionFile media items to carry an explicit file identity', () => {
    expect(() => sessionFileToMediaItem({
      sessionPath: '/sessions/demo.jsonl',
      filePath: '/tmp/demo.png',
    })).toThrow('SessionFile media item requires id or fileId');
  });

  it('creates media details from staged files, media items, and SessionFile records', () => {
    expect(createMediaDetails([
      { mediaItem: { type: 'session_file', fileId: 'sf_staged', sessionPath: '/sessions/demo.jsonl' } },
      { type: 'session_file', fileId: 'sf_direct', sessionPath: '/sessions/demo.jsonl' },
      { id: 'sf_record', sessionPath: '/sessions/demo.jsonl', filename: 'result.txt' },
    ])).toEqual({
      media: {
        items: [
          { type: 'session_file', fileId: 'sf_staged', sessionPath: '/sessions/demo.jsonl' },
          { type: 'session_file', fileId: 'sf_direct', sessionPath: '/sessions/demo.jsonl' },
          {
            type: 'session_file',
            fileId: 'sf_record',
            sessionPath: '/sessions/demo.jsonl',
            label: 'result.txt',
          },
        ],
      },
    });
  });
});
