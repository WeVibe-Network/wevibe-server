import { SigningStargateClient } from '@cosmjs/stargate';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { buildRelayCanonicalBody } from './canonical-body';
import { connectWallet, getOfflineSigner, type WalletProvider } from './wallet-connect';

function getHubUrl(): string {
  if (typeof window === 'undefined') {
    return process.env.WEVIBE_HUB_URL ?? 'http://localhost:4440';
  }
  return `${window.location.protocol}//${window.location.hostname}:4440`;
}

function getChainRpcEndpoint(): string {
  let rpc = process.env.NEXT_PUBLIC_WEVIBE_CHAIN_RPC || 'tcp://localhost:26657';
  rpc = rpc.replace(/^tcp:\/\//, 'http://');
  if (!rpc.startsWith('http')) {
    rpc = 'http://' + rpc;
  }
  return rpc;
}

function base64Encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function secp256k1Sign(
  wallet: { signArbitrary: (chainId: string, address: string, message: string) => Promise<{ pub_key: { value: string }; signature: string }> },
  chainId: string,
  address: string,
  message: string
): Promise<Uint8Array> {
  const result = await wallet.signArbitrary(chainId, address, message);
  return Uint8Array.from(atob(result.signature), c => c.charCodeAt(0));
}

export interface RelayBroadcastResponse {
  tx_hash: string;
  code: number;
  raw_log: string;
  height: number;
}

export async function postRelayCanonicalBody(
  orgId: string,
  authorizationHeader: string,
  canonicalBody: string,
): Promise<RelayBroadcastResponse> {
  const resp = await fetch(`${getHubUrl()}/v1/relay/broadcast`, {
    method: 'POST',
    headers: {
      Authorization: authorizationHeader,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: canonicalBody,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error ?? `Relay error ${resp.status}`);
  }

  const result = await resp.json() as RelayBroadcastResponse;
  if (result.code !== 0) {
    throw new Error(`Chain error: ${result.code} - ${result.raw_log}`);
  }

  return result;
}

export async function relayBroadcast(
  orgId: string,
  walletAddress: string,
  msgs: Array<{ typeUrl: string; value: Uint8Array }>
): Promise<string> {
  const providers: WalletProvider[] = ['keplr', 'leap'];
  let provider: WalletProvider | null = null;
  for (const candidate of providers) {
    try {
      const connection = await connectWallet(candidate);
      if (connection.address === walletAddress) {
        provider = candidate;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!provider) {
    throw new Error('Connected wallet does not match requested wallet address');
  }

  const chainId = process.env.NEXT_PUBLIC_WEVIBE_CHAIN_ID || 'wevibe-local-1';
  const signer = getOfflineSigner(chainId, provider);
  const client = await SigningStargateClient.connectWithSigner(getChainRpcEndpoint(), signer);

  const [account] = await signer.getAccounts();
  const address = account?.address;
  if (!address || address !== walletAddress) {
    throw new Error('Signer account mismatch for requested wallet address');
  }

  const fee = {
    amount: [{ denom: 'uvibe', amount: '5000' }],
    gas: '200000',
  };

  const txRaw = await client.sign(address, msgs, fee, '');

  const txBytes = TxRaw.encode(txRaw).finish();
  const txBytesBase64 = base64Encode(txBytes);

  const canonicalBody = buildRelayCanonicalBody(orgId, address, txBytesBase64);

  const walletApi = provider === 'keplr' ? window.keplr : window.leap;
  if (!walletApi) {
    throw new Error('No wallet available for signing');
  }
  await walletApi.enable(chainId);
  const signature = await secp256k1Sign(walletApi, chainId, address, canonicalBody);
  const signatureBase64 = base64Encode(signature);

  const result = await postRelayCanonicalBody(orgId, `Wallet ${signatureBase64}`, canonicalBody);

  return result.tx_hash;
}
