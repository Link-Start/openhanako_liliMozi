# @hana/plugin-sdk

Browser-side SDK for Hana iframe plugins.

```ts
import { hana } from '@hana/plugin-sdk';

hana.ready();
const logoUrl = hana.assets.url('images/logo.svg');
hana.ui.resize({ height: 320 });

await hana.toast.show({ message: 'Saved', type: 'success' });
await hana.external.open('https://example.com');
await hana.clipboard.writeText('Copied text');
```

## Assets

Use `hana.assets.url(path)` for files bundled under the plugin's `assets/` directory:

```ts
const js = hana.assets.url('dist/app.js');
const logo = hana.assets.url('/images/logo.svg');
```

The helper returns `/api/plugins/{pluginId}/assets/{path}` for the current iframe plugin. It accepts only relative, non-dotfile paths. Hana serves these resources through a path-scoped, HttpOnly asset session cookie, so Vite chunks, lazy imports, CSS, fonts, images, JSON, and wasm files should live under `assets/`. Do not put secrets, source files, or source maps in that directory.

## Host Requests

Stable helpers are thin wrappers around `hana.host.request(type, payload)`.

| Helper | Capability | Grant |
| --- | --- | --- |
| `hana.toast.show(input)` | `toast.show` | no |
| `hana.external.open(input)` | `external.open` | yes |
| `hana.clipboard.writeText(input)` | `clipboard.writeText` | yes |

Grant-required capabilities must be declared in `manifest.json`:

```json
{
  "manifestVersion": 1,
  "ui": {
    "hostCapabilities": ["external.open", "clipboard.writeText"]
  }
}
```

## Theme

Use `hana.theme.getSnapshot()` for initial theme data and `hana.theme.subscribe(callback)` for host theme updates. The host also passes `hana-theme` and `hana-css` query parameters for compatibility with simple iframe pages.
