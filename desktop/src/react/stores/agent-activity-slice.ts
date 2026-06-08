/**
 * agent-activity-slice.ts — Agent Activity 实时活动（后台任务）
 *
 * 消费后端 ActivityHub 广播的 agent_activity 事件，按 sessionPath 存储（权威源）。
 * 右侧 Activity 卡按当前对话 sessionPath 取——统一真相源（subagent / workflow / 巡检）。
 */

export interface AgentActivityEntry {
  id: string;
  kind: 'subagent' | 'workflow' | 'workflow_agent' | 'workflow_step' | 'heartbeat' | 'cron';
  status: 'running' | 'done' | 'failed' | 'aborted';
  sessionPath: string | null;
  agentId: string | null;
  agentName: string | null;
  summary: string | null;
  childSessionPath: string | null;
  threadId?: string | null;
  threadKind?: string | null;
  access?: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  // workflow_agent 子节点和 subagent 都会用 label：节点名或子 Agent 展示标签。
  parentTaskId?: string | null;
  label?: string | null;
  phaseLabel?: string | null;
  tokens?: number | null;
  stepKind?: 'parallel' | 'pipeline' | 'log' | null;
}

export interface AgentActivitySlice {
  /** 按 session path 存储的活动列表（权威源，前端按当前对话过滤展示） */
  agentActivitiesBySession: Record<string, AgentActivityEntry[]>;
  upsertAgentActivity: (entry: AgentActivityEntry) => void;
  clearAgentActivities: (sessionPath: string) => void;
}

export const createAgentActivitySlice = (
  set: (partial: Partial<AgentActivitySlice> | ((s: AgentActivitySlice) => Partial<AgentActivitySlice>)) => void
): AgentActivitySlice => ({
  agentActivitiesBySession: {},
  upsertAgentActivity: (entry) => {
    const sp = entry?.sessionPath;
    if (!sp || !entry?.id) return; // 无归属/无 id 不入库（禁止从焦点 session 兜底）
    set((s) => {
      const list = s.agentActivitiesBySession[sp] || [];
      const idx = list.findIndex((e) => e.id === entry.id);
      const next = idx >= 0
        ? list.map((e) => (e.id === entry.id ? { ...e, ...entry } : e))
        : [...list, entry];
      return { agentActivitiesBySession: { ...s.agentActivitiesBySession, [sp]: next } };
    });
  },
  clearAgentActivities: (sessionPath) => {
    set((s) => {
      if (!s.agentActivitiesBySession[sessionPath]) return {};
      const next = { ...s.agentActivitiesBySession };
      delete next[sessionPath];
      return { agentActivitiesBySession: next };
    });
  },
});

// ── Selectors ──
const EMPTY: AgentActivityEntry[] = [];
/** 当前对话的活动列表（稳定空引用，避免无活动时触发 re-render） */
export const selectAgentActivities =
  (sessionPath: string | null) =>
  (s: AgentActivitySlice): AgentActivityEntry[] =>
    sessionPath ? (s.agentActivitiesBySession[sessionPath] || EMPTY) : EMPTY;
