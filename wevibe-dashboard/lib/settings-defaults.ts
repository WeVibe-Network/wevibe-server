import type { DashboardSettings } from './settings';

export const DASHBOARD_SETTINGS_DEFAULTS: DashboardSettings = {
  llm_provider: 'ollama',
  ollama_url: 'http://localhost:11434',
  ollama_model: '',
  extraction_api_key: '',
  embedding_api_key: '',
  extraction_model_override: '',
  extraction_override_enabled: false,
  lmstudio_url: 'http://127.0.0.1:1234/v1',
  lmstudio_model: '',
  embedding_provider: 'ollama',
  embedding_ollama_model: 'nomic-embed-text:v1.5',
  embedding_lmstudio_model: 'text-embedding-nomic-embed-text-v1.5',
  embedding_openrouter_model: '',
  org_id: '',
  mod_pubkey: '',
};
