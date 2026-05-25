import { SigningStargateClient } from '@cosmjs/stargate';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { getDelegateWallet } from './delegate-key';
import { getChainRpcEndpoint, getSigningClient } from './chain-client';
import { buildRelayCanonicalBody } from './canonical-body';

function getHubUrl(): string {
  if (typeof window === 'undefined') {
    return process.env.WEVIBE_HUB_URL ?? 'http://localhost:4440';
  }
  return `${window.location.protocol}//${window.location.hostname}:4440`;
}

async function getAccountNumberAndSequence(
  client: SigningStargateClient,
  address: string
): Promise<{ accountNumber: bigint; sequence: number }> {
  const account = await client.getAccount(address);
  if (!account) {
    throw new Error('Account not found');
  }
  return {
    accountNumber: BigInt(account.accountNumber),
    sequence: account.sequence,
  };
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

interface RelayBroadcastResponse {
  tx_hash: string;
  code: number;
  raw_log: string;
  height: number;
}

export async function relayBroadcast(
  orgId: string,
  walletAddress: string,
  msgs: Array<{ typeUrl: string; value: Uint8Array }>
): Promise<string> {
  const delegateWallet = await getDelegateWallet(walletAddress);
  if (!delegateWallet) {
    throw new Error('Delegate wallet not found for address: ' + walletAddress);
  }

  const rpc = getChainRpcEndpoint();
  const client = await SigningStargateClient.offline(delegateWallet);

  const chainId = process.env.NEXT_PUBLIC_WEVIBE_CHAIN_ID || 'wevibe-local-1';
  const [account] = await delegateWallet.getAccounts();
  const address = account.address;

  const { accountNumber, sequence } = await getAccountNumberAndSequence(client, address);

  const fee = {
    amount: [{ denom: 'uvibe', amount: '5000' }],
    gas: '200000',
  };

  const txRaw = await client.sign(address, msgs, fee, '', {
    accountNumber: accountNumber,
    sequence: sequence,
    chainId,
  });

  const txBytes = TxRaw.encode(txRaw).finish();
  const txBytesBase64 = base64Encode(txBytes);

  const canonicalBody = buildRelayCanonicalBody(orgId, address, txBytesBase64);

  const keplr = window.keplr || window.leap;
  if (!keplr) {
    throw new Error('No wallet available for signing');
  }
  await keplr.enable(chainId);
  const signature = await secp256k1Sign(keplr, chainId, address, canonicalBody);
  const signatureBase64 = base64Encode(signature);

  const resp = await fetch(`${getHubUrl()}/v1/relay/broadcast`, {
    method: 'POST',
    headers: {
      'Authorization': `Delegate ${signatureBase64}`,
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

  return result.tx_hash;
}