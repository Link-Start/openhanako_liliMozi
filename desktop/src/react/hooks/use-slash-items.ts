import { useMemo, useEffect, useState } from 'react';
import { hanaFetch } from './use-hana-fetch';
import { useStore } from '../stores';
import { getSkillIcon } from '../utils/skill-icons';
import type { SlashItem } from '../components/input/slash-commands';

interface SkillInfo {
  name: string;
  description: string;
  hidden: boolean;
  enabled: boolean;
}

/**
 * Fetch enabled, visible skills for the current agent.
 * Returns a stable array that only updates when skills change.
 */
export function useSkillSlashItems({ enabled = true }: { enabled?: boolean } = {}): SlashItem[] {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const agentId = useStore(s => s.currentAgentId);
  const skillCatalogVersion = useStore(s => s.skillCatalogVersion);

  useEffect(() => {
    if (!enabled) {
      setSkills([]);
      return;
    }
    if (!agentId) {
      setSkills([]);
      return;
    }
    let cancelled = false;
    hanaFetch(`/api/skills?agentId=${encodeURIComponent(agentId)}&runtime=1`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data.skills) setSkills(data.skills);
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // skills 是 per-agent 的，不随 session 切换变化
  }, [agentId, enabled, skillCatalogVersion]);

  return useMemo(() =>
    skills
      .filter(s => s.enabled && !s.hidden)
      .map(s => ({
        name: s.name,
        label: `/${s.name}`,
        description: s.description || '',
        busyLabel: '',
        icon: getSkillIcon(s.name),
        type: 'skill' as const,
        execute: () => {},  // placeholder, actual insertion handled by InputArea
      })),
    [skills],
  );
}
