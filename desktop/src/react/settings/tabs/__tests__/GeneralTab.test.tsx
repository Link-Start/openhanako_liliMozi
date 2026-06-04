/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const getAutoLaunchStatus = vi.fn();
const setAutoLaunchEnabled = vi.fn();
const setKeepAwakeEnabled = vi.fn();
const autoSaveConfig = vi.fn();
const loadSettingsConfig = vi.fn();
const hanaFetch = vi.fn();

vi.mock('../../api', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetch(...args),
}));

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: (...args: unknown[]) => autoSaveConfig(...args),
}));

vi.mock('../../actions', () => ({
  loadSettingsConfig: (...args: unknown[]) => loadSettingsConfig(...args),
}));

vi.mock('../../widgets/Toggle', () => ({
  Toggle: ({
    on,
    onChange,
    label,
    ariaLabel,
    disabled,
  }: {
    on: boolean;
    onChange: (next: boolean) => void;
    label?: string;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel || label}
      data-testid={`${ariaLabel || label}-${on ? 'on' : 'off'}`}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      toggle
    </button>
  ),
}));

vi.mock('../../widgets/SelectWidget', () => ({
  SelectWidget: ({
    options,
    value,
    onChange,
    disabled,
  }: {
    options: { value: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="turn-completion-notification"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}));

import { GeneralTab } from '../GeneralTab';
import { useSettingsStore } from '../../store';

function jsonResponse(data: unknown) {
  return {
    json: vi.fn(async () => data),
  };
}

function installHana(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('window', Object.assign(window, {
    hana: {
      getAutoLaunchStatus,
      setAutoLaunchEnabled,
      setKeepAwakeEnabled,
      ...overrides,
    },
  }));
}

beforeEach(() => {
  getAutoLaunchStatus.mockResolvedValue({
    supported: true,
    openAtLogin: false,
    openedAtLogin: false,
    status: null,
  });
  hanaFetch.mockResolvedValue(jsonResponse({
    notifications: { turnCompletion: 'never' },
  }));
  useSettingsStore.setState({
    settingsConfig: { keep_awake: false },
    toastMessage: '',
    toastType: '',
    toastVisible: false,
  });
});

afterEach(() => {
  cleanup();
  getAutoLaunchStatus.mockReset();
  setAutoLaunchEnabled.mockReset();
  setKeepAwakeEnabled.mockReset();
  autoSaveConfig.mockReset();
  loadSettingsConfig.mockReset();
  hanaFetch.mockReset();
  useSettingsStore.setState({ settingsConfig: null });
  vi.unstubAllGlobals();
});

describe('GeneralTab', () => {
  it('renders startup and background controls in one section', async () => {
    installHana();

    render(<GeneralTab />);

    expect(await screen.findByText('settings.general.startup.title')).toBeTruthy();
    const launchRow = await screen.findByText('settings.general.launchAtLogin');
    const keepAwakeRow = screen.getByText('settings.general.keepAwake');
    const notificationSection = screen.getByText('settings.general.notifications.title');

    expect(launchRow.compareDocumentPosition(keepAwakeRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(keepAwakeRow.compareDocumentPosition(notificationSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('settings.general.launchAtLogin-off')).toBeTruthy();
    expect(screen.getByTestId('settings.general.keepAwake-off')).toBeTruthy();
  });

  it('updates the launch-at-login row from the main-process result', async () => {
    installHana();
    setAutoLaunchEnabled.mockResolvedValue({
      supported: true,
      openAtLogin: true,
      openedAtLogin: false,
      status: null,
    });

    render(<GeneralTab />);

    fireEvent.click(await screen.findByTestId('settings.general.launchAtLogin-off'));

    await waitFor(() => expect(setAutoLaunchEnabled).toHaveBeenCalledWith(true));
    await screen.findByTestId('settings.general.launchAtLogin-on');
  });

  it('persists keep-awake preference before applying it in the main process', async () => {
    installHana();
    autoSaveConfig.mockResolvedValue(undefined);
    loadSettingsConfig.mockResolvedValue(undefined);
    setKeepAwakeEnabled.mockResolvedValue({
      enabled: true,
      active: true,
      blockerId: 42,
      type: 'prevent-app-suspension',
    });

    render(<GeneralTab />);

    fireEvent.click(await screen.findByTestId('settings.general.keepAwake-off'));

    await waitFor(() => expect(autoSaveConfig).toHaveBeenCalledWith({ keep_awake: true }, { silent: true }));
    await waitFor(() => expect(setKeepAwakeEnabled).toHaveBeenCalledWith(true));
    expect(autoSaveConfig.mock.invocationCallOrder[0]).toBeLessThan(setKeepAwakeEnabled.mock.invocationCallOrder[0]);
  });

  it('saves turn completion notification preference through the notification route', async () => {
    installHana();
    hanaFetch
      .mockResolvedValueOnce(jsonResponse({ notifications: { turnCompletion: 'never' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, notifications: { turnCompletion: 'when_session_unfocused' } }));

    render(<GeneralTab />);

    const select = await screen.findByLabelText('turn-completion-notification');
    expect(screen.getByText('settings.general.notifications.turnCompletionWhenSessionUnfocused')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'when_session_unfocused' } });

    await waitFor(() => expect(hanaFetch).toHaveBeenLastCalledWith('/api/preferences/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notifications: { turnCompletion: 'when_session_unfocused' } }),
    }));
    expect((select as HTMLSelectElement).value).toBe('when_session_unfocused');
  });
});
