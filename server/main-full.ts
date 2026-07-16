/**
 * server/main-full.ts — full product composition entry (closed).
 *
 * The thin entry every current boot path spawns/imports to start the real
 * product server: `scripts/launch.js` (`npm run server`),
 * `scripts/dev-web.js` (`npm run dev:web`), `cli/server-runner.ts`'s
 * source-mode spawn, `desktop/main.cjs`'s dev-mode `HANA_SERVER_ENTRY`, and
 * `vite.config.server.js`'s build entry (packaged `bundle/index.js`, which
 * `server/bootstrap.ts` imports at runtime).
 *
 * It statically imports the open composition root's `startServer` export
 * plus the closed route registration hook, and calls one with the other —
 * no runtime switch, no env var: which composition boots is decided by
 * which entry file gets spawned, decided once at each boot path above.
 */
import { startServer } from "./index.ts";
import { registerClosedRoutes } from "./composition/full-root.ts";

await startServer({ registerClosedRoutes });
