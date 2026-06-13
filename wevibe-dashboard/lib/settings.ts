import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface DashboardSettings {
  llm_provider: 'ollama' | 'openrouter';
  ollama_url: string;
  ollama_model: string;
  openrouter_api_key: string;
  openrouter_model: string;
  org_id: string;
  mod_pubkey: string;
}

const DEFAULTS: DashboardSettings = {
  llm_provider: 'ollama',
  ollama_url: process.env.WEVIBE_OLLAMA_URL ?? 'http://localhost:11434',
  ollama_model: '',
  openrouter_api_key: '',
  openrouter_model: '',
  org_id: '',
  mod_pubkey: '',
};

export function getProviderReadiness(
  s: DashboardSettings,
): { ready: boolean; reason: string | null } {
  if (s.llm_provider === 'openrouter') {
    if (s.openrouter_api_key.trim().length === 0) {
      return {
        ready: false,
        reason: 'OpenRouter API key is not set — add it in Profile → App & Model settings and click Save.',
      };
    }

    if (s.openrouter_model.trim().length === 0) {
      return {
        ready: false,
        reason: 'OpenRouter model is not set — choose a model in Profile → App & Model settings and click Save.',
      };
    }

    return { ready: true, reason: null };
  }

  if (s.ollama_model.trim().length === 0) {
    return {
      ready: false,
      reason: 'Ollama model is not set — set it in Profile → App & Model settings and click Save.',
    };
  }

  return { ready: true, reason: null };
}

function settingsPath(): string {
  return join(homedir(), '.config', 'wevibe', 'dashboard.json');
}

export function loadSettings(): DashboardSettings {
  const path = settingsPath();
  if (!existsSync(path)) return { ...DEFAULTS };

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DashboardSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: DashboardSettings): void {
  const path = settingsPath();
  const dir = join(homedir(), '.config', 'wevibe');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8');
}
