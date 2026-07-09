/**
 * Bridge state management hook — loads status, saves config, tests platforms.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';
import { loadSettingsConfig, updateSettingsSnapshot } from '../../actions';
import { t } from '../../helpers';
import type { BridgePermissionMode, KnownUser } from './BridgeWidgets';
import {
  useBridgeCredentialDrafts,
  type BridgeCredentialFieldValues,
  type StoredBridgeSecrets,
} from './useBridgeSecretDrafts';

// ── Types ──

interface PlatformStatusBase {
  status?: string;
  error?: string;
  enabled?: boolean;
  agentId?: string | null;
}

export interface TelegramStatus extends PlatformStatusBase { token?: string; hasToken?: boolean }
export type FeishuRegion = 'feishu_cn' | 'lark_global';
export interface FeishuStatus extends PlatformStatusBase { appId?: string; appSecret?: string; hasAppSecret?: boolean; region?: FeishuRegion; domain?: string | null }
export interface DingTalkStatus extends PlatformStatusBase {
  corpId?: string;
  clientId?: string;
  clientSecret?: string;
  hasClientSecret?: boolean;
  robotCode?: string;
  apiBaseUrl?: string;
  restBaseUrl?: string;
}
export interface QQStatus extends PlatformStatusBase { appID?: string; appSecret?: string; hasAppSecret?: boolean }
export interface WechatStatus extends PlatformStatusBase { token?: string }

export interface BridgeStatus {
  agentId?: string | null;
  telegram: TelegramStatus;
  feishu: FeishuStatus;
  dingtalk: DingTalkStatus;
  whatsapp: PlatformStatusBase;
  qq: QQStatus;
  wechat: WechatStatus;
  permissionMode: BridgePermissionMode;
  readOnly: boolean;
  receiptEnabled: boolean;
  richStreamingEnabled: boolean;
  knownUsers: { telegram?: KnownUser[]; feishu?: KnownUser[]; dingtalk?: KnownUser[]; whatsapp?: KnownUser[]; qq?: KnownUser[]; wechat?: KnownUser[] };
  owner: { telegram?: string; feishu?: string; dingtalk?: string; whatsapp?: string; qq?: string; wechat?: string };
}

export type BridgePlatform = 'telegram' | 'feishu' | 'dingtalk' | 'whatsapp' | 'qq' | 'wechat';

function normalizeFeishuRegion(value: unknown): FeishuRegion {
  return value === 'lark_global' ? 'lark_global' : 'feishu_cn';
}

function normalizeBridgeStatus(data: unknown): BridgeStatus | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Partial<BridgeStatus>;
  return {
    agentId: value.agentId || null,
    telegram: value.telegram || {},
    feishu: value.feishu || {},
    dingtalk: value.dingtalk || {},
    whatsapp: value.whatsapp || {},
    qq: value.qq || {},
    wechat: value.wechat || {},
    permissionMode: value.permissionMode || (value.readOnly === true ? 'read_only' : 'auto'),
    readOnly: value.readOnly === true,
    receiptEnabled: value.receiptEnabled !== false,
    richStreamingEnabled: value.richStreamingEnabled !== false,
    knownUsers: value.knownUsers || {},
    owner: value.owner || {},
  };
}

function bridgeEditableFields(status: BridgeStatus | null): BridgeCredentialFieldValues {
  return {
    feishuAppId: status?.feishu?.appId || '',
    feishuRegion: normalizeFeishuRegion(status?.feishu?.region),
    dingtalkCorpId: status?.dingtalk?.corpId || '',
    dingtalkClientId: status?.dingtalk?.clientId || '',
    dingtalkRobotCode: status?.dingtalk?.robotCode || '',
    dingtalkApiBaseUrl: status?.dingtalk?.apiBaseUrl || status?.dingtalk?.restBaseUrl || '',
    qqAppId: status?.qq?.appID || '',
  };
}

function hasStoredSecret(flag: unknown, maskedValue: unknown) {
  return typeof flag === 'boolean' ? flag : typeof maskedValue === 'string' && maskedValue.length > 0;
}

function storedBridgeSecrets(status: BridgeStatus | null): StoredBridgeSecrets {
  return {
    telegramToken: hasStoredSecret(status?.telegram?.hasToken, status?.telegram?.token),
    feishuAppSecret: hasStoredSecret(status?.feishu?.hasAppSecret, status?.feishu?.appSecret),
    dingtalkClientSecret: hasStoredSecret(status?.dingtalk?.hasClientSecret, status?.dingtalk?.clientSecret),
    qqAppSecret: hasStoredSecret(status?.qq?.hasAppSecret, status?.qq?.appSecret),
  };
}

export function useBridgeState() {
  // Atomic selectors: only re-render when these specific fields change
  const showToast = useSettingsStore(s => s.showToast);
  const currentAgentId = useSettingsStore(s => s.currentAgentId);
  const settingsSnapshot = useSettingsStore(s => s.settingsSnapshot.data);
  const snapshotBridgeStatus = settingsSnapshot?.agentId === currentAgentId
    ? normalizeBridgeStatus(settingsSnapshot.bridgeStatus)
    : null;
  const snapshotFields = bridgeEditableFields(snapshotBridgeStatus);

  // Selected agent for bridge config (independent of Agent tab selection)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    currentAgentId
  );
  const [statusState, setStatusState] = useState<{
    ownerId: string | null;
    value: BridgeStatus | null;
  } | null>(() => snapshotBridgeStatus ? {
    ownerId: currentAgentId,
    value: snapshotBridgeStatus,
  } : null);
  const status = statusState?.ownerId === selectedAgentId ? statusState.value : null;
  const [testingState, setTestingState] = useState<{
    ownerId: string | null;
    platform: BridgePlatform;
    requestId: number;
  } | null>(null);
  const testingPlatform = testingState?.ownerId === selectedAgentId
    ? testingState.platform
    : null;
  const [globalSettingsSaving, setGlobalSettingsSaving] = useState(false);
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;
  const statusRequestIdRef = useRef(0);
  const testRequestIdRef = useRef(0);
  const liveStatusOwnersRef = useRef(new Set<string>());

  // Sync initial value when store becomes ready (only if null)
  useEffect(() => {
    if (selectedAgentId) return;
    if (currentAgentId) setSelectedAgentId(currentAgentId);
  }, [currentAgentId, selectedAgentId]);

  // Public Ishiki — keyed to selectedAgentId
  const initialPublicIshiki = settingsSnapshot?.agentId === currentAgentId ? settingsSnapshot.publicIshiki || '' : '';
  const [publicIshiki, setPublicIshiki] = useState(initialPublicIshiki);
  const [publicIshikiOriginal, setPublicIshikiOriginal] = useState(initialPublicIshiki);

  const {
    drafts: secretDrafts,
    fields: credentialFields,
    setTelegramToken: setTgToken,
    setFeishuAppSecret: setFsAppSecret,
    setDingTalkClientSecret: setDtClientSecret,
    setQQAppSecret: setQqAppSecret,
    setFeishuAppId: setFsAppId,
    setFeishuRegion: setFsRegion,
    setDingTalkCorpId: setDtCorpId,
    setDingTalkClientId: setDtClientId,
    setDingTalkRobotCode: setDtRobotCode,
    setDingTalkApiBaseUrl: setDtApiBaseUrl,
    setQQAppId: setQqAppId,
    syncStoredSecrets,
    syncCredentialFields,
    captureSubmission,
    captureFieldSubmissions,
    markSubmissionSaved,
    markFieldSubmissionsSaved,
  } = useBridgeCredentialDrafts(
    selectedAgentId,
    storedBridgeSecrets(snapshotBridgeStatus),
    snapshotFields,
  );

  const applyStatus = useCallback((nextStatus: BridgeStatus | null, statusOwnerId: string | null) => {
    setStatusState({ ownerId: statusOwnerId, value: nextStatus });
    syncCredentialFields(statusOwnerId, bridgeEditableFields(nextStatus));
    syncStoredSecrets(statusOwnerId, storedBridgeSecrets(nextStatus));
  }, [syncCredentialFields, syncStoredSecrets]);

  useEffect(() => {
    if (!selectedAgentId) return;
    if (settingsSnapshot?.agentId !== selectedAgentId) return;
    if (liveStatusOwnersRef.current.has(selectedAgentId)) return;
    const nextStatus = normalizeBridgeStatus(settingsSnapshot.bridgeStatus);
    if (!nextStatus) return;
    applyStatus(nextStatus, selectedAgentId);
  }, [applyStatus, selectedAgentId, settingsSnapshot?.agentId, settingsSnapshot?.bridgeStatus]);

  // Fetch public ishiki for selected agent (abort stale requests on agent switch)
  useEffect(() => {
    if (!selectedAgentId) return;
    if (settingsSnapshot?.agentId === selectedAgentId) {
      const content = settingsSnapshot.publicIshiki || '';
      setPublicIshiki(content);
      setPublicIshikiOriginal(content);
      return;
    }
    const ac = new AbortController();
    hanaFetch(`/api/agents/${selectedAgentId}/public-ishiki`, { signal: ac.signal })
      .then(r => r.json())
      .then(data => { setPublicIshiki(data.content || ''); setPublicIshikiOriginal(data.content || ''); })
      .catch(err => { if (err?.name !== 'AbortError') console.warn('[bridge] fetch public-ishiki failed:', err); });
    return () => ac.abort();
  }, [selectedAgentId, settingsSnapshot]);

  const savePublicIshiki = async () => {
    const agentId = selectedAgentId;
    if (!agentId || publicIshiki === publicIshikiOriginal) return;
    try {
      await hanaFetch(`/api/agents/${agentId}/public-ishiki`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: publicIshiki }),
      });
      updateSettingsSnapshot(snapshot => (
        snapshot.agentId === agentId ? { ...snapshot, publicIshiki } : snapshot
      ));
      setPublicIshikiOriginal(publicIshiki);
      showToast(t('settings.saved'), 'success');
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++statusRequestIdRef.current;
    try {
      const agentId = selectedAgentIdRef.current;
      const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      const res = await hanaFetch(`/api/bridge/status${query}`, signal ? { signal } : undefined);
      const data = await res.json();
      if (
        signal?.aborted
        || requestId !== statusRequestIdRef.current
        || selectedAgentIdRef.current !== agentId
      ) return;
      if (agentId) liveStatusOwnersRef.current.add(agentId);
      applyStatus(normalizeBridgeStatus(data), agentId);
    } catch (err) {
      if (
        (err as Error)?.name === 'AbortError'
        || requestId !== statusRequestIdRef.current
      ) return;
      console.error('[bridge] load status failed:', err);
    }
  }, [applyStatus]); // stable: reads agentId from ref, all setters are stable

  // Auto-fetch when selectedAgentId changes (abort stale on switch)
  useEffect(() => {
    if (!selectedAgentId) return;
    if (settingsSnapshot?.agentId !== selectedAgentId) {
      applyStatus(null, selectedAgentId);
    }
    const ac = new AbortController();
    loadStatus(ac.signal);
    return () => ac.abort();
  }, [applyStatus, selectedAgentId, loadStatus, settingsSnapshot?.agentId]);

  useEffect(() => {
    const handler = () => loadStatus();
    window.addEventListener('hana-bridge-reload', handler);
    return () => window.removeEventListener('hana-bridge-reload', handler);
  }, [loadStatus]);

  const saveBridgeConfig = async (plat: string, credentials: Record<string, string> | null, enabled?: boolean) => {
    // Snapshot agentId at call time to avoid stale closure
    const agentId = selectedAgentId;
    const secretSubmission = captureSubmission(plat, credentials);
    const fieldSubmissions = captureFieldSubmissions(plat, credentials);
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      await hanaFetch(`/api/bridge/config${agentQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, credentials, enabled }),
      });
      markSubmissionSaved(secretSubmission);
      markFieldSubmissionsSaved(fieldSubmissions);
      showToast(t('settings.saved'), 'success');
      // Only reload if user hasn't switched agent during the save (read latest from ref)
      if (selectedAgentIdRef.current === agentId) await loadStatus();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const testPlatform = async (
    plat: BridgePlatform,
    credentials: Record<string, string>,
    useSavedCredentials = false,
  ) => {
    const agentId = selectedAgentId;
    const requestId = ++testRequestIdRef.current;
    setTestingState({ ownerId: agentId, platform: plat, requestId });
    const isCurrentTest = () => (
      testRequestIdRef.current === requestId
      && selectedAgentIdRef.current === agentId
    );
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      const res = await hanaFetch(`/api/bridge/test${agentQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, credentials, useSavedCredentials }),
      });
      const data = await res.json();
      if (!isCurrentTest()) return;
      if (data.ok) {
        const info = plat === 'telegram' ? ` @${data.info?.username || ''}` : '';
        const successText = plat === 'dingtalk' && data.info?.stream?.status === 'not_tested'
          ? t('settings.bridge.dingtalkCredentialTestOk')
          : t('settings.bridge.testOk') + info;
        showToast(successText, 'success');
      } else {
        showToast(t('settings.bridge.testFail') + ': ' + (data.error || ''), 'error');
      }
    } catch (err: unknown) {
      if (isCurrentTest()) {
        showToast(t('settings.bridge.testFail') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
      }
    } finally {
      setTestingState(previous => (
        previous?.requestId === requestId && previous.ownerId === agentId
          ? null
          : previous
      ));
    }
  };

  const setOwner = async (plat: string, userId: string) => {
    const agentId = selectedAgentId;
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      const res = await hanaFetch(`/api/bridge/owner${agentQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, userId: userId || null }),
      });
      const data = await res.json().catch(() => null);
      if (selectedAgentIdRef.current === agentId) {
        const nextStatus = normalizeBridgeStatus(data?.status);
        if (nextStatus) {
          if (agentId) liveStatusOwnersRef.current.add(agentId);
          applyStatus(nextStatus, agentId);
        }
        else await loadStatus();
      }
      showToast(t('settings.bridge.ownerSaved'), 'success');
    } catch {
      showToast(t('settings.saveFailed'), 'error');
    }
  };

  const saveGlobalSettings = async (partial: { permissionMode?: BridgePermissionMode; readOnly?: boolean; receiptEnabled?: boolean; richStreamingEnabled?: boolean }) => {
    setGlobalSettingsSaving(true);
    try {
      const res = await hanaFetch('/api/bridge/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      const saved = await res.json();
      if (saved.error) throw new Error(saved.error);
      if (typeof saved.permissionMode === 'string' && typeof saved.readOnly === 'boolean' && typeof saved.receiptEnabled === 'boolean' && typeof saved.richStreamingEnabled === 'boolean') {
        setStatusState(prev => prev?.ownerId === selectedAgentId && prev.value ? {
          ownerId: prev.ownerId,
          value: {
            ...prev.value,
            permissionMode: saved.permissionMode,
            readOnly: saved.readOnly,
            receiptEnabled: saved.receiptEnabled,
            richStreamingEnabled: saved.richStreamingEnabled,
          },
        } : prev);
      }
      showToast(t('settings.saved'), 'success');
      await Promise.all([
        loadStatus(),
        loadSettingsConfig(),
      ]);
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setGlobalSettingsSaving(false);
    }
  };

  return {
    status, testingPlatform, globalSettingsSaving, showToast, loadStatus,
    selectedAgentId, setSelectedAgentId,
    publicIshiki, setPublicIshiki, savePublicIshiki,
    tgToken: secretDrafts.telegramToken.value,
    tgTokenDraft: secretDrafts.telegramToken,
    setTgToken,
    fsAppId: credentialFields.feishuAppId.value, setFsAppId,
    fsAppSecret: secretDrafts.feishuAppSecret.value,
    fsAppSecretDraft: secretDrafts.feishuAppSecret,
    setFsAppSecret, fsRegion: credentialFields.feishuRegion.value as FeishuRegion, setFsRegion,
    dtCorpId: credentialFields.dingtalkCorpId.value, setDtCorpId,
    dtClientId: credentialFields.dingtalkClientId.value, setDtClientId,
    dtClientSecret: secretDrafts.dingtalkClientSecret.value,
    dtClientSecretDraft: secretDrafts.dingtalkClientSecret,
    setDtClientSecret,
    dtRobotCode: credentialFields.dingtalkRobotCode.value, setDtRobotCode,
    dtApiBaseUrl: credentialFields.dingtalkApiBaseUrl.value, setDtApiBaseUrl,
    qqAppId: credentialFields.qqAppId.value, setQqAppId,
    qqAppSecret: secretDrafts.qqAppSecret.value,
    qqAppSecretDraft: secretDrafts.qqAppSecret,
    setQqAppSecret,
    saveBridgeConfig, testPlatform, setOwner, saveGlobalSettings,
  };
}
