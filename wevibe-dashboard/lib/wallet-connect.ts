import { OfflineSigner } from '@cosmjs/proto-signing';

interface KeplrKey {
  name: string;
  algo: string;
  pubKey: Uint8Array;
  address: Uint8Array;
  bech32Address: string;
  isNanoLedger: boolean;
  isKeystone: boolean;
}

interface KeplrChainInfo {
  chainId: string;
  chainName: string;
  rpc: string;
  rest: string;
  bip44: { coinType: number };
  bech32Config: {
    bech32PrefixAccAddr: string;
    bech32PrefixAccPub: string;
    bech32PrefixValAddr: string;
    bech32PrefixValPub: string;
    bech32PrefixConsAddr: string;
    bech32PrefixConsPub: string;
  };
  currencies: Array<{
    coinDenom: string;
    coinMinimalDenom: string;
    coinDecimals: number;
  }>;
  feeCurrencies: Array<{
    coinDenom: string;
    coinMinimalDenom: string;
    coinDecimals: number;
    gasPriceStep: { low: number; average: number; high: number };
  }>;
  stakeCurrency: {
    coinDenom: string;
    coinMinimalDenom: string;
    coinDecimals: number;
  };
}

interface Keplr {
  enable(chainId: string): Promise<void>;
  getKey(chainId: string): Promise<KeplrKey>;
  experimentalSuggestChain(chainInfo: KeplrChainInfo): Promise<void>;
  getOfflineSigner(chainId: string): OfflineSigner;
  signArbitrary(chainId: string, address: string, message: string): Promise<{
    pub_key: { value: string };
    signature: string;
  }>;
}

declare global {
  interface Window {
    keplr?: Keplr;
    leap?: Keplr;
  }
}

export interface WeVibeChainConfig {
  chainId: string;
  chainName: string;
  rpc: string;
  rest: string;
  bech32Prefix: string;
  coinDenom: string;
  coinMinimalDenom: string;
  coinDecimals: number;
}

export function getChainConfig(): WeVibeChainConfig {
  return {
    chainId: process.env.NEXT_PUBLIC_WEVIBE_CHAIN_ID || 'wevibe-local-1',
    chainName: 'WeVibe Network',
    rpc: process.env.NEXT_PUBLIC_WEVIBE_CHAIN_RPC || 'http://localhost:26657',
    rest: process.env.NEXT_PUBLIC_WEVIBE_CHAIN_REST || 'http://localhost:1317',
    bech32Prefix: process.env.NEXT_PUBLIC_WEVIBE_BECH32_PREFIX || 'wevibe',
    coinDenom: process.env.NEXT_PUBLIC_WEVIBE_COIN_DENOM || 'VIBE',
    coinMinimalDenom: process.env.NEXT_PUBLIC_WEVIBE_COIN_MIN_DENOM || 'uvibe',
    coinDecimals: 6,
  };
}

function buildKeplrChainInfo(config: WeVibeChainConfig): KeplrChainInfo {
  const prefix = config.bech32Prefix;
  return {
    chainId: config.chainId,
    chainName: config.chainName,
    rpc: config.rpc,
    rest: config.rest,
    bip44: { coinType: 118 },
    bech32Config: {
      bech32PrefixAccAddr: prefix,
      bech32PrefixAccPub: `${prefix}pub`,
      bech32PrefixValAddr: `${prefix}valoper`,
      bech32PrefixValPub: `${prefix}valoperpub`,
      bech32PrefixConsAddr: `${prefix}valcons`,
      bech32PrefixConsPub: `${prefix}valconspub`,
    },
    currencies: [{
      coinDenom: config.coinDenom,
      coinMinimalDenom: config.coinMinimalDenom,
      coinDecimals: config.coinDecimals,
    }],
    feeCurrencies: [{
      coinDenom: config.coinDenom,
      coinMinimalDenom: config.coinMinimalDenom,
      coinDecimals: config.coinDecimals,
      gasPriceStep: { low: 0.01, average: 0.025, high: 0.04 },
    }],
    stakeCurrency: {
      coinDenom: config.coinDenom,
      coinMinimalDenom: config.coinMinimalDenom,
      coinDecimals: config.coinDecimals,
    },
  };
}

export type WalletProvider = 'keplr' | 'leap';

export interface WalletConnection {
  provider: WalletProvider;
  address: string;
  pubKey: Uint8Array;
  name: string;
}

export function detectWallets(): WalletProvider[] {
  const providers: WalletProvider[] = [];
  if (typeof window !== 'undefined') {
    if (window.keplr) providers.push('keplr');
    if (window.leap) providers.push('leap');
  }
  return providers;
}

export function getOfflineSigner(chainId: string, provider: WalletProvider = 'keplr'): OfflineSigner {
  const wallet = provider === 'keplr' ? window.keplr : window.leap;
  if (!wallet) throw new Error(`${provider} wallet not available`);
  return wallet.getOfflineSigner(chainId);
}

export async function connectWallet(
  provider: WalletProvider = 'keplr'
): Promise<WalletConnection> {
  const wallet = provider === 'keplr' ? window.keplr : window.leap;
  if (!wallet) {
    throw new Error(`${provider} wallet not found. Install the browser extension.`);
  }

  const config = getChainConfig();
  await wallet.experimentalSuggestChain(buildKeplrChainInfo(config));
  await wallet.enable(config.chainId);
  const key = await wallet.getKey(config.chainId);

  return {
    provider,
    address: key.bech32Address,
    pubKey: key.pubKey,
    name: key.name,
  };
}

export async function signArbitraryMessage(
  chainId: string,
  signerAddress: string,
  message: string,
): Promise<{ pubkey: Uint8Array; signature: Uint8Array }> {
  const wallet = window.keplr || window.leap;
  if (!wallet) {
    throw new Error('No wallet connected');
  }

  const result = await wallet.signArbitrary(chainId, signerAddress, message);
  const pubkeyBytes = fromBase64(result.pub_key.value);
  const signatureBytes = fromBase64(result.signature);
  return { pubkey: pubkeyBytes, signature: signatureBytes };
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
