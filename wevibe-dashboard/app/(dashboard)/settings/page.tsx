'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getExtractionPresets,
  getExtractionProfile,
  getHubResponsePubkey,
  getHubServingAddress,
  getOrg,
  getOrgChainConfig,
  getRecallRateLimit,
  listMembers,
  setRecallRateLimit,
  updateExtractionProfile,
  type ExtractionPreset,
  type MemberRecord,
} from '@/lib/hub-client';
import { type DashboardSettings } from '@/lib/settings';
import { DASHBOARD_SETTINGS_DEFAULTS } from '@/lib/settings-defaults';
import { connectWallet } from '@/lib/wallet-connect';
import {
  buildSetOrgConfigMsg,
  buildSetServingInfoMsg,
  buildSetServingKeyMsg,
  buildTransferLeadershipMsg,
  directBroadcast,
  getOrgAccountAddress,
} from '@/lib/chain-client';
import { txConfirming, txError, txSuccess, txToast } from '@/lib/toast';
import { useOrgContext } from '@/lib/org-context';
import { useDashboardState } from '@/lib/use-dashboard-state';
import { GuardCard } from '@/components/ui/states';
import InfoTooltip from '@/components/ui/tooltip';
import SearchableModelCombobox, { type SearchableModelOption } from '@/components/ui/searchable-model-combobox';

const HUB_RESPONSE_PUBKEY_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
const EXTRACTION_MODEL_MAX_BYTES = 256;
const EXTRACTION_SYSTEM_PROMPT_MAX_BYTES = 16384;
const EXTRACTION_NUM_CTX_MAX = 131072;
const EXTRACTION_TOTAL_STRING_BYTES_MAX = 24576;
type RiskAppetite = 'lowest' | 'neutral';

function byteLengthUtf8(value: string): number {
  return new TextEncoder().encode(value).length;
}

function normalizeRiskAppetite(value: unknown): RiskAppetite {
  return value === 'lowest' ? 'lowest' : 'neutral';
}

function normalizeHubEndpoints(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((endpoint): endpoint is string => typeof endpoint === 'string')
    .map((endpoint) => endpoint.trim())
    .filter((endpoint) => endpoint.length > 0)
    .slice(0, 3);
}

function isValidHttpOrHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function truncateMiddle(value: string, start = 12, end = 8): string {
  if (value.length <= start + end + 1) {
    return value;
  }
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

export default function SettingsPage() {
  const { activeOrg } = useOrgContext();
  const { isLeader } = useDashboardState();
  const orgLoaded = activeOrg !== null;
  const [chainConfigLoading, setChainConfigLoading] = useState(false);
  const [chainConfigError, setChainConfigError] = useState<string | null>(null);
  const [savingChainConfig, setSavingChainConfig] = useState(false);
  const [serveAttestationRequired, setServeAttestationRequired] = useState(false);
  const [recallRateLimitLoading, setRecallRateLimitLoading] = useState(false);
  const [recallRateLimitError, setRecallRateLimitError] = useState<string | null>(null);
  const [savingRecallRateLimit, setSavingRecallRateLimit] = useState(false);
  const [recallRateLimitConfigured, setRecallRateLimitConfigured] = useState<boolean | null>(null);
  const [maxRequests, setMaxRequests] = useState(10);
  const [windowAmount, setWindowAmount] = useState(1);
  const [windowUnit, setWindowUnit] = useState<'1' | '60' | '3600'>('60');
  const [riskAppetiteLoading, setRiskAppetiteLoading] = useState(true);
  const [savingRiskAppetite, setSavingRiskAppetite] = useState(false);
  const [riskAppetite, setRiskAppetite] = useState<RiskAppetite>('neutral');
  const [hubServingAddress, setHubServingAddress] = useState('');
  const [hubEndpoints, setHubEndpoints] = useState<string[]>([]);
  const [hubResponsePubkey, setHubResponsePubkey] = useState('');
  const [hubAdvertisedResponsePubkey, setHubAdvertisedResponsePubkey] = useState('');
  const [showServingKeyEditor, setShowServingKeyEditor] = useState(false);
  const [newServingKey, setNewServingKey] = useState('');
  const [hubInfraError, setHubInfraError] = useState<string | null>(null);
  const [hubInfraSuccess, setHubInfraSuccess] = useState<string | null>(null);
  const [savingServingKey, setSavingServingKey] = useState(false);
  const [showServingInfoEditor, setShowServingInfoEditor] = useState(false);
  const [newHubEndpoints, setNewHubEndpoints] = useState<string[]>(['']);
  const [newHubResponsePubkey, setNewHubResponsePubkey] = useState('');
  const [hubServingInfoError, setHubServingInfoError] = useState<string | null>(null);
  const [hubServingInfoSuccess, setHubServingInfoSuccess] = useState<string | null>(null);
  const [savingServingInfo, setSavingServingInfo] = useState(false);
  const [extractionProfileLoading, setExtractionProfileLoading] = useState(false);
  const [extractionProfileError, setExtractionProfileError] = useState<string | null>(null);
  const [extractionProfileSuccess, setExtractionProfileSuccess] = useState<string | null>(null);
  const [savingExtractionProfile, setSavingExtractionProfile] = useState(false);
  const [extractionProfileUpdatedAt, setExtractionProfileUpdatedAt] = useState<string | null>(null);
  const [hasSavedExtractionProfile, setHasSavedExtractionProfile] = useState<boolean | null>(null);
  const [extractionModel, setExtractionModel] = useState('');
  const [extractionNumCtx, setExtractionNumCtx] = useState('');
  const [extractionSystemPrompt, setExtractionSystemPrompt] = useState('');
  const [extractionPresets, setExtractionPresets] = useState<ExtractionPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [extractionDefaultsMeta, setExtractionDefaultsMeta] = useState<{ num_ctx: number | null; model: string | null }>({
    num_ctx: null,
    model: null,
  });
  const [transferMembers, setTransferMembers] = useState<MemberRecord[]>([]);
  const [transferMembersLoading, setTransferMembersLoading] = useState(false);
  const [transferMembersError, setTransferMembersError] = useState<string | null>(null);
  const [selectedTransferPubkey, setSelectedTransferPubkey] = useState('');
  const [showTransferLeadershipConfirm, setShowTransferLeadershipConfirm] = useState(false);
  const [savingTransferLeadership, setSavingTransferLeadership] = useState(false);

  const transferCandidates = useMemo(() => (
    transferMembers.filter((member) => member.active && member.role !== 'leader')
  ), [transferMembers]);

  const selectedTransferMember = useMemo(() => (
    transferCandidates.find((member) => member.pubkey === selectedTransferPubkey) ?? null
  ), [selectedTransferPubkey, transferCandidates]);

  const getTransferMemberLabel = useCallback((member: MemberRecord): string => {
    const displayName = member.display_name?.trim();
    if (displayName) {
      return displayName;
    }
    const fallback = member.wallet_address?.trim() || member.pubkey;
    return truncateMiddle(fallback);
  }, []);

  const resolveOrgAccountForGas = useCallback(async (): Promise<string> => {
    if (!activeOrg) {
      throw new Error('could not resolve org account for gas');
    }

    try {
      const orgAccount = (await getOrgAccountAddress(activeOrg.org_id)).trim();
      if (!orgAccount) {
        throw new Error('missing org account');
      }
      return orgAccount;
    } catch {
      throw new Error('could not resolve org account for gas');
    }
  }, [activeOrg]);

  useEffect(() => {
    if (!activeOrg) {
      setTransferMembers([]);
      setTransferMembersError(null);
      setTransferMembersLoading(false);
      setSelectedTransferPubkey('');
      setShowTransferLeadershipConfirm(false);
      return;
    }

    let cancelled = false;
    setTransferMembersLoading(true);
    setTransferMembersError(null);

    void listMembers(activeOrg.org_id)
      .then((members) => {
        if (cancelled) return;

        const nextMembers = members ?? [];
        setTransferMembers(nextMembers);

        const nextCandidates = nextMembers.filter((member) => member.active && member.role !== 'leader');
        setSelectedTransferPubkey((previous) => (
          nextCandidates.some((member) => member.pubkey === previous)
            ? previous
            : nextCandidates[0]?.pubkey ?? ''
        ));
      })
      .catch(err => {
        if (cancelled) return;
        setTransferMembers([]);
        setSelectedTransferPubkey('');
        setTransferMembersError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) {
          setTransferMembersLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeOrg]);

  useEffect(() => {
    if (!activeOrg) {
      return;
    }

    let cancelled = false;

    void Promise.all([getOrg(activeOrg.org_id), getHubServingAddress(), getHubResponsePubkey()])
      .then(([summary, fallbackServingAddress, fallbackResponsePubkey]) => {
        if (cancelled) return;

        const summaryServingAddress = summary.hub_serving_address ?? summary.hub_serving_key_address;
        const resolvedServingAddress = [
          typeof summaryServingAddress === 'string' ? summaryServingAddress : '',
          fallbackServingAddress,
        ].find((value) => value.trim().length > 0) ?? '';
        setHubServingAddress(resolvedServingAddress);

        setHubEndpoints(normalizeHubEndpoints(summary.hub_endpoints));

        const normalizedFallbackResponsePubkey = fallbackResponsePubkey.trim();
        const resolvedResponsePubkey = [
          typeof summary.hub_response_pubkey === 'string' ? summary.hub_response_pubkey : '',
          normalizedFallbackResponsePubkey,
        ].find((value) => value.trim().length > 0) ?? '';

        setHubResponsePubkey(resolvedResponsePubkey.trim());
        setHubAdvertisedResponsePubkey(normalizedFallbackResponsePubkey);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeOrg]);

  useEffect(() => {
    if (!activeOrg || !isLeader) {
      setExtractionProfileLoading(false);
      setExtractionProfileError(null);
      setExtractionProfileSuccess(null);
      setExtractionProfileUpdatedAt(null);
      setHasSavedExtractionProfile(null);
      setExtractionModel('');
      setExtractionNumCtx('');
      setExtractionSystemPrompt('');
      setExtractionPresets([]);
      setSelectedPresetId(null);
      setExtractionDefaultsMeta({ num_ctx: null, model: null });
      return;
    }

    let cancelled = false;
    setExtractionProfileLoading(true);
    setExtractionProfileError(null);
    setExtractionProfileSuccess(null);
    setHasSavedExtractionProfile(null);

    void Promise.all([
      getExtractionProfile(activeOrg.org_id),
      getExtractionPresets(),
    ])
      .then(([profileResponse, presetsResponse]) => {
        if (cancelled) {
          return;
        }

        const defaultsModel = typeof presetsResponse.default_model === 'string'
          ? presetsResponse.default_model.trim()
          : '';
        const defaultModel = defaultsModel.length > 0 ? defaultsModel : null;

        const defaultNumCtx = Number.isFinite(presetsResponse.default_num_ctx)
          && presetsResponse.default_num_ctx > 0
          ? Math.floor(presetsResponse.default_num_ctx)
          : null;

        const presets = Array.isArray(presetsResponse.presets)
          ? presetsResponse.presets
          : [];

        const recommendedPreset = (
          presetsResponse.recommended_id
            ? presets.find((preset) => preset.id === presetsResponse.recommended_id)
            : undefined
        ) ?? presets.find((preset) => preset.recommended);

        setExtractionDefaultsMeta({ num_ctx: defaultNumCtx, model: defaultModel });
        setExtractionPresets(presets);

        if (profileResponse.found) {
          setHasSavedExtractionProfile(true);
          setExtractionProfileUpdatedAt(profileResponse.updated_at || null);
          setExtractionModel(profileResponse.model);
          setExtractionNumCtx(profileResponse.num_ctx > 0 ? String(profileResponse.num_ctx) : '');
          setExtractionSystemPrompt(profileResponse.system_prompt);
          const matchingPreset = presets.find((preset) => preset.system_prompt === profileResponse.system_prompt);
          setSelectedPresetId(matchingPreset?.id ?? null);
          return;
        }

        setHasSavedExtractionProfile(false);
        setExtractionProfileUpdatedAt(null);
        setExtractionModel(defaultModel ?? '');
        setExtractionNumCtx(defaultNumCtx !== null ? String(defaultNumCtx) : '');
        setExtractionSystemPrompt(recommendedPreset?.system_prompt ?? '');
        setSelectedPresetId(recommendedPreset?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setHasSavedExtractionProfile(null);
        setExtractionProfileError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) {
          setExtractionProfileLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeOrg, isLeader]);

  useEffect(() => {
    let cancelled = false;
    setRiskAppetiteLoading(true);

    void fetch('/api/settings/risk-appetite', { cache: 'no-store' })
      .then((response) => response.json() as Promise<{ risk_appetite?: unknown }>)
      .then((data) => {
        if (cancelled) {
          return;
        }

        setRiskAppetite(normalizeRiskAppetite(data.risk_appetite));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setRiskAppetite('neutral');
      })
      .finally(() => {
        if (!cancelled) {
          setRiskAppetiteLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeOrg) {
      return;
    }

    let cancelled = false;
    setChainConfigLoading(true);
    setChainConfigError(null);

    void getOrgChainConfig(activeOrg.org_id)
      .then(config => {
        if (cancelled) return;
        setServeAttestationRequired(config.serve_attestation_required);
      })
      .catch(err => {
        if (cancelled) return;
        setChainConfigError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) {
          setChainConfigLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeOrg]);

  useEffect(() => {
    if (!activeOrg || !isLeader) {
      setRecallRateLimitLoading(false);
      setRecallRateLimitError(null);
      setRecallRateLimitConfigured(null);
      setMaxRequests(10);
      setWindowAmount(1);
      setWindowUnit('60');
      return;
    }

    let cancelled = false;
    setRecallRateLimitLoading(true);
    setRecallRateLimitError(null);
    setRecallRateLimitConfigured(null);

    void getRecallRateLimit(activeOrg.org_id)
      .then((rateLimit) => {
        if (cancelled) {
          return;
        }

        setRecallRateLimitConfigured(rateLimit.configured);

        if (!rateLimit.configured) {
          setMaxRequests(10);
          setWindowAmount(1);
          setWindowUnit('60');
          return;
        }

        if (typeof rateLimit.max_requests === 'number' && Number.isFinite(rateLimit.max_requests) && rateLimit.max_requests > 0) {
          setMaxRequests(Math.floor(rateLimit.max_requests));
        }

        if (typeof rateLimit.window_seconds === 'number' && Number.isFinite(rateLimit.window_seconds) && rateLimit.window_seconds > 0) {
          const windowSeconds = Math.floor(rateLimit.window_seconds);
          if (windowSeconds % 3600 === 0) {
            setWindowAmount(windowSeconds / 3600);
            setWindowUnit('3600');
          } else if (windowSeconds % 60 === 0) {
            setWindowAmount(windowSeconds / 60);
            setWindowUnit('60');
          } else {
            setWindowAmount(windowSeconds);
            setWindowUnit('1');
          }
        }
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setRecallRateLimitConfigured(null);
        setRecallRateLimitError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) {
          setRecallRateLimitLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeOrg, isLeader]);

  const handleTransferLeadership = useCallback(async () => {
    if (!activeOrg || !selectedTransferPubkey) {
      return;
    }

    const toastId = txToast('Transfer leadership');
    setSavingTransferLeadership(true);
    setTransferMembersError(null);

    try {
      const target = transferMembers.find(m => m.pubkey === selectedTransferPubkey);
      const targetWalletAddress = target?.wallet_address?.trim();
      if (!targetWalletAddress) {
        txError(toastId, 'The new leader must link a wallet address before leadership can be transferred.');
        return;
      }
      const walletConn = await connectWallet();
      txConfirming(toastId, 'Transfer leadership');
      const msg = buildTransferLeadershipMsg(walletConn.address, activeOrg.org_id, selectedTransferPubkey, targetWalletAddress);
      const orgAccount = await resolveOrgAccountForGas();
      const result = await directBroadcast(walletConn.address, [msg], orgAccount);
      setShowTransferLeadershipConfirm(false);
      txSuccess(toastId, 'Leadership transferred', result.txHash);
    } catch (err) {
      txError(toastId, err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTransferLeadership(false);
    }
  }, [activeOrg, resolveOrgAccountForGas, selectedTransferPubkey, transferMembers]);

  const handleChainConfigSave = useCallback(async (nextServeAttestationRequired: boolean) => {
    if (!activeOrg) {
      return;
    }

    const toastId = txToast('Chain config');

    setSavingChainConfig(true);
    setChainConfigError(null);

    try {
      const walletConn = await connectWallet();
      txConfirming(toastId, 'Chain config');

      const msgSetOrgConfig = buildSetOrgConfigMsg(
        walletConn.address,
        activeOrg.org_id,
        nextServeAttestationRequired,
        0,
        0,
      );

      const orgAccount = await resolveOrgAccountForGas();
      const result = await directBroadcast(walletConn.address, [msgSetOrgConfig], orgAccount);
      setServeAttestationRequired(nextServeAttestationRequired);
      txSuccess(
        toastId,
        `${nextServeAttestationRequired ? 'Serve attestations enabled' : 'Serve attestations disabled'}.`,
        result.txHash,
      );
    } catch (err) {
      txError(toastId, err instanceof Error ? err.message : String(err));
    } finally {
      setSavingChainConfig(false);
    }
  }, [activeOrg, resolveOrgAccountForGas]);

  const handleRecallRateLimitSave = useCallback(async () => {
    if (!activeOrg) {
      return;
    }

    const normalizedMaxRequests = Math.floor(maxRequests);
    if (!Number.isFinite(normalizedMaxRequests) || normalizedMaxRequests < 1) {
      setRecallRateLimitError('Requests must be a positive integer.');
      return;
    }

    const normalizedWindowAmount = Math.floor(windowAmount);
    if (!Number.isFinite(normalizedWindowAmount) || normalizedWindowAmount < 1) {
      setRecallRateLimitError('Window amount must be a positive integer.');
      return;
    }

    const windowSeconds = normalizedWindowAmount * Number(windowUnit);
    if (!Number.isFinite(windowSeconds) || windowSeconds < 1) {
      setRecallRateLimitError('Window duration must be at least 1 second.');
      return;
    }

    const toastId = txToast('Recall rate limit');

    setSavingRecallRateLimit(true);
    setRecallRateLimitError(null);

    try {
      await setRecallRateLimit(activeOrg.org_id, normalizedMaxRequests, windowSeconds);
      setMaxRequests(normalizedMaxRequests);
      setWindowAmount(normalizedWindowAmount);
      setRecallRateLimitConfigured(true);
      txSuccess(toastId, 'Recall rate limit saved.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRecallRateLimitError(message);
      txError(toastId, message);
    } finally {
      setSavingRecallRateLimit(false);
    }
  }, [activeOrg, maxRequests, windowAmount, windowUnit]);

  const handleRiskAppetiteChange = useCallback(async (nextValue: RiskAppetite) => {
    const previousValue = riskAppetite;
    setRiskAppetite(nextValue);
    setSavingRiskAppetite(true);

    const toastId = txToast('Recall risk appetite');

    try {
      const response = await fetch('/api/settings/risk-appetite', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ risk_appetite: nextValue }),
      });

      const payload = await response.json().catch(() => null) as {
        risk_appetite?: unknown;
        error?: unknown;
      } | null;

      if (!response.ok) {
        const message = payload && typeof payload.error === 'string'
          ? payload.error
          : `Failed to save recall risk appetite (${response.status}).`;
        throw new Error(message);
      }

      const normalizedValue = normalizeRiskAppetite(payload?.risk_appetite);
      setRiskAppetite(normalizedValue);
      txSuccess(toastId, `Recall risk appetite set to ${normalizedValue}.`);
    } catch (err) {
      setRiskAppetite(previousValue);
      txError(toastId, err instanceof Error ? err.message : 'Failed to save recall risk appetite.');
    } finally {
      setSavingRiskAppetite(false);
    }
  }, [riskAppetite]);

  const handleServingKeySave = useCallback(async () => {
    if (!activeOrg) {
      return;
    }

    const nextServingKey = newServingKey.trim();
    if (!nextServingKey) {
      setHubInfraError('New serving key address is required.');
      return;
    }

    const toastId = txToast('Serving key');

    setSavingServingKey(true);
    setHubInfraError(null);
    setHubInfraSuccess(null);

    try {
      const walletConn = await connectWallet();
      txConfirming(toastId, 'Serving key');
      const msgSetServingKey = buildSetServingKeyMsg(
        walletConn.address,
        activeOrg.org_id,
        nextServingKey,
      );

      const orgAccount = await resolveOrgAccountForGas();
      const result = await directBroadcast(walletConn.address, [msgSetServingKey], orgAccount);
      setHubServingAddress(nextServingKey);
      setShowServingKeyEditor(false);
      setNewServingKey('');
      setHubInfraSuccess('Serving key updated.');
      txSuccess(toastId, 'Serving key updated.', result.txHash);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setHubInfraError(message);
      txError(toastId, message);
    } finally {
      setSavingServingKey(false);
    }
  }, [activeOrg, newServingKey, resolveOrgAccountForGas]);

  const handleHubEndpointChange = useCallback((index: number, value: string) => {
    setNewHubEndpoints((previous) => previous.map((endpoint, endpointIndex) => (
      endpointIndex === index ? value : endpoint
    )));
  }, []);

  const handleAddHubEndpointRow = useCallback(() => {
    setNewHubEndpoints((previous) => {
      if (previous.length >= 3) {
        return previous;
      }
      return [...previous, ''];
    });
  }, []);

  const handleRemoveHubEndpointRow = useCallback((index: number) => {
    setNewHubEndpoints((previous) => {
      if (previous.length <= 1) {
        return previous;
      }
      return previous.filter((_, endpointIndex) => endpointIndex !== index);
    });
  }, []);

  const handleServingInfoSave = useCallback(async () => {
    if (!activeOrg) {
      return;
    }

    const normalizedEndpoints = newHubEndpoints.map((endpoint) => endpoint.trim());
    if (normalizedEndpoints.length < 1 || normalizedEndpoints.length > 3) {
      setHubServingInfoError('Provide between 1 and 3 hub endpoints.');
      return;
    }
    if (normalizedEndpoints.some((endpoint) => endpoint.length === 0)) {
      setHubServingInfoError('Each hub endpoint row must be non-empty. Remove extra empty rows before broadcast.');
      return;
    }
    if (normalizedEndpoints.some((endpoint) => !isValidHttpOrHttpsUrl(endpoint))) {
      setHubServingInfoError('Hub endpoints must be valid http:// or https:// URLs.');
      return;
    }

    const normalizedResponsePubkey = newHubResponsePubkey.trim();
    if (normalizedResponsePubkey.length > 0 && !HUB_RESPONSE_PUBKEY_HEX_PATTERN.test(normalizedResponsePubkey)) {
      setHubServingInfoError('hub_response_pubkey must be empty or a 64-character hex string.');
      return;
    }

    const toastId = txToast('Serving info');

    setSavingServingInfo(true);
    setHubServingInfoError(null);
    setHubServingInfoSuccess(null);

    try {
      const walletConn = await connectWallet();
      txConfirming(toastId, 'Serving info');
      const msgSetServingInfo = buildSetServingInfoMsg(
        walletConn.address,
        activeOrg.org_id,
        normalizedEndpoints,
        normalizedResponsePubkey,
      );

      const orgAccount = await resolveOrgAccountForGas();
      const result = await directBroadcast(walletConn.address, [msgSetServingInfo], orgAccount);
      setHubEndpoints(normalizedEndpoints);
      setHubResponsePubkey(normalizedResponsePubkey);
      setShowServingInfoEditor(false);
      setNewHubEndpoints(normalizedEndpoints);
      setNewHubResponsePubkey(normalizedResponsePubkey);
      setHubServingInfoSuccess('Serving info updated.');
      txSuccess(toastId, 'Serving info updated.', result.txHash);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setHubServingInfoError(message);
      txError(toastId, message);
    } finally {
      setSavingServingInfo(false);
    }
  }, [activeOrg, newHubEndpoints, newHubResponsePubkey, resolveOrgAccountForGas]);

  const extractionValidation = useMemo(() => {
    const extractionModelBytes = byteLengthUtf8(extractionModel);
    const systemPromptBytes = byteLengthUtf8(extractionSystemPrompt);
    const totalStringBytes = extractionModelBytes
      + systemPromptBytes;

    const extractionModelError = extractionModel.trim().length === 0
      ? 'model is required.'
      : extractionModelBytes > EXTRACTION_MODEL_MAX_BYTES
        ? `model exceeds ${EXTRACTION_MODEL_MAX_BYTES} bytes.`
        : null;
    const systemPromptError = extractionSystemPrompt.trim().length === 0
      ? 'system_prompt is required.'
      : systemPromptBytes > EXTRACTION_SYSTEM_PROMPT_MAX_BYTES
        ? `system_prompt exceeds ${EXTRACTION_SYSTEM_PROMPT_MAX_BYTES} bytes.`
        : null;

    const trimmedNumCtx = extractionNumCtx.trim();
    let parsedNumCtx: number | null = null;
    let numCtxError: string | null = null;
    if (trimmedNumCtx.length === 0) {
      numCtxError = 'num_ctx is required.';
    } else {
      const parsed = Number(trimmedNumCtx);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
        numCtxError = 'num_ctx must be a positive integer.';
      } else if (parsed > EXTRACTION_NUM_CTX_MAX) {
        numCtxError = `num_ctx cannot exceed ${EXTRACTION_NUM_CTX_MAX}.`;
      } else {
        parsedNumCtx = parsed;
      }
    }

    const totalStringBytesError = totalStringBytes > EXTRACTION_TOTAL_STRING_BYTES_MAX
      ? `Total UTF-8 string bytes exceed ${EXTRACTION_TOTAL_STRING_BYTES_MAX}.`
      : null;

    const hasErrors = Boolean(
      extractionModelError
      || systemPromptError
      || numCtxError
      || totalStringBytesError,
    );

    return {
      parsedNumCtx,
      hasErrors,
      bytes: {
        extractionModel: extractionModelBytes,
        systemPrompt: systemPromptBytes,
      },
      totalStringBytes,
      errors: {
        extractionModel: extractionModelError,
        systemPrompt: systemPromptError,
        numCtx: numCtxError,
        totalBytes: totalStringBytesError,
      },
    };
  }, [
    extractionModel,
    extractionNumCtx,
    extractionSystemPrompt,
  ]);

  const markExtractionProfileCustom = useCallback(() => {
    setSelectedPresetId(null);
  }, []);

  const handleSelectExtractionPreset = useCallback((preset: ExtractionPreset) => {
    setSelectedPresetId(preset.id);
    setExtractionSystemPrompt(preset.system_prompt);
    setExtractionNumCtx(String(extractionDefaultsMeta.num_ctx ?? 32768));
    setExtractionModel((previous) => extractionDefaultsMeta.model ?? previous);
  }, [extractionDefaultsMeta.model, extractionDefaultsMeta.num_ctx]);

  const handleExtractionProfileSave = useCallback(async () => {
    if (!activeOrg) {
      return;
    }

    if (extractionValidation.hasErrors || extractionValidation.parsedNumCtx === null) {
      setExtractionProfileError('Resolve extraction profile validation errors before saving.');
      return;
    }

    setSavingExtractionProfile(true);
    setExtractionProfileError(null);
    setExtractionProfileSuccess(null);

    try {
      await updateExtractionProfile(
        activeOrg.org_id,
        {
          system_prompt: extractionSystemPrompt,
          num_ctx: extractionValidation.parsedNumCtx,
          model: extractionModel.trim(),
          preset_id: selectedPresetId ?? '',
        },
      );

      const refreshedProfile = await getExtractionProfile(activeOrg.org_id);

      if (refreshedProfile.found) {
        setHasSavedExtractionProfile(true);
        setExtractionProfileUpdatedAt(refreshedProfile.updated_at || null);
        setExtractionModel(refreshedProfile.model);
        setExtractionNumCtx(refreshedProfile.num_ctx > 0 ? String(refreshedProfile.num_ctx) : '');
        setExtractionSystemPrompt(refreshedProfile.system_prompt);
        const matchingPreset = extractionPresets.find((preset) => preset.system_prompt === refreshedProfile.system_prompt);
        setSelectedPresetId(matchingPreset?.id ?? null);
      } else {
        setHasSavedExtractionProfile(false);
        setExtractionProfileUpdatedAt(null);
      }

      const successMessage = 'Extraction default saved.';
      setExtractionProfileSuccess(successMessage);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setExtractionProfileError(message);
    } finally {
      setSavingExtractionProfile(false);
    }
  }, [
    activeOrg,
    extractionModel,
    extractionPresets,
    extractionSystemPrompt,
    extractionValidation,
    selectedPresetId,
  ]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Org Settings</h1>
        <p className="text-sm text-wv-dim">
          {activeOrg ? `Leader controls for ${activeOrg.org_name}.` : 'Select or create an org to manage its settings.'}
        </p>
      </header>

      {!activeOrg ? (
        <GuardCard title="Select or create an org to manage its settings." />
      ) : (
        <>
          {isLeader && (
            <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-wv-text">Leadership Transfer</h2>
              </div>
              <p className="mt-1 text-sm text-wv-dim">
                Transfer leadership to an active member. This action is irreversible.
              </p>

              {transferMembersError && (
                <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
                  {transferMembersError}
                </div>
              )}

              <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div className="w-full sm:max-w-md">
                    <label htmlFor="leadership-transfer-member" className="block text-sm font-medium text-wv-text">
                      New leader
                    </label>
                    <select
                      id="leadership-transfer-member"
                      value={selectedTransferPubkey}
                      onChange={(event) => setSelectedTransferPubkey(event.target.value)}
                      disabled={transferMembersLoading || savingTransferLeadership || transferCandidates.length === 0}
                      className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                    >
                      {transferCandidates.length === 0 ? (
                        <option value="">No eligible members available</option>
                      ) : (
                        transferCandidates.map((member) => (
                          <option key={member.pubkey} value={member.pubkey}>
                            {member.display_name?.trim() || truncateMiddle(member.wallet_address?.trim() || member.pubkey)}
                          </option>
                        ))
                      )}
                    </select>
                    <p className="mt-2 text-xs text-wv-dim">Only active, non-leader members are eligible.</p>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowTransferLeadershipConfirm(true)}
                    disabled={transferMembersLoading || savingTransferLeadership || !selectedTransferMember || !orgLoaded}
                    className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                  >
                    Transfer Leadership
                  </button>
                </div>
              </div>

              {transferMembersLoading && <p className="mt-4 text-xs text-wv-dim">Loading members…</p>}
            </section>
          )}

          {isLeader && showTransferLeadershipConfirm && selectedTransferMember && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-wv-bg/70 px-4">
              <div className="w-full max-w-md rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
                <h3 className="text-lg font-semibold text-wv-text">Confirm leadership transfer</h3>
                <p className="mt-2 text-sm text-wv-dim">
                  This action is irreversible. <span className="font-medium text-wv-text">{getTransferMemberLabel(selectedTransferMember)}</span> will become the new leader for {activeOrg.org_name}.
                </p>
                <p className="mt-2 text-xs text-wv-dim">
                  You will immediately lose leader permissions for this organization.
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleTransferLeadership}
                    disabled={savingTransferLeadership || !orgLoaded}
                    className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                  >
                    {savingTransferLeadership ? 'Transferring…' : 'Confirm transfer'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowTransferLeadershipConfirm(false)}
                    disabled={savingTransferLeadership}
                    className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-wv-text">Chain Configuration</h2>
              <InfoTooltip label="About chain configuration">
                On-chain org settings enforced by the WeVibe chain. Each change is a wallet-signed transaction.
              </InfoTooltip>
            </div>
            <p className="mt-1 text-sm text-wv-dim">
              Manage on-chain org settings via direct wallet-signed transaction broadcast.
            </p>

            {chainConfigError && (
              <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
                {chainConfigError}
              </div>
            )}

            <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 p-4">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-wv-text">Serve attestations</p>
                      <InfoTooltip label="About serve attestations">
                        Require cryptographic serve attestations before a memory can be served.
                      </InfoTooltip>
                    </div>
                    <p className="mt-1 text-xs text-wv-dim">
                      Current on-chain state:{' '}
                      <span className="font-medium text-wv-text">
                        {serveAttestationRequired ? 'Enabled' : 'Disabled'}
                      </span>
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleChainConfigSave(!serveAttestationRequired)}
                    disabled={chainConfigLoading || savingChainConfig || !orgLoaded}
                    className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                  >
                    {savingChainConfig
                      ? 'Broadcasting…'
                      : serveAttestationRequired
                        ? 'Disable serve attestations'
                        : 'Enable serve attestations'}
                  </button>
                </div>

                <div className="border-t border-wv-line pt-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium text-wv-text">Auto-renewal</p>
                      <p className="mt-1 text-xs text-wv-dim">Reserved for future chain configuration options.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full border border-wv-line-2 bg-wv-panel-3 px-2.5 py-1 text-xs font-medium text-wv-dim">
                        Unavailable
                      </span>
                      <button
                        type="button"
                        disabled
                        className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-3 py-1.5 text-xs font-medium text-wv-dim disabled:cursor-not-allowed"
                      >
                        Unavailable
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {chainConfigLoading && <p className="mt-4 text-xs text-wv-dim">Loading chain config…</p>}
          </section>

          {isLeader && activeOrg && (
            <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-wv-text">Recall Rate Limit</h2>
              </div>
              <p className="mt-1 text-sm text-wv-dim">
                Leader-only. Caps how many recall queries each member can make in the window. No limit set = unlimited.
              </p>

              {recallRateLimitError && (
                <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
                  {recallRateLimitError}
                </div>
              )}

              <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 p-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label htmlFor="recall-max-requests" className="block text-sm font-medium text-wv-text">
                      Requests
                    </label>
                    <input
                      id="recall-max-requests"
                      type="number"
                      min={1}
                      step={1}
                      value={maxRequests}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.target.value, 10);
                        setMaxRequests(Number.isFinite(parsed) ? parsed : 0);
                      }}
                      disabled={savingRecallRateLimit || recallRateLimitLoading}
                      className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                    />
                  </div>

                  <div>
                    <label htmlFor="recall-window-amount" className="block text-sm font-medium text-wv-text">
                      per
                    </label>
                    <input
                      id="recall-window-amount"
                      type="number"
                      min={1}
                      step={1}
                      value={windowAmount}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.target.value, 10);
                        setWindowAmount(Number.isFinite(parsed) ? parsed : 0);
                      }}
                      disabled={savingRecallRateLimit || recallRateLimitLoading}
                      className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                    />
                  </div>

                  <div>
                    <label htmlFor="recall-window-unit" className="block text-sm font-medium text-wv-text">
                      unit
                    </label>
                    <select
                      id="recall-window-unit"
                      value={windowUnit}
                      onChange={(event) => setWindowUnit(event.target.value as '1' | '60' | '3600')}
                      disabled={savingRecallRateLimit || recallRateLimitLoading}
                      className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                    >
                      <option value="1">second</option>
                      <option value="60">minute</option>
                      <option value="3600">hour</option>
                    </select>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleRecallRateLimitSave}
                    disabled={savingRecallRateLimit || recallRateLimitLoading || !orgLoaded}
                    className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                  >
                    {savingRecallRateLimit ? 'Saving…' : 'Save'}
                  </button>

                  {recallRateLimitConfigured === false && (
                    <p className="text-xs text-wv-dim">Currently unlimited (no limit configured).</p>
                  )}
                </div>
              </div>

              {recallRateLimitLoading && <p className="mt-4 text-xs text-wv-dim">Loading recall rate limit…</p>}
            </section>
          )}

          {isLeader && (
            <>
              <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-wv-text">Hub Infrastructure</h2>
                <InfoTooltip label="About hub infrastructure">
                  Advanced: the network endpoints and signing keys your org&apos;s hub uses. Most orgs never change these.
                </InfoTooltip>
              </div>
              <p className="mt-1 text-sm text-wv-dim">
                Control the serving key address used for on-chain serve/denial submissions.
              </p>

              <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-wv-dim">Current HubServingAddress</p>
                <p className="mt-1 break-all font-mono text-sm text-wv-text">{hubServingAddress || '—'}</p>
              </div>

              {hubInfraError && (
                <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
                  {hubInfraError}
                </div>
              )}

              {hubInfraSuccess && (
                <div className="mt-4 rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green break-all">
                  {hubInfraSuccess}
                </div>
              )}

              <div className="mt-4">
                {!showServingKeyEditor ? (
                  <button
                    type="button"
                    onClick={() => {
                      setHubInfraError(null);
                      setHubInfraSuccess(null);
                      setNewServingKey(hubServingAddress);
                      setShowServingKeyEditor(true);
                    }}
                    className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet"
                  >
                    Change serving key (self-host)
                  </button>
                ) : (
                  <div className="rounded-lg border border-[rgba(124,92,255,0.28)] bg-[rgba(124,92,255,0.08)] p-4">
                    <label htmlFor="new-serving-key" className="block text-sm font-medium text-wv-text">
                      New serving key address
                    </label>
                    <input
                      id="new-serving-key"
                      type="text"
                      value={newServingKey}
                      onChange={(event) => setNewServingKey(event.target.value)}
                      placeholder="wevibe1..."
                      disabled={savingServingKey}
                      className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 font-mono text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                    />
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleServingKeySave}
                        disabled={savingServingKey || !orgLoaded}
                        className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                      >
                        {savingServingKey ? 'Broadcasting…' : 'Broadcast MsgSetServingKey'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowServingKeyEditor(false);
                          setNewServingKey('');
                          setHubInfraError(null);
                        }}
                        disabled={savingServingKey}
                        className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-6 rounded-lg border border-wv-line bg-wv-panel-2 p-4">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-wv-dim">Hub endpoints &amp; response key</h3>
                <p className="mt-2 text-xs text-wv-dim">
                  Configure ordered hub endpoint failover (1–3 URLs) and the hub response signature key for clients.
                </p>

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-wv-line bg-wv-panel px-3 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-wv-dim">Current hub_endpoints</p>
                    {hubEndpoints.length > 0 ? (
                      <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm text-wv-text">
                        {hubEndpoints.map((endpoint, index) => (
                          <li key={`${endpoint}-${index}`} className="break-all font-mono text-xs">{endpoint}</li>
                        ))}
                      </ol>
                    ) : (
                      <p className="mt-1 text-sm text-wv-text">—</p>
                    )}
                  </div>

                  <div className="rounded-lg border border-wv-line bg-wv-panel px-3 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-wv-dim">Current hub_response_pubkey</p>
                    <p className="mt-1 break-all font-mono text-xs text-wv-text">{hubResponsePubkey || '—'}</p>
                  </div>
                </div>

                <div className="mt-3 rounded-lg border border-wv-line bg-wv-panel px-3 py-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-wv-dim">This hub&apos;s advertised response_pubkey</p>
                  <p className="mt-1 break-all font-mono text-xs text-wv-text">{hubAdvertisedResponsePubkey || '—'}</p>
                </div>

                {hubServingInfoError && (
                  <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
                    {hubServingInfoError}
                  </div>
                )}

                {hubServingInfoSuccess && (
                  <div className="mt-4 rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green break-all">
                    {hubServingInfoSuccess}
                  </div>
                )}

                <div className="mt-4">
                  {!showServingInfoEditor ? (
                    <button
                      type="button"
                      onClick={() => {
                        setHubServingInfoError(null);
                        setHubServingInfoSuccess(null);
                        setNewHubEndpoints(hubEndpoints.length > 0 ? [...hubEndpoints] : ['']);
                        setNewHubResponsePubkey(hubResponsePubkey || hubAdvertisedResponsePubkey);
                        setShowServingInfoEditor(true);
                      }}
                      className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet"
                    >
                      Edit endpoints &amp; response key
                    </button>
                  ) : (
                    <div className="rounded-lg border border-[rgba(124,92,255,0.28)] bg-[rgba(124,92,255,0.08)] p-4">
                      <p className="text-sm font-medium text-wv-text">Ordered hub endpoints (1–3)</p>
                      <div className="mt-3 flex flex-col gap-3">
                        {newHubEndpoints.map((endpoint, index) => (
                          <div key={`new-hub-endpoint-${index}`} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <label htmlFor={`new-hub-endpoint-${index}`} className="text-xs font-medium uppercase tracking-wide text-wv-dim sm:w-28">
                              Endpoint {index + 1}
                            </label>
                            <input
                              id={`new-hub-endpoint-${index}`}
                              type="url"
                              value={endpoint}
                              onChange={(event) => handleHubEndpointChange(index, event.target.value)}
                              placeholder="https://hub.example.com"
                              disabled={savingServingInfo}
                              className="w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                            />
                            <button
                              type="button"
                              onClick={() => handleRemoveHubEndpointRow(index)}
                              disabled={savingServingInfo || newHubEndpoints.length <= 1}
                              className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-3 py-2 text-xs font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>

                      <div className="mt-3 flex items-center gap-3">
                        <button
                          type="button"
                          onClick={handleAddHubEndpointRow}
                          disabled={savingServingInfo || newHubEndpoints.length >= 3}
                          className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-3 py-2 text-xs font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Add endpoint
                        </button>
                        <span className="text-xs text-wv-dim">{newHubEndpoints.length}/3 configured</span>
                      </div>

                      <div className="mt-4">
                        <label htmlFor="new-hub-response-pubkey" className="block text-sm font-medium text-wv-text">
                          hub_response_pubkey (hex ed25519)
                        </label>
                        <input
                          id="new-hub-response-pubkey"
                          type="text"
                          value={newHubResponsePubkey}
                          onChange={(event) => setNewHubResponsePubkey(event.target.value)}
                          placeholder="64 hex chars (optional)"
                          disabled={savingServingInfo}
                          className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 font-mono text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                        />
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setNewHubResponsePubkey(hubAdvertisedResponsePubkey)}
                            disabled={savingServingInfo || !hubAdvertisedResponsePubkey}
                            className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-3 py-2 text-xs font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Use this hub&apos;s key
                          </button>
                          {!hubAdvertisedResponsePubkey && (
                            <span className="text-xs text-wv-dim">No advertised response key was returned by this hub.</span>
                          )}
                        </div>
                      </div>

                      <div className="mt-4 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleServingInfoSave}
                          disabled={savingServingInfo || !orgLoaded}
                          className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                        >
                          {savingServingInfo ? 'Broadcasting…' : 'Broadcast MsgSetServingInfo'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowServingInfoEditor(false);
                            setHubServingInfoError(null);
                          }}
                          disabled={savingServingInfo}
                          className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              </section>

              <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-wv-text">Extraction Profile</h2>
                  <InfoTooltip label="About extraction profile">
                    Leader-owned extraction defaults stored in the hub and imported by contributors at extraction time.
                  </InfoTooltip>
                </div>
                <p className="mt-1 text-sm text-wv-dim">
                  Contributors import this profile at extraction time; it shapes every memory&apos;s quality and recall.
                </p>

                <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3 text-xs text-wv-dim">
                  <p className="text-wv-text">
                    {hasSavedExtractionProfile === false
                      ? 'No saved extraction default yet. Recommended defaults are prefilled.'
                      : hasSavedExtractionProfile === true
                        ? 'Saved extraction default is active.'
                        : 'Loading extraction default…'}
                  </p>
                  {extractionProfileUpdatedAt && (
                    <p className="mt-1">
                      updated_at: <span className="font-mono text-wv-text">{extractionProfileUpdatedAt}</span>
                    </p>
                  )}
                </div>

                {extractionProfileError && (
                  <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
                    {extractionProfileError}
                  </div>
                )}

                {extractionProfileSuccess && (
                  <div className="mt-4 rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green break-all">
                    {extractionProfileSuccess}
                  </div>
                )}

                <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-wv-dim">Preset</p>
                  {extractionPresets.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {extractionPresets.map((preset) => {
                        const isSelected = preset.id === selectedPresetId;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => handleSelectExtractionPreset(preset)}
                            title={preset.goal}
                            disabled={savingExtractionProfile || extractionProfileLoading}
                            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                              isSelected
                                ? 'border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.12)] text-wv-violet'
                                : 'border-wv-line-2 text-wv-text hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet'
                            } disabled:cursor-not-allowed disabled:opacity-60`}
                          >
                            <span>{preset.label}</span>
                            {preset.recommended && (
                              <span className="rounded-full border border-[rgba(124,92,255,0.35)] bg-[rgba(124,92,255,0.12)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-wv-violet">
                                Recommended
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-wv-dim">No extraction presets are available from the hub.</p>
                  )}
                  {selectedPresetId === null && (
                    <p className="mt-2 text-xs text-wv-dim">Custom profile active (edited under Advanced).</p>
                  )}
                </div>

                {extractionSystemPrompt.trim().length > 0 && (
                  <p className="mt-3 text-xs text-wv-dim">
                    Preference score scale: 0.0 verifiable fact · 0.2–0.3 org convention · 0.5 ambiguous · 0.7–0.8 likely preference · 1.0 pure taste. Every memory is tagged; ≥0.7 is flagged low-quality.
                  </p>
                )}

                <details className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 p-4">
                  <summary className="cursor-pointer text-sm font-medium text-wv-text">
                    Advanced (custom): author your own prompt
                  </summary>

                  <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="extraction-model" className="block text-sm font-medium text-wv-text">
                        model
                      </label>
                      <input
                        id="extraction-model"
                        type="text"
                        value={extractionModel}
                        onChange={(event) => {
                          markExtractionProfileCustom();
                          setExtractionModel(event.target.value);
                        }}
                        placeholder="e.g. the model id your provider serves"
                        disabled={savingExtractionProfile || extractionProfileLoading}
                        className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                      />
                      <p className={`mt-2 text-xs ${extractionValidation.errors.extractionModel ? 'text-wv-red' : 'text-wv-dim'}`}>
                        {extractionValidation.bytes.extractionModel}/{EXTRACTION_MODEL_MAX_BYTES} bytes
                      </p>
                      {extractionValidation.errors.extractionModel && (
                        <p className="mt-1 text-xs text-wv-red">{extractionValidation.errors.extractionModel}</p>
                      )}
                    </div>

                    <div>
                      <label htmlFor="extraction-num-ctx" className="block text-sm font-medium text-wv-text">
                        num_ctx
                      </label>
                      <input
                        id="extraction-num-ctx"
                        type="number"
                        min={1}
                        max={EXTRACTION_NUM_CTX_MAX}
                        step={1}
                        value={extractionNumCtx}
                        onChange={(event) => {
                          markExtractionProfileCustom();
                          setExtractionNumCtx(event.target.value);
                        }}
                        placeholder="32768"
                        disabled={savingExtractionProfile || extractionProfileLoading}
                        className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                      />
                      <p className={`mt-2 text-xs ${extractionValidation.errors.numCtx ? 'text-wv-red' : 'text-wv-dim'}`}>
                        Max {EXTRACTION_NUM_CTX_MAX}
                      </p>
                      {extractionValidation.errors.numCtx && (
                        <p className="mt-1 text-xs text-wv-red">{extractionValidation.errors.numCtx}</p>
                      )}
                    </div>
                  </div>

                  <div className="mt-4">
                    <label htmlFor="extraction-system-prompt" className="block text-sm font-medium text-wv-text">
                      system_prompt
                    </label>
                    <textarea
                      id="extraction-system-prompt"
                      rows={6}
                      value={extractionSystemPrompt}
                      onChange={(event) => {
                        markExtractionProfileCustom();
                        setExtractionSystemPrompt(event.target.value);
                      }}
                      placeholder="System instructions used by extraction."
                      disabled={savingExtractionProfile || extractionProfileLoading}
                      className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                    />
                    <p className={`mt-2 text-xs ${extractionValidation.errors.systemPrompt ? 'text-wv-red' : 'text-wv-dim'}`}>
                      {extractionValidation.bytes.systemPrompt}/{EXTRACTION_SYSTEM_PROMPT_MAX_BYTES} bytes
                    </p>
                    {extractionValidation.errors.systemPrompt && (
                      <p className="mt-1 text-xs text-wv-red">{extractionValidation.errors.systemPrompt}</p>
                    )}
                  </div>

                  <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel px-3 py-2">
                    <p className={`text-xs ${extractionValidation.errors.totalBytes ? 'text-wv-red' : 'text-wv-dim'}`}>
                      Total UTF-8 string bytes: {extractionValidation.totalStringBytes}/{EXTRACTION_TOTAL_STRING_BYTES_MAX}
                    </p>
                    {extractionValidation.errors.totalBytes && (
                      <p className="mt-1 text-xs text-wv-red">{extractionValidation.errors.totalBytes}</p>
                    )}
                  </div>
                </details>

                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExtractionProfileSave}
                    disabled={savingExtractionProfile || extractionProfileLoading || extractionValidation.hasErrors || !orgLoaded}
                    className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                  >
                    {savingExtractionProfile ? 'Saving…' : 'Save extraction default'}
                  </button>
                </div>

                {extractionProfileLoading && (
                  <p className="mt-4 text-xs text-wv-dim">Loading extraction profile…</p>
                )}
              </section>
            </>
          )}

          <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-wv-text">Recall Risk Appetite</h2>
            </div>
            <p className="mt-1 text-sm text-wv-dim">
              Local to this device. &apos;Neutral&apos; recalls all eligible memories. &apos;Lowest&apos; recalls only negative-signal (mistakes to avoid) memories — the strictest filter.
            </p>

            <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 p-4">
              <label htmlFor="recall-risk-appetite" className="block text-sm font-medium text-wv-text">
                Mode
              </label>
              <select
                id="recall-risk-appetite"
                value={riskAppetite}
                onChange={(event) => {
                  const nextValue = normalizeRiskAppetite(event.target.value);
                  void handleRiskAppetiteChange(nextValue);
                }}
                disabled={riskAppetiteLoading || savingRiskAppetite}
                className="mt-2 w-full max-w-xs rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
              >
                <option value="neutral">Neutral</option>
                <option value="lowest">Lowest</option>
              </select>
            </div>

            {riskAppetiteLoading && <p className="mt-4 text-xs text-wv-dim">Loading recall risk appetite…</p>}
          </section>

          <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-wv-text">Org Embedding Model</h2>
              <InfoTooltip label="About org embedding model settings">
                Organization-scoped embedding provider, model, and key settings for this org.
              </InfoTooltip>
            </div>
            <p className="mt-1 text-sm text-wv-dim">
              Configure your organization ID, moderator pubkey, and org embedding provider/model.
            </p>

            <OrgLlamaConfig />
          </section>
        </>
      )}
    </div>
  );
}

function OrgLlamaConfig() {
  const [settings, setSettings] = useState<DashboardSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaModelsError, setOllamaModelsError] = useState(false);
  const [lmStudioModels, setLmStudioModels] = useState<string[]>([]);
  const [lmStudioModelsError, setLmStudioModelsError] = useState(false);
  const [embeddingOpenRouterModels, setEmbeddingOpenRouterModels] = useState<SearchableModelOption[]>([]);
  const [embeddingOpenRouterModelsError, setEmbeddingOpenRouterModelsError] = useState(false);
  const [embeddingReadiness, setEmbeddingReadiness] = useState<{
    ready: boolean;
    dim: number | null;
    provider: 'ollama' | 'openrouter' | 'lm_studio';
    model: string;
    reason: string | null;
  } | null>(null);
  const [embeddingReadinessChecking, setEmbeddingReadinessChecking] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        const s = {
          llm_provider: data.llm_provider ?? DASHBOARD_SETTINGS_DEFAULTS.llm_provider,
          ollama_url: data.ollama_url ?? DASHBOARD_SETTINGS_DEFAULTS.ollama_url,
          ollama_model: data.ollama_model ?? DASHBOARD_SETTINGS_DEFAULTS.ollama_model,
          lmstudio_url: data.lmstudio_url ?? DASHBOARD_SETTINGS_DEFAULTS.lmstudio_url,
          lmstudio_model: data.lmstudio_model ?? DASHBOARD_SETTINGS_DEFAULTS.lmstudio_model,
          extraction_api_key: data.extraction_api_key ?? DASHBOARD_SETTINGS_DEFAULTS.extraction_api_key,
          embedding_api_key: data.embedding_api_key ?? DASHBOARD_SETTINGS_DEFAULTS.embedding_api_key,
          openrouter_model: data.openrouter_model ?? DASHBOARD_SETTINGS_DEFAULTS.openrouter_model,
          embedding_provider: data.embedding_provider ?? DASHBOARD_SETTINGS_DEFAULTS.embedding_provider,
          embedding_ollama_model: data.embedding_ollama_model ?? DASHBOARD_SETTINGS_DEFAULTS.embedding_ollama_model,
          embedding_lmstudio_model: data.embedding_lmstudio_model ?? DASHBOARD_SETTINGS_DEFAULTS.embedding_lmstudio_model,
          embedding_openrouter_model:
            data.embedding_openrouter_model ?? DASHBOARD_SETTINGS_DEFAULTS.embedding_openrouter_model,
          org_id: data.org_id ?? DASHBOARD_SETTINGS_DEFAULTS.org_id,
          mod_pubkey: data.mod_pubkey ?? DASHBOARD_SETTINGS_DEFAULTS.mod_pubkey,
        } as DashboardSettings;
        setSettings(s);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!settings || settings.embedding_provider !== 'ollama') {
      setOllamaModels([]);
      setOllamaModelsError(false);
      return;
    }

    let cancelled = false;

    fetch('/api/ollama-models')
      .then(response => response.json() as Promise<{ models?: unknown; error?: unknown }>)
      .then((data) => {
        if (cancelled) {
          return;
        }

        const models = Array.isArray(data.models)
          ? data.models.filter((model): model is string => typeof model === 'string')
          : [];

        setOllamaModels(models);
        setOllamaModelsError(Boolean(data.error) || models.length === 0);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setOllamaModels([]);
        setOllamaModelsError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [settings?.embedding_provider, settings?.ollama_url]);

  useEffect(() => {
    if (!settings || settings.embedding_provider !== 'lm_studio') {
      setLmStudioModels([]);
      setLmStudioModelsError(false);
      return;
    }

    let cancelled = false;

    fetch('/api/lmstudio-models')
      .then(response => response.json() as Promise<{ models?: unknown; error?: unknown }>)
      .then((data) => {
        if (cancelled) {
          return;
        }

        const models = Array.isArray(data.models)
          ? data.models.filter((model): model is string => typeof model === 'string')
          : [];

        setLmStudioModels(models);
        setLmStudioModelsError(Boolean(data.error) || models.length === 0);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setLmStudioModels([]);
        setLmStudioModelsError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [settings?.embedding_provider, settings?.lmstudio_url]);

  useEffect(() => {
    if (!settings || settings.embedding_provider !== 'openrouter') {
      setEmbeddingOpenRouterModels([]);
      setEmbeddingOpenRouterModelsError(false);
      return;
    }

    let cancelled = false;

    fetch('/api/openrouter-embedding-models')
      .then(response => response.json() as Promise<{ models?: unknown; error?: unknown }>)
      .then((data) => {
        if (cancelled) {
          return;
        }

        const models = Array.isArray(data.models)
          ? data.models
            .map((entry) => {
              if (!entry || typeof entry !== 'object') {
                return null;
              }

              const model = entry as { id?: unknown; name?: unknown };
              if (typeof model.id !== 'string' || model.id.length === 0) {
                return null;
              }

              return {
                id: model.id,
                name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
              };
            })
            .filter((entry): entry is SearchableModelOption => entry !== null)
          : [];

        setEmbeddingOpenRouterModels(models);
        setEmbeddingOpenRouterModelsError(Boolean(data.error) || models.length === 0);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setEmbeddingOpenRouterModels([]);
        setEmbeddingOpenRouterModelsError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [settings?.embedding_provider]);

  const handleSave = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const resp = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (resp.ok) {
        setSaveMsg({ type: 'success', text: 'Settings saved.' });
      } else {
        setSaveMsg({ type: 'error', text: 'Failed to save.' });
      }
    } catch {
      setSaveMsg({ type: 'error', text: 'Network error.' });
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const handleTestEmbedding = useCallback(async () => {
    const fallbackProvider = settings?.embedding_provider ?? 'lm_studio';
    setEmbeddingReadinessChecking(true);
    setEmbeddingReadiness(null);

    try {
      const response = await fetch('/api/settings/embedding-readiness', { cache: 'no-store' });
      const data = await response.json() as {
        ready?: unknown;
        dim?: unknown;
        provider?: unknown;
        model?: unknown;
        reason?: unknown;
      };

      const provider = data.provider === 'ollama' || data.provider === 'openrouter' || data.provider === 'lm_studio'
        ? data.provider
        : fallbackProvider;
      const ready = data.ready === true;
      const reason = typeof data.reason === 'string' && data.reason.trim().length > 0
        ? data.reason
        : !response.ok
          ? `Failed to test embedding readiness (${response.status}).`
          : null;

      setEmbeddingReadiness({
        ready,
        dim: typeof data.dim === 'number' ? data.dim : null,
        provider,
        model: typeof data.model === 'string' ? data.model : '',
        reason,
      });
    } catch (err) {
      setEmbeddingReadiness({
        ready: false,
        dim: null,
        provider: fallbackProvider,
        model: '',
        reason: err instanceof Error ? err.message : 'Failed to test embedding readiness.',
      });
    } finally {
      setEmbeddingReadinessChecking(false);
    }
  }, [settings?.embedding_provider]);

  if (!settings) {
    return <p className="mt-4 text-xs text-wv-dim">Loading settings…</p>;
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="org-id" className="block text-sm font-medium text-wv-text">
            Org ID
          </label>
          <input
            id="org-id"
            type="text"
            value={settings.org_id}
            onChange={e => setSettings(s => s ? { ...s, org_id: e.target.value } : s)}
            placeholder="my-org"
            className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
          />
        </div>
        <div>
          <label htmlFor="mod-pubkey" className="block text-sm font-medium text-wv-text">
            Mod Pubkey (X25519 hex)
          </label>
          <input
            id="mod-pubkey"
            type="text"
            value={settings.mod_pubkey}
            onChange={e => setSettings(s => s ? { ...s, mod_pubkey: e.target.value } : s)}
            placeholder="a1b2c3..."
            className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] font-mono"
          />
        </div>
      </div>

      <div className="rounded-lg border border-wv-line bg-wv-panel-2 p-4">
        <h3 className="text-sm font-semibold text-wv-text">Vector Embedding</h3>
        <p className="mt-1 text-xs text-wv-dim">
          Choose the provider and model used for vector embeddings.
        </p>

        <div className="mt-4">
          <label htmlFor="embedding-provider" className="block text-sm font-medium text-wv-text">
            Embedding Provider
          </label>
          <select
            id="embedding-provider"
            value={settings.embedding_provider}
            onChange={e => setSettings(s => s ? { ...s, embedding_provider: e.target.value as 'ollama' | 'openrouter' | 'lm_studio' } : s)}
            className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
          >
            <option value="ollama">Ollama</option>
            <option value="lm_studio">LM Studio</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </div>

        {settings.embedding_provider === 'ollama' && (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="embedding-ollama-url" className="block text-sm font-medium text-wv-text">
                Ollama URL
              </label>
              <input
                id="embedding-ollama-url"
                type="url"
                value={settings.ollama_url}
                readOnly
                className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-3 px-3 py-2 text-sm text-wv-dim shadow-wv-sm"
              />
            </div>
            <div>
              <label htmlFor="embedding-ollama-model" className="block text-sm font-medium text-wv-text">
                Ollama Embedding Model
              </label>
              {ollamaModels.length > 0 ? (
                <>
                  <select
                    id="embedding-ollama-model"
                    value={settings.embedding_ollama_model}
                    onChange={e => setSettings(s => s ? { ...s, embedding_ollama_model: e.target.value } : s)}
                    className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                  >
                    {settings.embedding_ollama_model && !ollamaModels.includes(settings.embedding_ollama_model) && (
                      <option value={settings.embedding_ollama_model}>{settings.embedding_ollama_model}</option>
                    )}
                    {ollamaModels.map((model) => (
                      <option key={`embedding-${model}`} value={model}>{model}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-wv-dim">Detected from your local Ollama.</p>
                </>
              ) : (
                <>
                  <input
                    id="embedding-ollama-model"
                    type="text"
                    value={settings.embedding_ollama_model}
                    onChange={e => setSettings(s => s ? { ...s, embedding_ollama_model: e.target.value } : s)}
                    placeholder="nomic-embed-text:v1.5"
                    className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                  />
                  {ollamaModelsError && (
                    <p className="mt-1 text-xs text-wv-dim">Could not reach Ollama at {settings.ollama_url} — enter a model name manually.</p>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {settings.embedding_provider === 'lm_studio' && (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="embedding-lmstudio-url" className="block text-sm font-medium text-wv-text">
                LM Studio URL
              </label>
              <input
                id="embedding-lmstudio-url"
                type="url"
                value={settings.lmstudio_url}
                readOnly
                className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-3 px-3 py-2 text-sm text-wv-dim shadow-wv-sm"
              />
            </div>
            <div>
              <label htmlFor="embedding-lmstudio-model" className="block text-sm font-medium text-wv-text">
                LM Studio Embedding Model
              </label>
              {lmStudioModels.length > 0 ? (
                <>
                  <select
                    id="embedding-lmstudio-model"
                    value={settings.embedding_lmstudio_model}
                    onChange={e => setSettings(s => s ? { ...s, embedding_lmstudio_model: e.target.value } : s)}
                    className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                  >
                    {settings.embedding_lmstudio_model && !lmStudioModels.includes(settings.embedding_lmstudio_model) && (
                      <option value={settings.embedding_lmstudio_model}>{settings.embedding_lmstudio_model}</option>
                    )}
                    {lmStudioModels.map((model) => (
                      <option key={`embedding-${model}`} value={model}>{model}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-wv-dim">Detected from your local LM Studio.</p>
                </>
              ) : (
                <>
                  <input
                    id="embedding-lmstudio-model"
                    type="text"
                    value={settings.embedding_lmstudio_model}
                    onChange={e => setSettings(s => s ? { ...s, embedding_lmstudio_model: e.target.value } : s)}
                    placeholder="text-embedding-nomic-embed-text-v1.5"
                    className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                  />
                  {lmStudioModelsError && (
                    <p className="mt-1 text-xs text-wv-dim">Could not reach LM Studio at {settings.lmstudio_url} — enter a model name manually.</p>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {settings.embedding_provider === 'openrouter' && (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="embedding-openrouter-api-key" className="block text-sm font-medium text-wv-text">
                OpenRouter API Key
              </label>
              <input
                id="embedding-openrouter-api-key"
                type="password"
                value={settings.embedding_api_key}
                onChange={e => setSettings(s => s ? { ...s, embedding_api_key: e.target.value } : s)}
                placeholder="sk-..."
                className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
              />
              <p className="mt-1 text-xs text-wv-dim">Used for OpenRouter embedding requests.</p>
            </div>
            <div>
              <label htmlFor="embedding-openrouter-model" className="block text-sm font-medium text-wv-text">
                OpenRouter Embedding Model
              </label>
              <SearchableModelCombobox
                id="embedding-openrouter-model"
                value={settings.embedding_openrouter_model}
                onChange={nextValue => setSettings(s => s ? { ...s, embedding_openrouter_model: nextValue } : s)}
                options={embeddingOpenRouterModels}
                placeholder="(not recommended — must match hub 768-d)"
                className="mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
              />
              {embeddingOpenRouterModels.length > 0 ? (
                <p className="mt-1 text-xs text-wv-dim">Search OpenRouter embedding models or type any model id manually.</p>
              ) : embeddingOpenRouterModelsError ? (
                <p className="mt-1 text-xs text-wv-dim">Could not load OpenRouter embedding models — enter a model id manually.</p>
              ) : null}
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              void handleTestEmbedding();
            }}
            disabled={embeddingReadinessChecking}
            className="inline-flex items-center rounded-md border border-wv-line-2 px-3 py-1.5 text-xs font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-70"
          >
            {embeddingReadinessChecking ? 'Testing…' : 'Test embedding'}
          </button>
          <span className="text-xs text-wv-dim">Checks saved settings from disk.</span>
        </div>

        {embeddingReadiness?.ready ? (
          <div className="mt-3 rounded-lg border border-[rgba(51,214,166,0.4)] bg-[rgba(51,214,166,0.12)] px-3 py-2 text-sm text-wv-green">
            ✓ {embeddingReadiness.model || settings.embedding_openrouter_model} ready ({embeddingReadiness.dim ?? 'unknown'}-dim)
          </div>
        ) : null}

        {embeddingReadiness && !embeddingReadiness.ready ? (
          <div className="mt-3 rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-3 py-2 text-sm text-wv-amber">
            {embeddingReadiness.reason || 'Embedding readiness check failed.'}
          </div>
        ) : null}
      </div>

      {saveMsg && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${saveMsg.type === 'success' ? 'border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] text-wv-green' : 'border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] text-wv-red'}`}>
          {saveMsg.text}
        </div>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="inline-flex items-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
      >
        {saving ? 'Saving…' : 'Save Settings'}
      </button>
    </div>
  );
}
