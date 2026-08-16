import { type DashboardSettings, getProviderReadiness } from './settings';

export interface CertifiedReadiness {
  ready: boolean;
  reason: string | null;
  provider: 'ollama' | 'openrouter' | 'lm_studio' | 'orcarouter';
  model: string;
  stage: 'config' | 'live';
  checkedAt: number;
  transient: boolean;
}

const CERTIFIED_READINESS_TTL_MS = 60_000;

let readinessCache: { signature: string; result: CertifiedReadiness } | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readOpenRouterModelIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }

  return payload.data
    .map((entry) => (isRecord(entry) && typeof entry.id === 'string' ? entry.id : ''))
    .filter((id): id is string => id.length > 0);
}

function readOllamaModelNames(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    return [];
  }

  return payload.models
    .map((entry) => (isRecord(entry) && typeof entry.name === 'string' ? entry.name : ''))
    .filter((name): name is string => name.length > 0);
}

function buildSignature(
  settings: DashboardSettings,
  provider: CertifiedReadiness['provider'],
  model: string,
): string {
  return `${provider}|${model}|${settings.ollama_url}|${settings.lmstudio_url}|${settings.extraction_api_key.length > 0}`;
}

function toCertifiedReadiness(
  provider: CertifiedReadiness['provider'],
  model: string,
  ready: boolean,
  reason: string | null,
  stage: CertifiedReadiness['stage'],
  transient: boolean,
): CertifiedReadiness {
  return {
    ready,
    reason,
    provider,
    model,
    stage,
    checkedAt: Date.now(),
    transient,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return 'unknown error';
}

export function invalidateReadinessCache(): void {
  readinessCache = null;
}

export async function getCertifiedReadiness(
  s: DashboardSettings,
  effectiveModel?: string,
): Promise<CertifiedReadiness> {
  const provider = s.llm_provider;
  const hasEffectiveModel =
    typeof effectiveModel === 'string' && effectiveModel.trim().length > 0;

  // Extraction is session-bound by default (mirrors app/api/extract/route.ts):
  // effective = (extraction_override_enabled && extraction_model_override) ? override : sessionModel.
  // Global readiness (no effectiveModel passed) has no session model in scope, so with the
  // override toggle OFF there is no fixed extraction model to validate — extraction is ready
  // (each session brings its own model, validated at extract time). Only when the override is
  // enabled do we validate the pinned override slug against the /profile provider.
  if (!hasEffectiveModel && !s.extraction_override_enabled) {
    return toCertifiedReadiness(provider, '', true, null, 'config', false);
  }

  const settingsModel = provider === 'lm_studio'
      ? s.lmstudio_model.trim()
      : s.ollama_model.trim();
  const model = hasEffectiveModel
    ? effectiveModel!.trim()
    : s.extraction_override_enabled
      ? s.extraction_model_override.trim()
      : provider === 'openrouter'
        ? ''
        : settingsModel;

  const cfg = getProviderReadiness(s);
  if (!cfg.ready) {
    return toCertifiedReadiness(provider, model, false, cfg.reason, 'config', false);
  }

  const signature = buildSignature(s, provider, model);
  if (
    readinessCache !== null
    && readinessCache.signature === signature
    && Date.now() - readinessCache.result.checkedAt < CERTIFIED_READINESS_TTL_MS
  ) {
    return {
      ...readinessCache.result,
      checkedAt: Date.now(),
    };
  }

  let result: CertifiedReadiness;

  try {
    if (provider === 'openrouter') {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${s.extraction_api_key}`,
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      });

      if (response.status === 401 || response.status === 403) {
        result = toCertifiedReadiness(
          provider,
          model,
          false,
          `OpenRouter rejected the API key (HTTP ${response.status}). Re-check the key in Profile -> App & Model settings.`,
          'live',
          false,
        );
      } else if (!response.ok) {
        result = toCertifiedReadiness(
          provider,
          model,
          false,
          `OpenRouter is unreachable (HTTP ${response.status}). Retry shortly.`,
          'live',
          true,
        );
      } else {
        const modelIds = readOpenRouterModelIds((await response.json()) as unknown);

        result = modelIds.includes(model)
          ? toCertifiedReadiness(provider, model, true, null, 'live', false)
          : toCertifiedReadiness(
            provider,
            model,
            false,
            `Model "${model}" is not available on OpenRouter for this key. Pick a valid model in Profile -> App & Model settings.`,
            'live',
            false,
          );
      }
    } else if (provider === 'lm_studio') {
      const lmStudioUrl = s.lmstudio_url.trim().replace(/\/$/, '');
      const url = `${lmStudioUrl}/models`;
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        result = toCertifiedReadiness(
          provider,
          model,
          false,
          `LM Studio is unreachable at ${url} (HTTP ${response.status}). Is it running?`,
          'live',
          true,
        );
      } else {
        const modelIds = readOpenRouterModelIds((await response.json()) as unknown);

        result = modelIds.includes(model)
          ? toCertifiedReadiness(provider, model, true, null, 'live', false)
          : toCertifiedReadiness(
            provider,
            model,
            false,
            `LM Studio is reachable but model "${model}" is not loaded/available. Load it in LM Studio or pick another in Profile → App & Model settings.`,
            'live',
            false,
          );
      }
    } else {
      const ollamaUrl = s.ollama_url.trim();
      const response = await fetch(`${ollamaUrl}/api/tags`, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        result = toCertifiedReadiness(
          provider,
          model,
          false,
          `Ollama is unreachable at ${ollamaUrl} (HTTP ${response.status}). Is it running?`,
          'live',
          true,
        );
      } else {
        const modelNames = readOllamaModelNames((await response.json()) as unknown);

        result = modelNames.includes(model)
          ? toCertifiedReadiness(provider, model, true, null, 'live', false)
          : toCertifiedReadiness(
            provider,
            model,
            false,
            `Ollama is reachable but model "${model}" is not pulled. Run: ollama pull ${model}.`,
            'live',
            false,
          );
      }
    }
  } catch (error: unknown) {
    result = toCertifiedReadiness(
      provider,
      model,
      false,
      `${provider} is unreachable (${errorMessage(error)}). Retry shortly.`,
      'live',
      true,
    );
  }

  if (!result.transient) {
    readinessCache = {
      signature,
      result,
    };
  }

  return result;
}
