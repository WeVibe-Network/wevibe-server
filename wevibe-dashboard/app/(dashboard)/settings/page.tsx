'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { NotificationPreferencesSection } from '@/components/notifications/notification-preferences-section';
import { PairPlugin } from '@/components/pairing/pair-plugin';
import SearchableModelCombobox, { type SearchableModelOption } from '@/components/ui/searchable-model-combobox';
import Toggle from '@/components/ui/toggle';
import InfoTooltip from '@/components/ui/tooltip';
import { useIdentity } from '@/lib/identity-context';
import type { DashboardSettings } from '@/lib/settings';
import { DASHBOARD_SETTINGS_DEFAULTS } from '@/lib/settings-defaults';
import { txError, txSuccess, txToast } from '@/lib/toast';
import { clearWalletAddress, setWalletAddress } from '@/lib/wevibe-auth';
import { connectWallet, disconnectWallet } from '@/lib/wallet-connect';
import { toast } from 'sonner';

function normalizeDashboardSettings(value: Partial<DashboardSettings>): DashboardSettings {
  return {
    llm_provider:
      value.llm_provider === 'openrouter' || value.llm_provider === 'lm_studio'
        ? value.llm_provider
        : DASHBOARD_SETTINGS_DEFAULTS.llm_provider,
    ollama_url: value.ollama_url ?? DASHBOARD_SETTINGS_DEFAULTS.ollama_url,
    ollama_model: value.ollama_model ?? DASHBOARD_SETTINGS_DEFAULTS.ollama_model,
    extraction_api_key: value.extraction_api_key ?? DASHBOARD_SETTINGS_DEFAULTS.extraction_api_key,
    embedding_api_key: value.embedding_api_key ?? DASHBOARD_SETTINGS_DEFAULTS.embedding_api_key,
    extraction_model_override:
      value.extraction_model_override ?? DASHBOARD_SETTINGS_DEFAULTS.extraction_model_override,
    extraction_override_enabled:
      value.extraction_override_enabled ?? DASHBOARD_SETTINGS_DEFAULTS.extraction_override_enabled,
    lmstudio_url: value.lmstudio_url ?? DASHBOARD_SETTINGS_DEFAULTS.lmstudio_url,
    lmstudio_model: value.lmstudio_model ?? DASHBOARD_SETTINGS_DEFAULTS.lmstudio_model,
    embedding_provider:
      value.embedding_provider === 'ollama'
      || value.embedding_provider === 'openrouter'
      || value.embedding_provider === 'lm_studio'
        ? value.embedding_provider
        : DASHBOARD_SETTINGS_DEFAULTS.embedding_provider,
    embedding_ollama_model:
      value.embedding_ollama_model ?? DASHBOARD_SETTINGS_DEFAULTS.embedding_ollama_model,
    embedding_lmstudio_model:
      value.embedding_lmstudio_model ?? DASHBOARD_SETTINGS_DEFAULTS.embedding_lmstudio_model,
    embedding_openrouter_model:
      value.embedding_openrouter_model ?? DASHBOARD_SETTINGS_DEFAULTS.embedding_openrouter_model,
    org_id: value.org_id ?? DASHBOARD_SETTINGS_DEFAULTS.org_id,
    mod_pubkey: value.mod_pubkey ?? DASHBOARD_SETTINGS_DEFAULTS.mod_pubkey,
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

type RiskAppetite = 'lowest' | 'neutral';

function normalizeRiskAppetite(value: unknown): RiskAppetite {
  return value === 'lowest' ? 'lowest' : 'neutral';
}

function truncateAddress(addr: string) {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

export default function SettingsPage() {
  const { walletAddress, refresh } = useIdentity();

  const [connectingWallet, setConnectingWallet] = useState(false);
  const [disconnectingWallet, setDisconnectingWallet] = useState(false);
  const [walletActionError, setWalletActionError] = useState<string | null>(null);

  const [settings, setSettings] = useState<DashboardSettings | null>(null);
  const [persistedSettings, setPersistedSettings] = useState<DashboardSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<CertifiedReadiness | null>(null);
  const [readinessChecking, setReadinessChecking] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaModelsError, setOllamaModelsError] = useState(false);
  const [lmStudioModels, setLmStudioModels] = useState<string[]>([]);
  const [lmStudioModelsError, setLmStudioModelsError] = useState(false);
  const [openRouterModels, setOpenRouterModels] = useState<SearchableModelOption[]>([]);
  const [openRouterModelsError, setOpenRouterModelsError] = useState(false);
  const [riskAppetiteLoading, setRiskAppetiteLoading] = useState(true);
  const [savingRiskAppetite, setSavingRiskAppetite] = useState(false);
  const [riskAppetite, setRiskAppetite] = useState<RiskAppetite>('neutral');
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
    if (!settings) {
      return;
    }

    if (settings.llm_provider === 'openrouter' && settings.extraction_api_key.trim().length === 0) {
      setSettingsError('An OpenRouter API key is required when the provider is OpenRouter (a non-local provider). Add your key before saving.');
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
  }, [runReadinessCheck, settings]);

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

  const openRouterApiKeyChanged = Boolean(
    settings?.extraction_api_key && !settings.extraction_api_key.startsWith('••••'),
  );

  const extractionOverrideOptions: SearchableModelOption[] = settings
    ? settings.llm_provider === 'openrouter'
      ? openRouterModels
      : (settings.llm_provider === 'lm_studio' ? lmStudioModels : ollamaModels)
        .map((model) => ({ id: model, name: model }))
    : [];

  const isSettingsDirty = Boolean(
    settings
    && persistedSettings
    && (
      settings.llm_provider !== persistedSettings.llm_provider
      || settings.ollama_url !== persistedSettings.ollama_url
      || settings.ollama_model !== persistedSettings.ollama_model
      || settings.lmstudio_url !== persistedSettings.lmstudio_url
      || settings.lmstudio_model !== persistedSettings.lmstudio_model
      || settings.extraction_model_override !== persistedSettings.extraction_model_override
      || settings.extraction_override_enabled !== persistedSettings.extraction_override_enabled
      || openRouterApiKeyChanged
    ),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-wv-dim">Your personal WeVibe settings for this browser identity.</p>
      </header>

      <div className="space-y-6">
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
            <h3 className="text-lg font-semibold text-wv-text">Extraction Model</h3>
            <InfoTooltip label="App & Model settings">
              Local app preferences: the language model used for extraction. Stored on this device.
            </InfoTooltip>
          </div>

          <div className="mt-4 space-y-4">
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
                  <div>
                    <label htmlFor="profile-openrouter-key" className="block text-sm font-medium text-wv-text">
                      OpenRouter API Key
                    </label>
                    <input
                      id="profile-openrouter-key"
                      type="password"
                      value={settings.extraction_api_key}
                      onChange={event => setSettings(current => (
                        current
                          ? {
                            ...current,
                            extraction_api_key: event.target.value,
                          }
                          : current
                      ))}
                      className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                    />
                  </div>
                )}

                <div>
                  <div className="mb-3 flex items-center gap-2 text-sm font-medium text-wv-text">
                    <Toggle
                      id="profile-extraction-override-enabled"
                      checked={settings.extraction_override_enabled}
                      onChange={next => setSettings(current => (
                        current
                          ? {
                            ...current,
                            extraction_override_enabled: next,
                          }
                          : current
                      ))}
                      aria-labelledby="profile-extraction-override-toggle-label"
                    />
                    <span id="profile-extraction-override-toggle-label">Use fixed extraction model (override each session&apos;s own model)</span>
                  </div>
                  {settings.extraction_override_enabled && (
                    <>
                      <label htmlFor="profile-extraction-model-override" className="block text-sm font-medium text-wv-text">
                        Override extraction model
                      </label>
                      <SearchableModelCombobox
                        id="profile-extraction-model-override"
                        value={settings.extraction_model_override}
                        onChange={nextValue => setSettings(current => (
                          current
                            ? {
                              ...current,
                              extraction_model_override: nextValue,
                            }
                            : current
                        ))}
                        options={extractionOverrideOptions}
                        disabled={!settings.extraction_override_enabled}
                        placeholder="anthropic/claude-opus-4"
                        className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:opacity-50"
                      />
                      {settings.llm_provider === 'openrouter' && openRouterModelsError ? (
                        <p className="mt-2 text-xs text-wv-dim">Could not load OpenRouter models — enter a model id manually.</p>
                      ) : null}
                      <p className="mt-2 text-xs text-wv-dim">Blank = use each session's own recorded model (default). Set a model id to force ALL extractions to run with that one fixed model.</p>
                    </>
                  )}
                </div>
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

        <NotificationPreferencesSection />
      </div>
    </div>
  );
}
