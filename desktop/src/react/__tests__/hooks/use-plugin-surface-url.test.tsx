/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePluginSurfaceUrl } from '../../hooks/use-plugin-surface-url';
import { useStore } from '../../stores';
import { createLocalServerConnection } from '../../services/server-connection';
import { DEFAULT_THEME } from '../../../shared/theme-registry';

const localConnection = createLocalServerConnection({
  serverPort: '3210',
  serverToken: 'local-token',
})!;

const remoteConnection = {
  ...localConnection,
  connectionId: 'lan:node_lan:studio_lan',
  kind: 'lan' as const,
  label: 'LAN Studio',
  baseUrl: 'https://hana.example',
  wsUrl: 'wss://hana.example',
  token: 'remote-token',
  trustState: 'lan' as const,
  credentialKind: 'device_credential' as const,
};

function Harness({ routeUrl }: { routeUrl: string }) {
  const surface = usePluginSurfaceUrl(routeUrl, 'butter');
  return (
    <div>
      <div data-testid="status">{surface.status}</div>
      <div data-testid="src">{surface.iframeSrc || ''}</div>
    </div>
  );
}

describe('usePluginSurfaceUrl', () => {
  beforeEach(() => {
    document.documentElement.dataset.theme = DEFAULT_THEME;
    useStore.setState({
      serverConnections: { local: localConnection },
      activeServerConnectionId: 'local',
      activeServerConnection: localConnection,
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('builds local iframe URLs with the current loopback query token and themed CSS URL', () => {
    render(<Harness routeUrl="/api/plugins/demo/page?view=compact" />);

    expect(screen.getByTestId('status').textContent).toBe('ready');
    const url = new URL(screen.getByTestId('src').textContent || '');
    expect(url.origin).toBe('http://127.0.0.1:3210');
    expect(url.pathname).toBe('/api/plugins/demo/page');
    expect(url.searchParams.get('view')).toBe('compact');
    expect(url.searchParams.get('token')).toBe('local-token');
    expect(url.searchParams.get('agentId')).toBe('butter');
    expect(url.searchParams.get('hana-css')).toBe(
      `http://127.0.0.1:3210/api/plugins/theme.css?theme=${DEFAULT_THEME}&token=local-token`,
    );
  });

  it('uses a remote iframe ticket without leaking the remote device credential into the iframe URL', async () => {
    useStore.setState({
      serverConnections: {
        local: localConnection,
        [remoteConnection.connectionId]: remoteConnection,
      },
      activeServerConnectionId: remoteConnection.connectionId,
      activeServerConnection: remoteConnection,
    } as any);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ticket: 'ticket-1',
      expiresAt: '2026-06-05T12:00:00.000Z',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness routeUrl="/api/plugins/demo/page?view=compact" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledWith('https://hana.example/api/plugins/iframe-ticket', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: expect.objectContaining({ Authorization: 'Bearer remote-token' }),
      body: JSON.stringify({ routeUrl: '/api/plugins/demo/page?view=compact' }),
    }));
    const url = new URL(screen.getByTestId('src').textContent || '');
    expect(url.origin).toBe('https://hana.example');
    expect(url.searchParams.get('pluginIframeTicket')).toBe('ticket-1');
    expect(url.searchParams.get('view')).toBe('compact');
    expect(url.searchParams.get('token')).toBeNull();
    expect(url.toString()).not.toContain('remote-token');
    expect(url.searchParams.get('hana-css')).toBe(
      `https://hana.example/api/plugins/theme.css?theme=${DEFAULT_THEME}`,
    );
  });
});
