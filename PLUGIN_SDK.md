# Hana Plugin SDK

Hana's plugin SDK is split into small packages so plugin authors can choose only the layer they need.

| Package | Runs In | Purpose |
| --- | --- | --- |
| `@hana/plugin-protocol` | iframe / host | Shared protocol constants and message shapes for plugin UI. |
| `@hana/plugin-sdk` | iframe browser code | Typed helpers for `ready`, asset URLs, resize, toast, external links, clipboard, and lower-level host requests. |
| `@hana/plugin-runtime` | plugin Node runtime | Helpers for tools, lifecycle plugins, EventBus handlers, SessionFile media details, providers, and Pi SDK extensions. |
| `@hana/plugin-components` | iframe React UI | Hana-styled React primitives with theme fallback: controls, cards, rows, lists, and empty states. |

For the end-to-end plugin author workflow, read `.docs/PLUGIN-DEVELOPMENT.md` first, then use this file as the SDK package map.

Run `npm run build:packages` after SDK changes. The command builds all SDK packages and their `.d.ts` files:

```bash
npm run build:packages
```

## Runtime Boundary

The SDK packages are developer-facing source/build dependencies. The app package still excludes `packages/**`, so plugin UI code should bundle `@hana/plugin-sdk` and `@hana/plugin-components` into its iframe assets. Runtime helpers from `@hana/plugin-runtime` should be bundled or installed with the plugin when the plugin is distributed outside the monorepo.

Built-in plugins may use the same source patterns, but they should be checked against the packaged server bundle before release. The host does not silently provide these SDK packages as global runtime modules.

Plugin server code is installed and loaded by the Studio server. Plugin iframe assets are also served by that server; the desktop renderer, Mobile PWA, or browser client may cache them, but client locality must not decide whether a plugin surface, provider, task, config, or tool exists. Declare true client-machine-only actions separately from server workspace actions.

## Plugin Shape Guide

- Tool-only plugins usually need only `tools/*.js` and `@hana/plugin-runtime` helpers. They can stay `restricted`.
- Runtime plugins use `index.js` for lifecycle, EventBus handlers, background tasks, schedules, or dynamic tools. They require `trust: "full-access"`.
- UI plugins use iframe routes plus `@hana/plugin-sdk` and, for React UI, `@hana/plugin-components`. They require `trust: "full-access"` and explicit `ui.hostCapabilities` grants for host calls such as `external.open` or `clipboard.writeText`.
- Provider contribution plugins use `providers/*.js` declarations. They require `trust: "full-access"` and should declare `capabilities.chat` separately from `capabilities.media.*` so chat selectors stay clean while image, video, or speech tools discover media providers.
- Pi SDK extension plugins use `extensions/*.js` factories. They require `trust: "full-access"` because they run inside the LLM request pipeline. Hana reloads idle sessions after full-access plugin install/enable/reload so existing chats can pick up new extension handlers without requiring an app restart; busy sessions are not reloaded and will retain old extension handlers until the session is naturally rebuilt.
- Marketplace metadata lives outside the app repo in `OH-Plugins`, the official community plugin catalog. The app reads the generated catalog URL by default, installs `distribution.kind = "release"` entries by downloading the zip package and verifying `sha256`, and keeps `distribution.kind = "source"` for local file marketplace development only. `versions[]` lets the catalog keep multiple SemVer releases; Hana selects the highest app-compatible version, blocks implicit downgrades, backs up old installs, and records successful installs in `${HANA_HOME}/plugin-installs.json`. `readmePath` is resolved relative to the catalog when the official URL is used.

## Agent Dev Loop

Agent-assisted plugin work should use Hana's dev loop instead of copying work-in-progress code into the production plugin directory.

- Source stays in the workspace or `${HANA_HOME}/plugin-dev-sources/`.
- `plugin.dev.install` copies the source into `${HANA_HOME}/plugins-dev/<pluginId>` and loads it through the normal `PluginManager`.
- `plugin.dev.reload` replaces the dev copy from the same source slot.
- `plugin.dev.disable`, `plugin.dev.enable`, `plugin.dev.reset`, and `plugin.dev.uninstall` control only the remembered dev slot. They do not write normal plugin preferences and do not remove community installs.
- `plugin.dev.invokeTool` runs a tool smoke test with explicit input.
- `plugin.dev.diagnostics` returns dev slots, load status, logs, surfaces, and plugin diagnostics.
- `plugin.dev.listSurfaces` and `plugin.dev.describeSurfaceDebug` drive UI debugging.

Agent-callable dev tools are opt-in. The user must enable "Allow Agent plugin dev tools" in Settings -> Plugins before the Agent sees `plugin_dev_install`, `plugin_dev_reload`, `plugin_dev_disable`, `plugin_dev_enable`, `plugin_dev_reset`, `plugin_dev_uninstall`, `plugin_dev_invoke_tool`, `plugin_dev_diagnostics`, `plugin_dev_list_surfaces`, `plugin_dev_describe_surface`, or `plugin_dev_run_scenario`.

The trusted development identity comes from Hana's install record and the `${HANA_HOME}/plugins-dev/` slot, not from a manifest field. Pass `devRunId` when controlling lifecycle if the Agent has one, so stale tool calls cannot accidentally act on a newer dev run.

UI debugging is element-first. A capable Agent should inspect accessible elements, text, roles, labels, and stable locators before asking for screenshots. Screenshots are still useful for visual polish, clipping, theme contrast, and blank-state checks, but they are no longer the first source of truth when Hana can expose semantic UI structure.

## UI Path

Use `@hana/plugin-sdk` for host communication:

```ts
import { hana } from '@hana/plugin-sdk';

hana.ready();
hana.ui.resize({ height: 320 });
await hana.toast.show({ message: 'Ready' });
```

Use `hana.assets.url(path)` for browser-side references to files bundled under the plugin's `assets/` directory:

```ts
const logoUrl = hana.assets.url('images/logo.svg');
```

Hana uses a VS Code-like webview resource boundary. The iframe entry route is authenticated by the host, then the host issues a short-lived, HttpOnly cookie scoped only to `/api/plugins/{pluginId}/assets/`. Static JS, CSS, fonts, images, JSON, and wasm files are served from the plugin's own `assets/` directory through that path. Do not rely on `?token` or `pluginIframeTicket` being copied to Vite chunks, `React.lazy()` imports, modulepreload links, or CSS requests.

For a built UI, put compiled files under `assets/` and point the shell at the host-served resource URL:

```html
<script type="module" src="/api/plugins/my-plugin/assets/dist/app.js"></script>
```

Keep source files, secrets, config, and private data outside `assets/`. The host rejects path traversal, dotfiles, source maps, and non-web asset extensions by default. Use plugin routes or SDK host requests for dynamic data.

Use `@hana/plugin-components` for iframe UI:

```tsx
import { Button, CardShell, HanaThemeProvider } from '@hana/plugin-components';
import '@hana/plugin-components/styles.css';

export function Panel() {
  return (
    <HanaThemeProvider mode="inherit">
      <CardShell title="Plugin">
        <Button variant="primary">Run</Button>
      </CardShell>
    </HanaThemeProvider>
  );
}
```

Theme fallback order is:

1. Explicit custom tokens passed to `HanaThemeProvider`.
2. Named Hana tokens when `mode="hana"`.
3. Host CSS variables when `mode="inherit"`.
4. SDK defaults in `@hana/plugin-components/styles.css`.

## Runtime Path

Use `@hana/plugin-runtime` for Node-side plugin code:

```js
import {
  createAgent,
  createSession,
  definePlugin,
  defineTool,
  generateImage,
  registerTask,
  requestBus,
  sampleText,
  sendSessionMessage,
} from '@hana/plugin-runtime';
```

Tools should return local files through `stageFile()` and `createMediaDetails()` so desktop, Bridge, Mobile PWA, and future remote clients all consume the same `SessionFile` / Resource identity.

Scheduled automation plugin actions reuse plugin tools in v0. A cron executor saved as `plugin_action` with `{ pluginId, actionId, params }` maps to the loaded tool named `pluginId_actionId`. The scheduler stores only JSON data and invokes the tool at runtime; plugin-authored static `tools/*.js` tools and dynamic `ctx.registerTool()` tools both receive the SDK-style `(input, ctx)` call. If the plugin or tool is unavailable, the run fails explicitly and is recorded in cron history.

Lifecycle plugins should declare `activationEvents` in `manifest.json` when they do not need to start on app launch. Existing lifecycle plugins without this field still activate on startup for compatibility.

Long-running plugins should use the runtime task helpers (`registerTask`, `updateTask`, `completeTask`, `failTask`, `cancelTask`, `scheduleTask`) instead of hand-writing EventBus payloads.

### Runtime Session and Agent API

Plugins can use the same session-facing operations that Hana's own UI and server use, through typed runtime helpers:

```js
import {
  createAgent,
  createSession,
  getAgentProfile,
  listSessions,
  sendSessionMessage,
  subscribeSessionEvents,
} from '@hana/plugin-runtime';

const agent = await createAgent(ctx, {
  name: 'Tavern Character',
  visibility: 'plugin_private',
  memoryPolicy: { enabled: true },
});

const session = await createSession(ctx, {
  agentId: agent.agent.id,
  kind: 'tavern',
  visibility: 'plugin_private',
  memoryEnabled: true,
  cwd: ctx.dataDir,
});

await sendSessionMessage(ctx, session.sessionPath, {
  text: 'Hello',
  context: {
    beforeUser: [
      { label: 'world', text: 'The city is under moonlit rain.' },
      { label: 'mood', text: 'Keep the reply intimate and quiet.' },
    ],
  },
});

const off = subscribeSessionEvents(ctx, session.sessionPath, (event) => {
  ctx.log.debug('session event', event);
});
```

`context.system`, `context.beforeUser`, and `context.afterUser` are injected into the model request through Hana's Pi SDK context hook for that turn only. They do not change the visible user message and are cleared after the prompt finishes. Use this for plugin-side RAG, world lore, mood, or scene state.

`visibility: 'plugin_private'` keeps plugin-owned agents and sessions out of Hana's main agent/session lists by default. The owning plugin can list them with `listAgents(ctx, { ownerPluginId: ctx.pluginId })` or `listSessions(ctx, { ownerPluginId: ctx.pluginId })`.

### Runtime Model and Media API

Plugins can call the configured utility text model for routing, summaries, RAG query rewriting, and similar background work:

```js
const { text } = await sampleText(ctx, {
  operation: 'world-lore-query',
  messages: [{ role: 'user', content: 'Extract search keywords for this scene.' }],
  maxTokens: 120,
});
```

Media helpers expose Hana's configured provider stack. `listMediaProviders()` and `resolveMediaModel()` read configured image/video/speech-capable providers. `generateImage()` submits an image generation task through the built-in media task pipeline and returns a task/batch result; generated files are delivered as `SessionFile` resources when the task completes.

```js
const result = await generateImage(ctx, {
  sessionPath,
  prompt: 'A handwritten character card on warm paper',
  ratio: '3:2',
  resolution: '2k',
});
```

For Agent-assisted development, plugins can declare `manifest.dev.scenarios`. These are not runtime features; they are smoke-test instructions for Hana's dev loop and should only describe repeatable checks such as invoking a tool, expecting text in the result, or opening a declared UI surface.

Pi SDK extension factories live in `extensions/*.js` and are loaded only for full-access plugins:

```js
// extensions/request-audit.js
export default function(pi) {
  pi.on('before_provider_request', (event) => {
    event.payload.metadata = {
      ...(event.payload.metadata || {}),
      auditedBy: 'my-plugin',
    };
    return event.payload;
  });
}
```

Use extensions for request-pipeline hooks such as provider request rewriting, context filtering, and tool-call observation. Do not use them for ordinary tool behavior; a normal `tools/*.js` contribution is safer and can remain restricted.

Provider plugins can use `defineProvider()` for TypeScript-friendly authoring, then export named provider fields from `providers/*.js`:

```js
import { defineProvider } from '@hana/plugin-runtime';

const provider = defineProvider({
  id: 'my-image-cli',
  displayName: 'My Image CLI',
  authType: 'none',
  runtime: {
    kind: 'local-cli',
    protocolId: 'local-cli-media',
    command: {
      executable: 'my-image-cli',
      args: [
        { literal: 'generate' },
        { option: '--prompt', from: 'prompt' },
        { option: '--model', from: 'modelId' },
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
          id: 'my-image-model',
          displayName: 'My Image Model',
          protocolId: 'local-cli-media',
          inputs: ['text'],
          outputs: ['image'],
        }],
      },
    },
  },
});

export const { id, displayName, authType, runtime, capabilities } = provider;
```

CLI-backed providers must use structured argument bindings. Avoid shell command strings; the host runtime validates the contract and runs local commands through non-shell execution.

See `examples/plugins/sdk-showcase/` for a compact plugin that shows the current recommended shape.
