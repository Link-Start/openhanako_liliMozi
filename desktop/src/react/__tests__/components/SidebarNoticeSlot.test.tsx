/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoUpdateState } from '../../types';
import { SidebarUpdateNoticeCard } from '../../components/notices/SidebarNoticeSlot';

const labels: Record<string, string> = {
  'settings.about.updateAvailable': '有新版本可用：v{version}',
  'settings.about.updateDownloading': '{agentName}正在准备新家 {percent}%',
  'settings.about.updateProgress': '{percent}%',
  'settings.about.updateReadyInstall': 'v{version} 已就绪',
  'settings.about.updateInstallManualHint': '点「重启更新」后安装，直接退出不会自动安装',
  'settings.about.updateInstall': '重启更新',
  'settings.about.updateInstallNow': '重启立即更新',
  'settings.about.updateInstalling': '正在安装更新，HanaAgent 会自动重启…',
  'settings.about.updateDiskSpace': '空间不足，暂时无法下载更新',
  'settings.about.updateNeedInstall': '请先将 HanaAgent 移动到应用程序文件夹',
  'settings.about.updateError': '检查更新失败',
  'window.close': '关闭',
};

function translate(key: string, vars?: Record<string, string | number>): string {
  let value = labels[key] ?? key;
  for (const [name, replacement] of Object.entries(vars ?? {})) {
    value = value.replace(`{${name}}`, String(replacement));
  }
  return value;
}

function updateState(partial: Partial<AutoUpdateState>): AutoUpdateState {
  return {
    status: 'idle',
    version: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    progress: null,
    error: null,
    ...partial,
  };
}

describe('SidebarUpdateNoticeCard', () => {
  beforeEach(() => {
    window.t = translate as typeof window.t;
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('stays silent until the update is ready to install', () => {
    const { container, rerender } = render(
      <SidebarUpdateNoticeCard state={updateState({ status: 'idle' })} />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard state={updateState({ status: 'latest' })} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard state={updateState({ status: 'available', version: '0.234.0' })} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard state={updateState({
      status: 'downloading',
      version: '0.234.0',
      progress: { percent: 42, bytesPerSecond: 0, transferred: 0, total: 0 },
    })} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard state={updateState({ status: 'installing', version: '0.234.0' })} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard state={updateState({ status: 'error', version: '0.234.0', error: 'network' })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps a ready update visible until the user dismisses that version', () => {
    const { container, rerender } = render(
      <SidebarUpdateNoticeCard state={updateState({ status: 'downloaded', version: '0.234.0' })} onInstall={vi.fn()} />,
    );

    expect(screen.getByText('v0.234.0 已就绪')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重启立即更新' })).toBeInTheDocument();
    expect(screen.queryByText('点「重启更新」后安装')).not.toBeInTheDocument();
    expect(screen.queryByText('点「重启更新」后安装，直接退出不会自动安装')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard state={updateState({ status: 'downloaded', version: '0.234.0' })} onInstall={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard state={updateState({ status: 'downloaded', version: '0.235.0' })} onInstall={vi.fn()} />);
    expect(screen.getByText('v0.235.0 已就绪')).toBeInTheDocument();
  });

  it('offers install action once the update is downloaded', () => {
    const onInstall = vi.fn();
    render(
      <SidebarUpdateNoticeCard
        state={updateState({ status: 'downloaded', version: '0.234.0' })}
        onInstall={onInstall}
      />,
    );

    expect(screen.getByText('v0.234.0 已就绪')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重启立即更新' }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });
});
