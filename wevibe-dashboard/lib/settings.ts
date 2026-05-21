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
  ollama_url: 'http://localhost:11434',
  ollama_model: 'qwen2.5:14b',
  openrouter_api_key: '',
  openrouter_model: 'anthropic/claude-sonnet-4',
  org_id: '',
  mod_pubkey: '',
};

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