'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PairPlugin } from '@/components/pairing/pair-plugin';
import InfoTooltip from '@/components/ui/tooltip';
import SearchableModelCombobox, { type SearchableModelOption } from '@/components/ui/searchable-model-combobox';
import { getConfig } from '@/lib/config';
import { getProfile, type ProfileResponse } from '@/lib/hub-client';
import { useIdentity } from '@/lib/identity-context';
import { resetMcpClient } from '@/lib/mcp-client';
import type { DashboardSettings } from '@/lib/settings';
import { txError, txSuccess, txToast } from '@/lib/toast';
import { clearWalletAddress, getIdentity, setWalletAddress } from '@/lib/wevibe-auth';
import { connectWallet, disconnectWallet } from '@/lib/wallet-connect';
import ClientTime from '@/components/ui/client-time';
import { toast } from 'sonner';

const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  llm_provider: 'ollama',
  ollama_url: 'http://localhost:11434',
  ollama_model: 'qwen2.5:14b',
  openrouter_api_key: '',
  openrouter_model: 'anthropic/claude-sonnet-4',
  lmstudio_url: 'http://127.0.0.1:1234/v1',
  lmstudio_model: '',
  org_id: '',
  mod_pubkey: '',
};

function normalizeDashboardSettings(value: Partial<DashboardSettings>): DashboardSettings {
  return {
    llm_provider:
      value.llm_provider === 'openrouter' || value.llm_provider === 'lm_studio'
        ? value.llm_provider
        : 'ollama',
    ollama_url: value.ollama_url ?? DEFAULT_DASHBOARD_SETTINGS.ollama_url,
    ollama_model: value.ollama_model ?? DEFAULT_DASHBOARD_SETTINGS.ollama_model,
    openrouter_api_key: value.openrouter_api_key ?? DEFAULT_DASHBOARD_SETTINGS.openrouter_api_key,
    openrouter_model: value.openrouter_model ?? DEFAULT_DASHBOARD_SETTINGS.openrouter_model,
    lmstudio_url: value.lmstudio_url ?? DEFAULT_DASHBOARD_SETTINGS.lmstudio_url,
    lmstudio_model: value.lmstudio_model ?? DEFAULT_DASHBOARD_SETTINGS.lmstudio_model,
    org_id: value.org_id ?? DEFAULT_DASHBOARD_SETTINGS.org_id,
    mod_pubkey: value.mod_pubkey ?? DEFAULT_DASHBOARD_SETTINGS.mod_pubkey,
  };
}

interface CertifiedReadiness {
  ready: boolean;
  reason: string | null;
  provider: 'ollama' | 'openrouter' | 'lm_studio';
  model: string;
  stage: 'config' | 'live';
  checkedAt: number;
  transient: boolean;
}

export default function ProfilePage() {
  const { walletAddress, refresh } = useIdentity();

  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [connectingWallet, setConnectingWallet] = useState(false);
  const [disconnectingWallet, setDisconnectingWallet] = useState(false);
  const [walletActionError, setWalletActionError] = useState<string | null>(null);

  const [mcpUrl, setMcpUrl] = useState(() => getConfig().mcpUrl);
  const [settings, setSettings] = useState<DashboardSettings | null>(null);
  const [persistedSettings, setPersistedSettings] = useState<DashboardSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [localSaveMessage, setLocalSaveMessage] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<CertifiedReadiness | null>(null);
  const [readinessChecking, setReadinessChecking] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaModelsError, setOllamaModelsError] = useState(false);
  const [lmStudioModels, setLmStudioModels] = useState<string[]>([]);
  const [lmStudioModelsError, setLmStudioModelsError] = useState(false);
  const [openRouterModels, setOpenRouterModels] = useState<SearchableModelOption[]>([]);
  const [openRouterModelsError, setOpenRouterModelsError] = useState(false);
  const readinessCheckInFlightRef = useRef(false);
  const lastReadinessToastReasonRef = useRef<string | null>(null);

  const runReadinessCheck = useCallback(async () => {
    if (readinessCheckInFlightRef.current) {
      return;
    }

    readinessCheckInFlightRef.current = true;
    setReadinessChecking(true);

    let settledReadiness: CertifiedReadiness | null = null;

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) {
          const backoffMs = attempt === 1 ? 1000 : 2000;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, backoffMs);
          });
        }

        const response = await fetch('/api/settings/readiness', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Failed to check model availability (${response.status}).`);
        }

        const data = await response.json() as CertifiedReadiness;
        settledReadiness = data;
        setReadiness(data);

        if (!data.transient) {
          break;
        }
      }

      if (settledReadiness?.ready) {
        lastReadinessToastReasonRef.current = null;
        return;
      }

      if (settledReadiness) {
        const reason = settledReadiness.reason?.trim() || 'Provider/model readiness check failed.';
        if (lastReadinessToastReasonRef.current !== reason) {
          toast.error(reason);
          lastReadinessToastReasonRef.current = reason;
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Failed to check model availability.';

      setReadiness((current) => ({
        ready: false,
        reason,
        provider: current?.provider ?? 'ollama',
        model: current?.model ?? '',
        stage: 'live',
        checkedAt: Date.now(),
        transient: false,
      }));

      if (lastReadinessToastReasonRef.current !== reason) {
        toast.error(reason);
        lastReadinessToastReasonRef.current = reason;
      }
    } finally {
      readinessCheckInFlightRef.current = false;
      setReadinessChecking(false);
    }
  }, []);

  useEffect(() => {
    async function loadProfile() {
      const identity = await getIdentity();
      if (!identity) {
        setError('No identity found. Generate an identity first.');
        setLoading(false);
        return;
      }

      try {
        const data = await getProfile(identity.pubkeyHex);
        setProfile(data);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    void loadProfile();
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedUrl = window.localStorage.getItem('wevibe-mcp-url') ?? getConfig().mcpUrl;
      setMcpUrl(savedUrl);
    }

    let cancelled = false;
    setSettingsLoading(true);
    setSettingsError(null);

    fetch('/api/settings')
      .then(async response => {
        if (!response.ok) {
          throw new Error(`Failed to load settings (${response.status}).`);
        }
        return response.json() as Promise<Partial<DashboardSettings>>;
      })
      .then(data => {
        if (cancelled) {
          return;
        }

        const normalized = normalizeDashboardSettings(data);
        setSettings(normalized);
        setPersistedSettings(normalized);
        void runReadinessCheck();
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : 'Failed to load settings.';
        setSettingsError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setSettingsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [runReadinessCheck]);

  useEffect(() => {
    if (!settings || settings.llm_provider !== 'ollama') {
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
  }, [settings?.llm_provider, settings?.ollama_url]);

  useEffect(() => {
    if (!settings || settings.llm_provider !== 'lm_studio') {
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
  }, [settings?.llm_provider, settings?.lmstudio_url]);

  useEffect(() => {
    if (!settings || settings.llm_provider !== 'openrouter') {
      setOpenRouterModels([]);
      setOpenRouterModelsError(false);
      return;
    }

    let cancelled = false;

    fetch('/api/openrouter-models')
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

        setOpenRouterModels(models);
        setOpenRouterModelsError(Boolean(data.error) || models.length === 0);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setOpenRouterModels([]);
        setOpenRouterModelsError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [settings?.llm_provider]);

  const handleWalletConnect = useCallback(async () => {
    setWalletActionError(null);
    setConnectingWallet(true);

    try {
      const conn = await connectWallet('keplr');
      await setWalletAddress(conn.address);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect wallet.';
      setWalletActionError(message);
    } finally {
      setConnectingWallet(false);
    }
  }, [refresh]);

  const handleWalletDisconnect = useCallback(async () => {
    setWalletActionError(null);
    setDisconnectingWallet(true);

    try {
      await disconnectWallet('keplr');
      await clearWalletAddress();
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to disconnect wallet.';
      setWalletActionError(message);
    } finally {
      setDisconnectingWallet(false);
    }
  }, [refresh]);

  const handleSaveAppAndModelSettings = useCallback(async () => {
    const normalizedMcpUrl = mcpUrl.trim() || getConfig().mcpUrl;

    if (typeof window !== 'undefined') {
      window.localStorage.setItem('wevibe-mcp-url', normalizedMcpUrl);
      void resetMcpClient(normalizedMcpUrl).connect().catch(() => {});
    }
    setMcpUrl(normalizedMcpUrl);
    setLocalSaveMessage('MCP URL saved on this device.');

    if (!settings) {
      return;
    }

    setSettingsSaving(true);
    setSettingsError(null);

    const toastId = txToast('Settings');

    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });

      if (!response.ok) {
        throw new Error(`Failed to save settings (${response.status}).`);
      }

      const data = await response.json() as Partial<DashboardSettings>;
      const normalized = normalizeDashboardSettings(data);
      setSettings(normalized);
      setPersistedSettings(normalized);
      txSuccess(toastId, 'Settings saved.');
      void runReadinessCheck();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save settings.';
      txError(toastId, message);
      setSettingsError(message);
    } finally {
      setSettingsSaving(false);
    }
  }, [mcpUrl, runReadinessCheck, settings]);

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-wv-panel-2" />
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-24 animate-pulse rounded-xl border border-wv-line bg-wv-panel" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-red">
          {error}
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-lg border border-wv-line px-4 py-6 text-center text-sm text-wv-dim">
          Profile not found.
        </div>
      </div>
    );
  }

  const truncateAddress = (addr: string) => {
    if (addr.length <= 16) return addr;
    return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
  };

  const copyAddress = () => {
    navigator.clipboard.writeText(profile.wallet);
  };

  const roleBadge = (role: string) => {
    switch (role) {
      case 'leader':
        return 'border border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.14)] text-wv-violet';
      case 'moderator':
        return 'border border-wv-cyan bg-[rgba(52,220,240,0.12)] text-wv-cyan';
      case 'contributor':
        return 'border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.14)] text-wv-amber';
      default:
        return 'border border-wv-line bg-wv-panel-2 text-wv-dim';
    }
  };

  const openRouterApiKeyChanged = Boolean(
    settings?.openrouter_api_key && !settings.openrouter_api_key.startsWith('••••'),
  );

  const isSettingsDirty = Boolean(
    settings
    && persistedSettings
    && (
      settings.llm_provider !== persistedSettings.llm_provider
      || settings.ollama_url !== persistedSettings.ollama_url
      || settings.ollama_model !== persistedSettings.ollama_model
      || settings.lmstudio_url !== persistedSettings.lmstudio_url
      || settings.lmstudio_model !== persistedSettings.lmstudio_model
      || settings.openrouter_model !== persistedSettings.openrouter_model
      || openRouterApiKeyChanged
    ),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-wv-dim">Your WeVibe Network identity and stats.</p>
      </header>

      <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-wv-text">Identity</h2>
            {profile.display_name && (
              <p className="mt-1 text-sm font-medium text-wv-text">{profile.display_name}</p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <code className="rounded bg-wv-panel-2 px-2 py-1 text-sm font-mono text-wv-text">
                {truncateAddress(profile.wallet)}
              </code>
              <button
                onClick={copyAddress}
                className="text-xs text-wv-violet hover:text-wv-text"
              >
                Copy
              </button>
            </div>
            {profile.pubkey && (
              <p className="mt-1 text-xs font-mono text-wv-dim">
                Pubkey: {profile.pubkey.slice(0, 8)}...{profile.pubkey.slice(-4)}
              </p>
            )}
          </div>
        </div>
      </div>

      {profile.memberships && profile.memberships.length > 0 && (
        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <h2 className="text-lg font-semibold text-wv-text">Organizations</h2>
          <div className="mt-4 space-y-3">
            {profile.memberships.map(membership => (
              <div
                key={membership.org_id}
                className="flex items-center justify-between rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3"
              >
                <div>
                  <p className="font-medium text-wv-text">{membership.org_name}</p>
                  <p className="text-xs font-mono text-wv-dim">
                    Joined <ClientTime value={membership.joined_at} mode="date" />
                  </p>
                </div>
                <span className={`rounded-full px-2 py-1 text-xs font-medium ${roleBadge(membership.role)}`}>
                  {membership.role}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {profile.chain_stats && (
        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <h2 className="text-lg font-semibold text-wv-text">Contribution Stats</h2>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                {profile.chain_stats.total_approved_memories}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Approved Memories</p>
            </div>
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                {profile.chain_stats.total_serves}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Total Serves</p>
            </div>
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                Epoch {profile.chain_stats.first_seen_epoch}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">First Seen</p>
            </div>
          </div>
          {profile.chain_stats.reputation_tier && (
            <div className="mt-4">
              <span className="rounded-full border border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.14)] px-3 py-1 text-sm font-medium text-wv-violet">
                Reputation: {profile.chain_stats.reputation_tier}
              </span>
            </div>
          )}
        </div>
      )}

      {profile.moderator_stats && (
        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <h2 className="text-lg font-semibold text-wv-text">Moderator Activity</h2>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                {profile.moderator_stats.total_approvals}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Total Approvals</p>
            </div>
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                {profile.moderator_stats.total_upheld_reports}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Upheld Reports</p>
            </div>
          </div>
        </div>
      )}

      {profile.leader_stats && (
        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <h2 className="text-lg font-semibold text-wv-text">Leader Activity</h2>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                {profile.leader_stats.total_chain_commits}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Chain Commits</p>
            </div>
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                {profile.leader_stats.total_epoch_rotations}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Epoch Rotations</p>
            </div>
          </div>
        </div>
      )}

      {!profile.chain_stats && !profile.moderator_stats && !profile.leader_stats && (
        <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel p-6 text-center text-sm text-wv-dim">
          No on-chain activity yet.
        </div>
      )}

      <section className="space-y-4">
        <header className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight text-wv-text">Settings</h2>
          <p className="text-sm text-wv-dim">Personal settings for this browser identity.</p>
        </header>

        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-lg font-semibold text-wv-text">Wallet</h3>
            <InfoTooltip label="Wallet">
              Your Cosmos wallet. Required to create or lead an org and to claim rewards — not needed to join or contribute.
            </InfoTooltip>
          </div>

          <p className="mt-1 text-sm text-wv-dim">
            {walletAddress ? 'Connected wallet for this identity:' : 'No wallet connected for this identity.'}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {walletAddress ? (
              <>
                <code className="rounded bg-wv-panel-2 px-2 py-1 text-sm font-mono text-wv-text">
                  {truncateAddress(walletAddress)}
                </code>
                <button
                  type="button"
                  onClick={handleWalletDisconnect}
                  disabled={disconnectingWallet || connectingWallet}
                  className="rounded-md border border-wv-line px-3 py-1 text-xs font-medium text-wv-dim transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {disconnectingWallet ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleWalletConnect}
                disabled={connectingWallet || disconnectingWallet}
                className="rounded-md bg-wv-grad-btn px-3 py-1 text-xs font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {connectingWallet ? 'Connecting…' : 'Connect Wallet'}
              </button>
            )}
          </div>

          {walletActionError ? (
            <p className="mt-3 text-sm text-wv-red">{walletActionError}</p>
          ) : null}
        </div>

        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-lg font-semibold text-wv-text">Plugin pairing</h3>
            <InfoTooltip label="Plugin pairing">
              Generate a one-time code to link your local WeVibe plugin to this browser identity.
            </InfoTooltip>
          </div>
          <div className="mt-4">
            <PairPlugin />
          </div>
        </div>

        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-lg font-semibold text-wv-text">App &amp; Model settings</h3>
            <InfoTooltip label="App & Model settings">
              Local app preferences: your MCP server URL and the language model used for extraction. Stored on this device.
            </InfoTooltip>
          </div>

          <div className="mt-4 space-y-4">
            <div>
              <label htmlFor="profile-mcp-url" className="block text-sm font-medium text-wv-text">
                MCP Server URL
              </label>
              <input
                id="profile-mcp-url"
                type="url"
                value={mcpUrl}
                onChange={event => {
                  setMcpUrl(event.target.value);
                  setLocalSaveMessage(null);
                }}
                placeholder={getConfig().mcpUrl}
                className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
              />
              <p className="mt-2 text-xs text-wv-dim">Used by this browser only.</p>
            </div>

            {settingsLoading ? (
              <p className="text-xs text-wv-dim">Loading model settings…</p>
            ) : settings ? (
              <>
                <div>
                  <label htmlFor="profile-llm-provider" className="block text-sm font-medium text-wv-text">
                    LLM Provider
                  </label>
                  <select
                    id="profile-llm-provider"
                    value={settings.llm_provider}
                    onChange={event => setSettings(current => (
                      current
                        ? {
                          ...current,
                          llm_provider: event.target.value as 'ollama' | 'openrouter' | 'lm_studio',
                        }
                        : current
                    ))}
                    className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                  >
                    <option value="ollama">Ollama</option>
                    <option value="openrouter">OpenRouter</option>
                    <option value="lm_studio">LM Studio</option>
                  </select>
                </div>

                {settings.llm_provider === 'ollama' ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="profile-ollama-url" className="block text-sm font-medium text-wv-text">
                        Ollama URL
                      </label>
                      <input
                        id="profile-ollama-url"
                        type="url"
                        value={settings.ollama_url}
                        onChange={event => setSettings(current => (
                          current
                            ? {
                              ...current,
                              ollama_url: event.target.value,
                            }
                            : current
                        ))}
                        className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                      />
                    </div>
                    <div>
                      <label htmlFor="profile-ollama-model" className="block text-sm font-medium text-wv-text">
                        Ollama Model
                      </label>
                      {ollamaModels.length > 0 ? (
                        <>
                          <select
                            id="profile-ollama-model"
                            value={settings.ollama_model}
                            onChange={event => setSettings(current => (
                              current
                                ? {
                                  ...current,
                                  ollama_model: event.target.value,
                                }
                                : current
                            ))}
                            className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                          >
                            {settings.ollama_model && !ollamaModels.includes(settings.ollama_model) && (
                              <option value={settings.ollama_model}>{settings.ollama_model}</option>
                            )}
                            {ollamaModels.map((model) => (
                              <option key={model} value={model}>{model}</option>
                            ))}
                          </select>
                          <p className="mt-2 text-xs text-wv-dim">Detected from your local Ollama.</p>
                        </>
                      ) : (
                        <>
                          <input
                            id="profile-ollama-model"
                            type="text"
                            value={settings.ollama_model}
                            onChange={event => setSettings(current => (
                              current
                                ? {
                                  ...current,
                                  ollama_model: event.target.value,
                                }
                                : current
                            ))}
                            className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                          />
                          {ollamaModelsError ? (
                            <p className="mt-2 text-xs text-wv-dim">Could not reach Ollama at {settings.ollama_url} — enter a model name manually.</p>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                ) : settings.llm_provider === 'lm_studio' ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="profile-lmstudio-url" className="block text-sm font-medium text-wv-text">
                        LM Studio URL
                      </label>
                      <input
                        id="profile-lmstudio-url"
                        type="url"
                        value={settings.lmstudio_url}
                        onChange={event => setSettings(current => (
                          current
                            ? {
                              ...current,
                              lmstudio_url: event.target.value,
                            }
                            : current
                        ))}
                        className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                      />
                    </div>
                    <div>
                      <label htmlFor="profile-lmstudio-model" className="block text-sm font-medium text-wv-text">
                        LM Studio Model
                      </label>
                      {lmStudioModels.length > 0 ? (
                        <>
                          <select
                            id="profile-lmstudio-model"
                            value={settings.lmstudio_model}
                            onChange={event => setSettings(current => (
                              current
                                ? {
                                  ...current,
                                  lmstudio_model: event.target.value,
                                }
                                : current
                            ))}
                            className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                          >
                            {settings.lmstudio_model && !lmStudioModels.includes(settings.lmstudio_model) && (
                              <option value={settings.lmstudio_model}>{settings.lmstudio_model}</option>
                            )}
                            {lmStudioModels.map((model) => (
                              <option key={model} value={model}>{model}</option>
                            ))}
                          </select>
                          <p className="mt-2 text-xs text-wv-dim">Detected from your local LM Studio.</p>
                        </>
                      ) : (
                        <>
                          <input
                            id="profile-lmstudio-model"
                            type="text"
                            value={settings.lmstudio_model}
                            onChange={event => setSettings(current => (
                              current
                                ? {
                                  ...current,
                                  lmstudio_model: event.target.value,
                                }
                                : current
                            ))}
                            className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                          />
                          {lmStudioModelsError ? (
                            <p className="mt-2 text-xs text-wv-dim">Could not reach LM Studio at {settings.lmstudio_url} — enter a model name manually.</p>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="profile-openrouter-key" className="block text-sm font-medium text-wv-text">
                        OpenRouter API Key
                      </label>
                      <input
                        id="profile-openrouter-key"
                        type="password"
                        value={settings.openrouter_api_key}
                        onChange={event => setSettings(current => (
                          current
                            ? {
                              ...current,
                              openrouter_api_key: event.target.value,
                            }
                            : current
                        ))}
                        className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                      />
                    </div>
                    <div>
                      <label htmlFor="profile-openrouter-model" className="block text-sm font-medium text-wv-text">
                        OpenRouter Model
                      </label>
                      <SearchableModelCombobox
                        id="profile-openrouter-model"
                        value={settings.openrouter_model}
                        onChange={nextValue => setSettings(current => (
                          current
                            ? {
                              ...current,
                              openrouter_model: nextValue,
                            }
                            : current
                        ))}
                        options={openRouterModels}
                        placeholder="anthropic/claude-sonnet-4"
                        className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                      />
                      {openRouterModels.length > 0 ? (
                        <p className="mt-2 text-xs text-wv-dim">Search OpenRouter public models or type any model id manually.</p>
                      ) : openRouterModelsError ? (
                        <p className="mt-2 text-xs text-wv-dim">Could not load OpenRouter models — enter a model id manually.</p>
                      ) : null}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-wv-dim">
                Model settings are unavailable right now.
              </p>
            )}

            {settingsError ? (
              <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
                {settingsError}
              </div>
            ) : null}

            {localSaveMessage ? (
              <p className="text-xs text-wv-green">{localSaveMessage}</p>
            ) : null}

            {isSettingsDirty ? (
              <div className="rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-3 py-2 text-sm text-wv-amber">
                Unsaved changes — extraction uses your SAVED settings. Click Save Settings to apply.
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleSaveAppAndModelSettings}
                disabled={settingsSaving || settingsLoading}
                className={`inline-flex items-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim ${isSettingsDirty ? 'ring-2 ring-[rgba(255,178,85,0.4)] ring-offset-2 ring-offset-wv-panel' : ''}`}
              >
                {settingsSaving ? 'Saving…' : 'Save Settings'}
              </button>
            </div>

            {readinessChecking && !readiness ? (
              <p className="text-xs text-wv-dim">Checking model availability…</p>
            ) : null}

            {readiness?.ready ? (
              <div className="rounded-lg border border-[rgba(51,214,166,0.4)] bg-[rgba(51,214,166,0.12)] px-3 py-2 text-sm text-wv-green">
                ✓ {readiness.model} verified available on {readiness.provider}.
              </div>
            ) : null}

            {readiness && !readiness.ready ? (
              <div className="rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-3 py-2 text-sm text-wv-amber">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>{readiness.reason || 'Provider/model readiness check failed.'}</span>
                  <button
                    type="button"
                    onClick={() => {
                      void runReadinessCheck();
                    }}
                    disabled={readinessChecking}
                    className="inline-flex items-center rounded-md border border-[rgba(255,178,85,0.6)] px-3 py-1 text-xs font-medium text-wv-amber transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {readinessChecking ? 'Checking…' : 'Re-check'}
                  </button>
                </div>
              </div>
            ) : null}

            {isSettingsDirty ? (
              <p className="text-xs text-wv-amber">Save to certify your changes.</p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
