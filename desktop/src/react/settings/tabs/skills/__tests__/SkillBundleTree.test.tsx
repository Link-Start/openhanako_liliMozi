/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SkillBundleTree } from '../SkillBundleTree';
import type { SkillInfo } from '../../../store';

describe('SkillBundleTree', () => {
  it('keeps bundle children collapsed by default', () => {
    const skills: SkillInfo[] = [
      { name: 'writer', description: 'Write carefully', enabled: false, source: 'user' },
    ];

    render(
      <SkillBundleTree
        mode="manage"
        bundles={[{
          id: 'writing-bundle',
          name: 'Writing Bundle',
          skillNames: ['writer'],
          source: 'user',
        }]}
        skills={skills}
        nameHints={{}}
        emptyText="No skills"
      />,
    );

    expect(screen.getByText('Writing Bundle')).toBeTruthy();
    expect(screen.queryByText('writer')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settings.skills.expandBundleAriaLabel' }));

    expect(screen.getByText('writer')).toBeTruthy();
  });
});
