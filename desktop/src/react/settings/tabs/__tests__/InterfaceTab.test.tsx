// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterfaceTab } from '../InterfaceTab';
import { useSettingsStore } from '../../store';
import registry from '../../../../shared/theme-registry';

vi.mock('../../../services/appearance-sync', () => ({
  persistAppearancePreferences: vi.fn().mockResolvedValue(undefined),
}));

type AppearanceGlobals = typeof globalThis & {
  setTheme?: (theme: string) => void;
  setSerifFont?: (enabled: boolean) => void;
  setPaperTexture?: (enabled: boolean) => void;
};

function setAppearanceGlobals() {
  (globalThis as AppearanceGlobals).setTheme = vi.fn((theme: string) => {
    localStorage.setItem('hana-theme', theme);
    document.documentElement.setAttribute('data-theme', theme === 'auto' ? registry.DEFAULT_THEME : theme);
  });
  (globalThis as AppearanceGlobals).setSerifFont = vi.fn((enabled: boolean) => {
    localStorage.setItem('hana-font-serif', enabled ? '1' : '0');
    document.body.classList.toggle('font-sans', !enabled);
  });
  (globalThis as AppearanceGlobals).setPaperTexture = vi.fn((enabled: boolean) => {
    localStorage.setItem('hana-paper-texture', enabled ? '1' : '0');
  });
}

function seedSettings() {
  useSettingsStore.setState({
    settingsConfig: {
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      hardware_acceleration: true,
      editor: {},
    },
    currentAgentId: 'agent-1',
    settingsAgentId: 'agent-1',
  } as never);
}

describe('InterfaceTab appearance state', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.className = '';
    document.documentElement.setAttribute('data-theme', registry.DEFAULT_THEME);
    window.t = ((key: string) => key) as typeof window.t;
    window.platform = {
      settingsChanged: vi.fn(),
    } as unknown as typeof window.platform;
    setAppearanceGlobals();
    seedSettings();
  });

  it('updates the reading font card from component state after the preference changes', () => {
    localStorage.setItem('hana-font-serif', '1');

    render(React.createElement(InterfaceTab));

    const sansCard = screen.getByText('settings.fonts.sansName').closest('button');
    expect(sansCard).toBeTruthy();

    fireEvent.click(sansCard!);

    expect(globalThis.setSerifFont).toHaveBeenCalledWith(false);
    expect(localStorage.getItem('hana-font-serif')).toBe('0');
  });

  it('recomputes paper texture availability when the selected theme changes', () => {
    localStorage.setItem('hana-theme', registry.DEFAULT_THEME);
    localStorage.setItem('hana-paper-texture', '1');

    render(React.createElement(InterfaceTab));

    const paperSwitch = () => screen.getAllByRole('switch')[0] as HTMLButtonElement;
    expect(paperSwitch().getAttribute('aria-checked')).toBe('true');
    expect(paperSwitch().disabled).toBe(false);

    const midnightTheme = screen.getByText('settings.appearance.midnight').closest('button');
    expect(midnightTheme).toBeTruthy();
    fireEvent.click(midnightTheme!);

    expect(paperSwitch().getAttribute('aria-checked')).toBe('false');
    expect(paperSwitch().disabled).toBe(true);
  });

  it('renders the hardware acceleration switch from settings config', () => {
    useSettingsStore.setState({
      settingsConfig: {
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        hardware_acceleration: false,
        editor: {},
      },
    } as never);

    render(React.createElement(InterfaceTab));

    expect(screen.getByText('settings.interface.hardwareAcceleration')).toBeTruthy();
    expect(screen.getAllByRole('switch')[2].getAttribute('aria-checked')).toBe('false');
  });

  it('keeps hardware acceleration loading until settings config is ready', () => {
    useSettingsStore.setState({
      settingsConfig: null,
    } as never);

    render(React.createElement(InterfaceTab));

    const hardwareSwitch = screen.getAllByRole('switch')[2] as HTMLButtonElement;
    expect(hardwareSwitch.getAttribute('aria-checked')).toBe('mixed');
    expect(hardwareSwitch.getAttribute('aria-busy')).toBe('true');
    expect(hardwareSwitch.disabled).toBe(true);
  });

  it('renders a markdown font selector in the editor section', () => {
    render(React.createElement(InterfaceTab));

    expect(screen.getByText('settings.editor.markdownFont')).toBeTruthy();
    expect(screen.getByTitle('settings.fonts.followReading')).toBeTruthy();
  });

  it('hides fourth through sixth heading typography controls', () => {
    render(React.createElement(InterfaceTab));

    expect(screen.getByText('settings.editor.markdownBodyFontSize')).toBeTruthy();
    expect(screen.getByText('settings.editor.markdownHeading1FontSize')).toBeTruthy();
    expect(screen.getByText('settings.editor.markdownHeading2FontSize')).toBeTruthy();
    expect(screen.getByText('settings.editor.markdownHeading3FontSize')).toBeTruthy();
    expect(screen.queryByText('settings.editor.markdownHeading4FontSize')).toBeNull();
    expect(screen.queryByText('settings.editor.markdownHeading5FontSize')).toBeNull();
    expect(screen.queryByText('settings.editor.markdownHeading6FontSize')).toBeNull();
  });

  it('renders the app-local voice recording shortcut in the interface tab', () => {
    useSettingsStore.setState({ platformName: 'darwin' } as never);

    render(React.createElement(InterfaceTab));

    expect(screen.getByText('settings.interface.shortcuts')).toBeTruthy();
    expect(screen.getByText('settings.interface.voiceRecordingShortcut')).toBeTruthy();
    expect(screen.getByLabelText('⌘ + ⇧ + M')).toBeTruthy();
  });
});
