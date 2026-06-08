import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../stores';
import {
  appendConnectionAuth,
  buildConnectionUrl,
  isLocalOwnerConnection,
  type ServerConnection,
} from '../services/server-connection';
import { DEFAULT_THEME } from '../../shared/theme-registry';

type SurfaceUrlStatus = 'loading' | 'ready' | 'error';

interface RemoteTicketState {
  key: string;
  ticket: string;
}

interface RemoteTicketError {
  key: string;
  message: string;
}

export interface PluginSurfaceUrlState {
  iframeSrc: string | null;
  status: SurfaceUrlStatus;
  error: string | null;
  retry: () => void;
}

export function usePluginSurfaceUrl(routeUrl: string | null, agentId?: string | null): PluginSurfaceUrlState {
  const connection = useStore(s => s.activeServerConnection);
  const [remoteTicket, setRemoteTicket] = useState<RemoteTicketState | null>(null);
  const [remoteError, setRemoteError] = useState<RemoteTicketError | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const requestKey = connection && routeUrl
    ? [
        connection.connectionId,
        connection.baseUrl,
        connection.token || '',
        routeUrl,
        retryNonce,
      ].join('|')
    : '';
  const localOwner = isLocalOwnerConnection(connection);

  useEffect(() => {
    if (!connection || !routeUrl || localOwner) {
      setRemoteTicket(null);
      setRemoteError(null);
      return;
    }

    const controller = new AbortController();
    setRemoteTicket(null);
    setRemoteError(null);

    void fetch(buildConnectionUrl(connection, '/api/plugins/iframe-ticket'), {
      method: 'POST',
      headers: appendConnectionAuth(connection, { 'Content-Type': 'application/json' }),
      credentials: 'include',
      signal: controller.signal,
      body: JSON.stringify({ routeUrl }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`plugin iframe ticket failed: ${res.status} ${res.statusText}`);
      return res.json();
    }).then((data) => {
      if (controller.signal.aborted) return;
      if (typeof data?.ticket !== 'string' || !data.ticket) {
        throw new Error('plugin iframe ticket missing');
      }
      setRemoteTicket({ key: requestKey, ticket: data.ticket });
    }).catch((err) => {
      if (controller.signal.aborted) return;
      setRemoteError({ key: requestKey, message: err instanceof Error ? err.message : String(err) });
    });

    return () => controller.abort();
  }, [connection, localOwner, requestKey, routeUrl]);

  const iframeSrc = useMemo(() => {
    if (!connection || !routeUrl) return null;
    if (!localOwner && remoteTicket?.key !== requestKey) return null;
    const ticket = localOwner ? null : remoteTicket?.ticket || null;
    return buildPluginSurfaceUrl({
      connection,
      routeUrl,
      agentId,
      ticket,
      theme: document.documentElement.dataset.theme || DEFAULT_THEME,
    });
  }, [agentId, connection, localOwner, remoteTicket, requestKey, routeUrl]);

  const retry = useCallback(() => setRetryNonce(n => n + 1), []);

  if (!connection || !routeUrl) return { iframeSrc: null, status: 'loading', error: null, retry };
  if (localOwner) return { iframeSrc, status: 'ready', error: null, retry };
  if (remoteError?.key === requestKey) return { iframeSrc: null, status: 'error', error: remoteError.message, retry };
  if (remoteTicket?.key === requestKey && iframeSrc) return { iframeSrc, status: 'ready', error: null, retry };
  return { iframeSrc: null, status: 'loading', error: null, retry };
}

export function buildPluginSurfaceUrl({
  connection,
  routeUrl,
  agentId,
  ticket,
  theme,
}: {
  connection: ServerConnection;
  routeUrl: string;
  agentId?: string | null;
  ticket?: string | null;
  theme: string;
}): string {
  const cssUrl = buildConnectionUrl(
    connection,
    `/api/plugins/theme.css?theme=${encodeURIComponent(theme)}`,
    { includeTokenQuery: true },
  );
  const fullUrl = buildConnectionUrl(connection, routeUrl, { includeTokenQuery: true });
  const url = new URL(fullUrl);
  if (ticket) url.searchParams.set('pluginIframeTicket', ticket);
  url.searchParams.set('agentId', agentId || '');
  url.searchParams.set('hana-theme', theme);
  url.searchParams.set('hana-css', cssUrl);
  return url.toString();
}
