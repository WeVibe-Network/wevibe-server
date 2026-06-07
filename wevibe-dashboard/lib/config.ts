export interface WevibeConfig {
  hubUrl: string;
  mcpUrl: string;
  chainId: string;
  chainRpc: string;
  chainRest: string;
  socialGraphUrl: string;
  bech32Prefix: string;
  coinDenom: string;
  coinMinDenom: string;
}

export const WEVIBE_CONFIG_GLOBAL = '__WEVIBE_CONFIG__';
export const DEFAULT_WEVIBE_MCP_HTTP_URL = 'http://127.0.0.1:4450';

const DEFAULT_CONFIG: WevibeConfig = {
  hubUrl: 'http://localhost:4440',
  mcpUrl: 'http://localhost:4451',
  chainId: 'wevibe-local-1',
  chainRpc: 'http://localhost:26657',
  chainRest: 'http://localhost:1317',
  socialGraphUrl: 'http://localhost:4470',
  bech32Prefix: 'wevibe',
  coinDenom: 'VIBE',
  coinMinDenom: 'uvibe',
};

export function readConfigFromEnv(): WevibeConfig {
  return {
    hubUrl: process.env.WEVIBE_HUB_URL ?? DEFAULT_CONFIG.hubUrl,
    mcpUrl: process.env.WEVIBE_MCP_URL ?? DEFAULT_CONFIG.mcpUrl,
    chainId: process.env.WEVIBE_CHAIN_ID ?? DEFAULT_CONFIG.chainId,
    chainRpc: process.env.WEVIBE_CHAIN_RPC ?? DEFAULT_CONFIG.chainRpc,
    chainRest: process.env.WEVIBE_CHAIN_REST ?? DEFAULT_CONFIG.chainRest,
    socialGraphUrl: process.env.WEVIBE_SOCIAL_GRAPH_URL ?? DEFAULT_CONFIG.socialGraphUrl,
    bech32Prefix: process.env.WEVIBE_BECH32_PREFIX ?? DEFAULT_CONFIG.bech32Prefix,
    coinDenom: process.env.WEVIBE_COIN_DENOM ?? DEFAULT_CONFIG.coinDenom,
    coinMinDenom: process.env.WEVIBE_COIN_MIN_DENOM ?? DEFAULT_CONFIG.coinMinDenom,
  };
}

export function getConfig(): WevibeConfig {
  if (typeof window === 'undefined') {
    return readConfigFromEnv();
  }

  const runtimeConfig = (window as any)[WEVIBE_CONFIG_GLOBAL] as WevibeConfig | undefined;
  return runtimeConfig ?? readConfigFromEnv();
}

export function hubWsUrl(path: string): string {
  const hubUrl = new URL(getConfig().hubUrl);
  hubUrl.protocol = hubUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return new URL(path, hubUrl).toString();
}

export function getMcpHttpUrl(): string {
  const configuredUrl = process.env.WEVIBE_MCP_HTTP_URL?.trim();
  return configuredUrl && configuredUrl.length > 0
    ? configuredUrl
    : DEFAULT_WEVIBE_MCP_HTTP_URL;
}
