// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

describe('MainContent app file drag attachments', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useStore.setState({
      currentSessionPath: '/sessions/main.jsonl',
      attachedFiles: [],
      attachedFilesBySession: {},
    } as never);
  });

  it('attaches dragged session files without re-uploading them', async () => {
    const { attachAppFileDragPayloadToInput } = await import('../../MainContent');

    await attachAppFileDragPayloadToInput({
      dragId: 'hana-drag-test',
      source: 'session-file',
      files: [{
        id: 'sf_report',
        fileId: 'sf_report',
        name: 'report.pdf',
        path: '/tmp/session-files/report.pdf',
        isDirectory: false,
      }],
    });

    expect(useStore.getState().attachedFiles).toEqual([{
      fileId: 'sf_report',
      path: '/tmp/session-files/report.pdf',
      name: 'report.pdf',
      isDirectory: false,
    }]);
    expect(useStore.getState().attachedFilesBySession['/sessions/main.jsonl']).toEqual(useStore.getState().attachedFiles);
  });

  it('does not attach dragged files to the chat input while viewing channels', async () => {
    const addToast = vi.fn();
    useStore.setState({
      currentTab: 'channels',
      addToast,
    } as never);
    const { attachAppFileDragPayloadToInput, attachFilesFromPaths } = await import('../../MainContent');

    await attachAppFileDragPayloadToInput({
      dragId: 'hana-drag-channel-session-file',
      source: 'session-file',
      files: [{
        id: 'sf_channel',
        fileId: 'sf_channel',
        name: 'channel.png',
        path: '/tmp/session-files/channel.png',
      }],
    });
    await attachFilesFromPaths(['/tmp/local.txt']);

    expect(useStore.getState().attachedFiles).toEqual([]);
    expect(useStore.getState().attachedFilesBySession['/sessions/main.jsonl']).toBeUndefined();
    expect(hanaFetch).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith('channel.filesUnsupported', 'error');
  });
});
