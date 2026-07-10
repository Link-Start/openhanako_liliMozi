// 跨 session 投递单点：一切以 sessionId 为键，path 仅在 manifest 解析后的最后一步出现。
// 空闲目标走完整回合提交；跑动中目标走 interjection（与用户手动"跑动中插入"同款语义）。
import {
  submitDesktopSessionMessage,
  submitDesktopSessionInterjection,
} from "../../core/desktop-session-submit.ts";
import { t } from "../i18n.ts";

export const AGENT_MESSAGE_SOURCE = "agent_session";
const ACCEPT_WINDOW_MS = 1500;

export function buildAgentMessagePrefix(agentName: string): string {
  return t("sessionCollab.messagePrefix", { name: agentName || "Agent" });
}

// submit 等完整回合（分钟级）才 resolve；接受窗口竞速：窗口内 rejected = 投递失败上抛，
// 否则视为已接受。回合后续错误由目标 session 自身错误面呈现，这里 catch 只防 unhandledRejection。
function raceAcceptance(turnPromise: Promise<unknown>): Promise<{ accepted: true }> {
  return new Promise<{ accepted: true }>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ accepted: true }), ACCEPT_WINDOW_MS);
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    turnPromise.then(
      () => { clearTimeout(timer); resolve({ accepted: true }); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  }).then((r) => {
    turnPromise.catch((err: any) => console.warn("[session-collab] delivered turn failed later:", err?.message || err));
    return r;
  });
}

export async function deliverAgentMessage(engine: any, opts: {
  targetSessionId: string;
  message: string;
  from: { agentId: string | null; agentName: string | null };
}): Promise<{ accepted: true; targetSessionId: string }> {
  const targetSessionId = String(opts.targetSessionId || "").trim();
  const manifest = engine.getSessionManifest?.(targetSessionId) || null;
  const sessionPath = manifest?.currentLocator?.path || null;
  if (!sessionPath) throw new Error(`session_not_found:${targetSessionId}`);

  const prefix = buildAgentMessagePrefix(opts.from.agentName || opts.from.agentId || "Agent");
  const text = `${prefix}\n${opts.message}`;
  const displayMessage = {
    text: opts.message,
    source: AGENT_MESSAGE_SOURCE,
    origin: { kind: "agent", agentId: opts.from.agentId, agentName: opts.from.agentName },
  };
  const payload = { sessionId: targetSessionId, sessionPath, text, displayMessage };

  const streaming = engine.isSessionStreaming?.(sessionPath) === true;
  const primary = streaming
    ? () => submitDesktopSessionInterjection(engine, payload)
    : () => submitDesktopSessionMessage(engine, payload);
  const fallback = streaming
    ? () => submitDesktopSessionMessage(engine, payload)
    : () => submitDesktopSessionInterjection(engine, payload);

  try {
    // primary() 在 mock 场景下可能同步 throw；包一层 async IIFE 把同步异常也转成 rejected promise，
    // 保证不管 primary 是同步抛还是返回 rejected promise，都统一走 catch 分支处理。
    await raceAcceptance((async () => primary())());
  } catch (err: any) {
    // 竞态兜底一次：提交瞬间对方恰好开跑/刚停。只兜 session_busy，其它错误原样上抛。
    if (err?.message !== "session_busy") throw err;
    await raceAcceptance((async () => fallback())());
  }
  return { accepted: true, targetSessionId };
}
