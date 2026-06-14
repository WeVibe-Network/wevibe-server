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
    openrouter_api_key: settings.openrouter_api_key
      ? '••••' + settings.openrouter_api_key.slice(-4)
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
    openrouter_api_key:
      body.openrouter_api_key && !body.openrouter_api_key.startsWith('••••')
        ? body.openrouter_api_key
        : current.openrouter_api_key,
    openrouter_model: body.openrouter_model ?? current.openrouter_model,
    lmstudio_url: body.lmstudio_url ?? current.lmstudio_url,
    lmstudio_model: body.lmstudio_model ?? current.lmstudio_model,
    org_id: body.org_id ?? current.org_id,
    mod_pubkey: body.mod_pubkey ?? current.mod_pubkey,
  };

  saveSettings(updated);
  invalidateReadinessCache();
  return NextResponse.json({
    ...updated,
    openrouter_api_key: updated.openrouter_api_key
      ? '••••' + updated.openrouter_api_key.slice(-4)
      : '',
  });
}
