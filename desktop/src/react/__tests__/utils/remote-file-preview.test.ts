import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockHanaFetch = vi.fn();

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: mockHanaFetch,
}));

describe('remote file preview workbench refs', () => {
  beforeEach(() => {
    mockHanaFetch.mockReset();
    mockHanaFetch.mockResolvedValue({
      json: async () => ({ ok: true, version: { mtimeMs: 1, size: 4 } }),
    });
  });

  it('saves remote workbench content by mountId instead of producing a legacy rootId-only request', async () => {
    const { saveRemoteWorkbenchContent } = await import('../../utils/remote-file-preview');

    await saveRemoteWorkbenchContent({
      kind: 'workbench-file',
      mountId: 'mount_docs',
      subdir: 'notes',
      name: 'remote.md',
      contentPath: '/api/workbench/content?mountId=mount_docs&subdir=notes&name=remote.md',
    } as any, 'body');

    expect(mockHanaFetch).toHaveBeenCalledWith(
      '/api/workbench/actions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'writeText',
          mountId: 'mount_docs',
          subdir: 'notes',
          name: 'remote.md',
          content: 'body',
          expectedVersion: null,
        }),
      }),
    );
    expect(String(mockHanaFetch.mock.calls[0][1].body)).not.toContain('"rootId"');
  });
});
