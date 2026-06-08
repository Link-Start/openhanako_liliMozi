import { useEffect, useState } from 'react';
import type { AutoUpdateState } from '../types';

function devWebPreviewState(): AutoUpdateState | null {
  if (!window.__HANA_DEV_WEB__) return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get('hana_update_preview') !== 'downloaded') return null;
  return {
    status: 'downloaded',
    version: params.get('hana_update_version') || '0.237.14',
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    progress: null,
    error: null,
  };
}

export function useAutoUpdateState(): AutoUpdateState | null {
  const [state, setState] = useState<AutoUpdateState | null>(() => devWebPreviewState());

  useEffect(() => {
    const previewState = devWebPreviewState();
    if (previewState) {
      setState(previewState);
      const rerenderAfterLocaleLoad = window.setTimeout(() => setState({ ...previewState }), 500);
      return () => window.clearTimeout(rerenderAfterLocaleLoad);
    }

    let alive = true;

    window.hana?.autoUpdateState?.()
      .then((nextState) => {
        if (alive && nextState) {
          setState(nextState);
        }
      })
      .catch(() => {});

    const unsubscribe = window.hana?.onAutoUpdateState?.((nextState) => {
      setState(nextState);
    });

    return () => {
      alive = false;
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);

  return state;
}
