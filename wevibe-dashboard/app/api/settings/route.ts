import { NextRequest, NextResponse } from 'next/server';
import { invalidateReadinessCache } from '@/lib/provider-readiness';
import {
  getProviderReadiness,
  loadSettings,
  saveSettings,
  type DashboardSettings,
} from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  const settings = loadSettings();
  const providerReadiness = getProviderReadiness(settings);
  return NextResponse.json({
    ...settings,
    extraction_api_key: settings.extraction_api_key
      ? '••••' + settings.extraction_api_key.slice(-4)
      : '',
    embedding_api_key: settings.embedding_api_key
      ? '••••' + settings.embedding_api_key.slice(-4)
      : '',
    provider_ready: providerReadiness.ready,
    provider_ready_reason: providerReadiness.reason,
  });
}

export async function PUT(request: NextRequest) {
  const body = (await request.json()) as Partial<DashboardSettings>;
  const current = loadSettings();

  const updated: DashboardSettings = {
    llm_provider: body.llm_provider ?? current.llm_provider,
    ollama_url: body.ollama_url ?? current.ollama_url,
    ollama_model: body.ollama_model ?? current.ollama_model,
    extraction_api_key:
      body.extraction_api_key && !body.extraction_api_key.startsWith('••••')
        ? body.extraction_api_key
        : current.extraction_api_key,
    embedding_api_key:
      body.embedding_api_key && !body.embedding_api_key.startsWith('••••')
        ? body.embedding_api_key
        : current.embedding_api_key,
    openrouter_model: body.openrouter_model ?? current.openrouter_model,
    extraction_model_override:
      body.extraction_model_override ?? current.extraction_model_override,
    extraction_override_enabled:
      body.extraction_override_enabled ?? current.extraction_override_enabled,
    lmstudio_url: body.lmstudio_url ?? current.lmstudio_url,
    lmstudio_model: body.lmstudio_model ?? current.lmstudio_model,
    embedding_provider: body.embedding_provider ?? current.embedding_provider,
    embedding_ollama_model:
      body.embedding_ollama_model ?? current.embedding_ollama_model,
    embedding_lmstudio_model:
      body.embedding_lmstudio_model ?? current.embedding_lmstudio_model,
    embedding_openrouter_model:
      body.embedding_openrouter_model ?? current.embedding_openrouter_model,
    org_id: body.org_id ?? current.org_id,
    mod_pubkey: body.mod_pubkey ?? current.mod_pubkey,
    deployment: body.deployment ?? current.deployment,
  };

  saveSettings(updated);
  invalidateReadinessCache();
  return NextResponse.json({
    ...updated,
    extraction_api_key: updated.extraction_api_key
      ? '••••' + updated.extraction_api_key.slice(-4)
      : '',
    embedding_api_key: updated.embedding_api_key
      ? '••••' + updated.embedding_api_key.slice(-4)
      : '',
  });
}
