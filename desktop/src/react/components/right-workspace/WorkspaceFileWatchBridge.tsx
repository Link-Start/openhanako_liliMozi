import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../stores';
import { subscribeWorkspaceChanges } from '../../services/workspace-change-events';
import type { WorkspaceChangePayload } from '../../types';

function normalizeDirectoryPath(value: string): string {
  const slashed = value.replace(/\\/g, '/');
  const normalized = slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
  const withDriveRootSlash = /^[A-Za-z]:$/.test(normalized) ? `${normalized}/` : normalized;
  return /^[A-Za-z]:/.test(withDriveRootSlash) ? withDriveRootSlash.toLowerCase() : withDriveRootSlash;
}

function normalizeSubdir(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
  if (childPath === parentPath) return true;
  const prefix = parentPath.endsWith('/') ? parentPath : `${parentPath}/`;
  return childPath.startsWith(prefix);
}

function joinWorkspaceRoot(basePath: string, subdir: string): string {
  const normalizedSubdir = normalizeSubdir(subdir);
  if (!normalizedSubdir) return basePath;
  const separator = /^[A-Za-z]:\\/.test(basePath) || (basePath.includes('\\') && !basePath.includes('/')) ? '\\' : '/';
  return `${basePath.replace(/[\\/]+$/, '')}${separator}${normalizedSubdir.replace(/\//g, separator)}`;
}

function workspaceWatchRoots(basePath: string, expandedPaths: string[]): string[] {
  if (!basePath) return [];
  const roots = new Set<string>([basePath]);
  for (const subdir of expandedPaths) {
    const normalized = normalizeSubdir(subdir);
    if (normalized) roots.add(joinWorkspaceRoot(basePath, normalized));
  }
  return [...roots];
}

function workspaceSubdirForAffectedDirectory(basePath: string, payload: WorkspaceChangePayload): string | null {
  if (!basePath) return null;
  const base = normalizeDirectoryPath(basePath);
  const root = normalizeDirectoryPath(payload.rootPath);
  const affected = normalizeDirectoryPath(payload.affectedDir);
  if (!isPathInsideOrEqual(root, base)) return null;
  if (!isPathInsideOrEqual(affected, base)) return null;
  if (affected === base) return '';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return affected.slice(prefix.length).replace(/^\/+|\/+$/g, '');
}

export function WorkspaceFileWatchBridge() {
  const deskBasePath = useStore(s => s.deskBasePath);
  const deskWorkspaceMountId = useStore(s => s.deskWorkspaceMountId);
  const deskExpandedPaths = useStore(s => s.deskExpandedPaths);
  const activeRootsRef = useRef<Set<string>>(new Set());
  const watchedRoots = useMemo(
    () => (deskWorkspaceMountId ? [] : workspaceWatchRoots(deskBasePath, deskExpandedPaths)),
    [deskBasePath, deskExpandedPaths, deskWorkspaceMountId],
  );
  const watchedRootsKey = watchedRoots.join('\n');

  useEffect(() => {
    const platform = window.platform;
    if (!platform?.unwatchWorkspace) return undefined;
    const activeRoots = activeRootsRef.current;
    const desiredRoots = deskBasePath && !deskWorkspaceMountId ? new Set(watchedRoots) : new Set<string>();

    for (const root of [...activeRoots]) {
      if (desiredRoots.has(root)) continue;
      activeRoots.delete(root);
      void platform.unwatchWorkspace(root);
    }

    if (!deskBasePath || deskWorkspaceMountId || !platform.watchWorkspace) return undefined;

    for (const root of desiredRoots) {
      if (activeRoots.has(root)) continue;
      activeRoots.add(root);
      void platform.watchWorkspace(root)
        .then((ok) => {
          if (!ok) {
            console.warn('[workspace-watch] watch failed:', root);
            activeRootsRef.current.delete(root);
            return;
          }
          if (!activeRootsRef.current.has(root)) void platform.unwatchWorkspace?.(root);
        })
        .catch((err) => {
          activeRootsRef.current.delete(root);
          console.warn('[workspace-watch] watch failed:', err);
        });
    }

    return undefined;
  }, [deskBasePath, deskWorkspaceMountId, watchedRoots, watchedRootsKey]);

  useEffect(() => () => {
    const platform = window.platform;
    if (!platform?.unwatchWorkspace) return;
    for (const root of activeRootsRef.current) {
      void platform.unwatchWorkspace(root);
    }
    activeRootsRef.current.clear();
  }, []);

  useEffect(() => subscribeWorkspaceChanges((payload) => {
    const state = useStore.getState();
    if (state.deskWorkspaceMountId) return;
    const subdir = workspaceSubdirForAffectedDirectory(state.deskBasePath, payload);
    if (subdir == null) return;
    state.markDeskTreeDirty(subdir);
  }), []);

  return null;
}
