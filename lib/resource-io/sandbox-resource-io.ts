import fs from "fs";
import path from "path";
import { deriveSandboxPolicy } from "../sandbox/policy.ts";
import { PathGuard } from "../sandbox/path-guard.ts";
import { createManagedConfigWriteGuard } from "../sandbox/managed-config-guard.ts";
import { LocalFsProvider } from "./providers/local-fs-provider.ts";
import { MountProvider } from "./providers/mount-provider.ts";
import { ResourceProvider } from "./providers/resource-provider.ts";
import { SessionFileResolverProvider } from "./providers/session-file-resolver.ts";
import { UrlProvider } from "./providers/url-provider.ts";
import { ResourceEventBus } from "./resource-event-bus.ts";
import { ResourceIO } from "./resource-io.ts";

type Options = {
  cwd: string;
  agentDir: string;
  workspace?: string | null;
  workspaceFolders?: string[];
  authorizedFolders?: string[];
  getAuthorizedFolders?: () => string[];
  hanakoHome: string;
  getSandboxEnabled?: () => boolean;
  getExternalReadPaths?: () => string[];
  getSessionPath?: () => string | null;
  emitEvent?: (event: object, sessionPath?: string | null) => void;
  sessionFiles?: any;
  resourceService?: any;
  studioId?: string | null;
  urlMaterializeRoot?: string;
};

export function createSandboxResourceIO({
  cwd,
  agentDir,
  workspace,
  workspaceFolders = [],
  authorizedFolders = [],
  getAuthorizedFolders,
  hanakoHome,
  getSandboxEnabled,
  getExternalReadPaths,
  getSessionPath,
  emitEvent,
  sessionFiles,
  resourceService,
  studioId,
  urlMaterializeRoot,
}: Options) {
  const resolveAuthorizedFolders = () => {
    if (typeof getAuthorizedFolders === "function") {
      const folders = getAuthorizedFolders();
      return Array.isArray(folders) ? folders : [];
    }
    return Array.isArray(authorizedFolders) ? authorizedFolders : [];
  };
  const makePolicy = () => deriveSandboxPolicy({
    agentDir,
    cwd,
    workspace,
    workspaceFolders: [
      ...(Array.isArray(workspaceFolders) ? workspaceFolders : []),
      ...resolveAuthorizedFolders(),
    ],
    hanakoHome,
    mode: "standard",
  });
  const pathGuard = {
    check: (absolutePath, operation) => new PathGuard(makePolicy()).check(absolutePath, operation),
  };
  const checkManagedConfigWrite = createManagedConfigWriteGuard({ hanakoHome });
  const resourceAccessGuard = {
    check: (absolutePath, operation) => {
      const managedConfigCheck = checkManagedConfigWrite(absolutePath, operation);
      if (!managedConfigCheck.allowed) return managedConfigCheck;
      if (typeof getSandboxEnabled === "function" && !getSandboxEnabled()) return { allowed: true };
      const result = pathGuard.check(absolutePath, operation);
      if (result.allowed) return result;
      if (operation === "read" && hasExternalReadGrant(absolutePath, { getExternalReadPaths })) {
        return { allowed: true };
      }
      return result;
    },
  };

  const localFsProviderFactory = ({ cwd: providerCwd, guard }) => new LocalFsProvider({ cwd: providerCwd, guard });
  const providers: Record<string, any> = {
    local_fs: localFsProviderFactory({ cwd, guard: resourceAccessGuard }),
    url: new UrlProvider({ materializeRoot: urlMaterializeRoot }),
  };
  if (sessionFiles) {
    providers.session_file = new SessionFileResolverProvider({ sessionFiles });
  }
  if (resourceService) {
    providers.resource = new ResourceProvider({ resourceService });
  }
  if (studioId) {
    providers.mount = new MountProvider({
      hanakoHome,
      studioId,
      localFsProviderFactory,
    });
  }

  return new ResourceIO({
    providers,
    eventBus: new ResourceEventBus({
      emit: (event, sessionPath) => emitEvent?.(event, sessionPath),
    }),
    getSessionPath: () => getSessionPath?.() || null,
  });
}

function normalizeExistingOrResolvedPath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isInsideRoot(filePath, root) {
  const rel = path.relative(root, filePath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function externalReadGrantCovers(targetPath, grantPath) {
  const target = normalizeExistingOrResolvedPath(targetPath);
  const grant = normalizeExistingOrResolvedPath(grantPath);
  if (target === grant) return true;
  try {
    return fs.statSync(grant).isDirectory() && isInsideRoot(target, grant);
  } catch {
    return false;
  }
}

function hasExternalReadGrant(absolutePath, { getExternalReadPaths }: { getExternalReadPaths?: any } = {}) {
  if (!absolutePath || typeof getExternalReadPaths !== "function") return false;
  try {
    const grants = getExternalReadPaths() || [];
    return Array.isArray(grants) && grants.some((grantPath) => grantPath && externalReadGrantCovers(absolutePath, grantPath));
  } catch {
    return false;
  }
}
