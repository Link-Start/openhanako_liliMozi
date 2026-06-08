/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../hooks/use-auto-update-state', () => ({
  useAutoUpdateState: () => ({ status: 'idle' }),
}));

vi.mock('../../widgets/Toggle', () => ({
  Toggle: ({
    on,
    onChange,
    label,
    ariaLabel,
  }: {
    on: boolean | undefined;
    onChange: (next: boolean) => void;
    label?: string;
    ariaLabel?: string;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel || label}
      aria-busy={on === undefined ? 'true' : undefined}
      aria-checked={on === undefined ? 'mixed' : on ? 'true' : 'false'}
      data-testid={`${ariaLabel || label}-${on === undefined ? 'loading' : on ? 'on' : 'off'}`}
      disabled={on === undefined}
      onClick={() => {
        if (on !== undefined) onChange(!on);
      }}
    >
      toggle
    </button>
  ),
}));

const autoSaveConfig = vi.fn();
const loadSettingsConfig = vi.fn();

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: (...args: unknown[]) => autoSaveConfig(...args),
}));

vi.mock('../../actions', () => ({
  loadSettingsConfig: (...args: unknown[]) => loadSettingsConfig(...args),
}));

import { AboutTab } from '../AboutTab';
import { useSettingsStore } from '../../store';

afterEach(() => {
  cleanup();
  autoSaveConfig.mockReset();
  loadSettingsConfig.mockReset();
  useSettingsStore.setState({ settingsConfig: null });
  vi.unstubAllGlobals();
});

function installHana() {
  vi.stubGlobal('window', Object.assign(window, {
    hana: {
      getAppVersion: vi.fn().mockResolvedValue('0.160.2'),
      autoUpdateCheck: vi.fn(),
      autoUpdateInstall: vi.fn(),
      autoUpdateSetChannel: vi.fn(),
      openExternal: vi.fn(),
    },
  }));
}

describe('AboutTab', () => {
  it('keeps startup and background controls out of the about page', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    render(<AboutTab />);

    expect(screen.getByText('settings.about.autoCheckUpdates')).toBeTruthy();
    expect(screen.getByText('settings.about.betaUpdates')).toBeTruthy();
    expect(screen.queryByText('settings.general.launchAtLogin')).toBeNull();
    expect(screen.queryByText('settings.general.keepAwake')).toBeNull();
  });

  it('keeps update switches in loading state until settings config is ready', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: null });

    render(<AboutTab />);

    const switches = screen.getAllByRole('button').filter(
      el => el.getAttribute('aria-checked') === 'mixed',
    ) as HTMLButtonElement[];
    expect(switches).toHaveLength(2);
    for (const item of switches) {
      expect(item.disabled).toBe(true);
      fireEvent.click(item);
    }
    expect(autoSaveConfig).not.toHaveBeenCalled();
    expect(loadSettingsConfig).not.toHaveBeenCalled();
  });
});
