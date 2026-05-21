import { OfflineSigner } from '@cosmjs/proto-signing';
import {
  generateDelegateKey,
  storeDelegateKey,
  getDelegateWallet,
  clearDelegateKey,
} from './delegate-key';
import {
  getSigningClient,
  buildMsgGrant,
  buildMsgRevoke,
  WEVIBE_MSG_TYPE_URLS,
  EncodeObject,
} from './chain-client';

export interface DelegationResult {
  delegateAddress: string;
  txHash: string;
  grantCount: number;
}

interface SignAndBroadcastResult {
  transactionHash: string;
  gasUsed: bigint;
  gasWanted: bigint;
}

export function getOfflineSigner(chainId: string, provider: 'keplr' | 'leap' = 'keplr'): OfflineSigner {
  const wallet = provider === 'keplr' ? window.keplr : window.leap;
  if (!wallet) {
    throw new Error(`${provider} wallet not available`);
  }
  return wallet.getOfflineSigner(chainId);
}

function getChainId(): string {
  return process.env.NEXT_PUBLIC_WEVIBE_CHAIN_ID || 'wevibe-local-1';
}

export async function setupDelegation(walletAddress: string): Promise<DelegationResult> {
  const chainId = getChainId();
  const delegateInfo = await generateDelegateKey(walletAddress);

  const signer = getOfflineSigner(chainId);
  const client = await getSigningClient(signer);

  const grantMessages: EncodeObject[] = WEVIBE_MSG_TYPE_URLS.map((typeUrl) =>
    buildMsgGrant(walletAddress, delegateInfo.address, typeUrl, 90),
  );

  const fee = {
    amount: [{ denom: 'uvibe', amount: '5000' }],
    gas: '400000',
  };

  const result = await client.signAndBroadcast(
    walletAddress,
    grantMessages,
    fee,
  ) as SignAndBroadcastResult;

  await storeDelegateKey(walletAddress, delegateInfo.address, delegateInfo.mnemonic);

  return {
    delegateAddress: delegateInfo.address,
    txHash: result.transactionHash,
    grantCount: WEVIBE_MSG_TYPE_URLS.length,
  };
}

export async function revokeDelegation(walletAddress: string): Promise<void> {
  const chainId = getChainId();

  const delegateWallet = await getDelegateWallet(walletAddress);
  if (!delegateWallet) {
    throw new Error('No delegate key found');
  }

  const [delegateAccount] = await delegateWallet.getAccounts();
  const signer = getOfflineSigner(chainId);
  const client = await getSigningClient(signer);

  const revokeMessages: EncodeObject[] = WEVIBE_MSG_TYPE_URLS.map((typeUrl) =>
    buildMsgRevoke(walletAddress, delegateAccount.address, typeUrl),
  );

  const fee = {
    amount: [{ denom: 'uvibe', amount: '5000' }],
    gas: '400000',
  };

  await client.signAndBroadcast(walletAddress, revokeMessages, fee);
  await clearDelegateKey(walletAddress);
}

export async function isDelegationActive(walletAddress: string): Promise<boolean> {
  const delegateWallet = await getDelegateWallet(walletAddress);
  return delegateWallet !== null;
}

export async function renewDelegation(walletAddress: string): Promise<DelegationResult> {
  const chainId = getChainId();
  const delegateWallet = await getDelegateWallet(walletAddress);

  if (delegateWallet) {
    await revokeDelegation(walletAddress);
  }

  const delegateInfo = await generateDelegateKey(walletAddress);

  const signer = getOfflineSigner(chainId);
  const client = await getSigningClient(signer);

  const grantMessages: EncodeObject[] = WEVIBE_MSG_TYPE_URLS.map((typeUrl) =>
    buildMsgGrant(walletAddress, delegateInfo.address, typeUrl, 90),
  );

  const fee = {
    amount: [{ denom: 'uvibe', amount: '5000' }],
    gas: '400000',
  };

  const result = await client.signAndBroadcast(walletAddress, grantMessages, fee) as SignAndBroadcastResult;

  await storeDelegateKey(walletAddress, delegateInfo.address, delegateInfo.mnemonic);

  return {
    delegateAddress: delegateInfo.address,
    txHash: result.transactionHash,
    grantCount: WEVIBE_MSG_TYPE_URLS.length,
  };
}