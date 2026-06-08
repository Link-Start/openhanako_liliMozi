// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolGroupBlock } from '../../components/chat/ToolGroupBlock';

describe('ToolGroupBlock', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('shows the full bash command in the hover title when the visible detail is truncated', () => {
    const command = 'rm -rf /Users/jason/.claude/plugins/marketplaces/temp_*';

    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[{
          name: 'bash',
          args: { command },
          done: true,
          success: true,
        }]}
      />,
    );

    const detail = screen.getByTitle(command);

    expect(detail.textContent).toBe('rm -rf /Users/jason/.claude/plugins/mar…');
  });

  it('syncs a multi-tool group to collapsed when the completed block updates', async () => {
    const { rerender } = render(
      <ToolGroupBlock
        collapsed={false}
        tools={[
          { name: 'bash', args: { command: 'npm test' }, done: true, success: true },
          { name: 'read', args: { file_path: '/tmp/report.md' }, done: false, success: false },
        ]}
      />,
    );

    // 展开时工具内容可见
    expect(screen.getByText('npm test')).toBeInTheDocument();

    rerender(
      <ToolGroupBlock
        collapsed={true}
        tools={[
          { name: 'bash', args: { command: 'npm test' }, done: true, success: true },
          { name: 'read', args: { file_path: '/tmp/report.md' }, done: true, success: true },
        ]}
      />,
    );

    // 折叠后，Collapse 组件通过 AnimatePresence 退场动画后移除内容。
    // jsdom 下 requestAnimationFrame 可能延迟执行退场，用 waitFor 等待。
    await waitFor(() => {
      expect(screen.queryByText('npm test')).not.toBeInTheDocument();
    });
  });

  it('keeps a single tool as a plain indicator without a fold summary', () => {
    render(
      <ToolGroupBlock
        collapsed={true}
        tools={[{
          name: 'bash',
          args: { command: 'npm test' },
          done: true,
          success: true,
        }]}
      />,
    );

    expect(screen.queryByText('toolGroup.count')).toBeNull();
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('hides automation create/update tools because the suggestion card is the UI', () => {
    const { container } = render(
      <ToolGroupBlock
        collapsed={false}
        tools={[
          {
            name: 'automation',
            args: { action: 'create', label: 'Tea' },
            done: true,
            success: true,
          },
          {
            name: 'automation',
            args: { action: 'update', id: 'job_1' },
            done: true,
            success: true,
          },
        ]}
      />,
    );

    expect(container.firstChild).toBeNull();
  });
});
