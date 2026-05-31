import { SigningStargateClient } from '@cosmjs/stargate';
import { OfflineSigner } from '@cosmjs/proto-signing';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { MsgGrant, MsgRevoke } from 'cosmjs-types/cosmos/authz/v1beta1/tx';
import { GenericAuthorization } from 'cosmjs-types/cosmos/authz/v1beta1/authz';
import { buildRelayCanonicalBody } from './canonical-body';
import { connectWallet, getOfflineSigner, type WalletProvider } from './wallet-connect';
import { postRelayCanonicalBody } from './relay-client';

export interface EncodeObject {
  typeUrl: string;
  value: Uint8Array;
}

export const WEVIBE_MSG_TYPE_URLS: string[] = [
  '/wevibe.memory.v1.MsgSubmitCommitment',
  '/wevibe.memory.v1.MsgApproveMemory',
  '/wevibe.memory.v1.MsgReportMemory',
  '/wevibe.serve.v1.MsgSubmitServeBatch',
  '/wevibe.org.v1.MsgRegisterOrg',
  '/wevibe.org.v1.MsgAddMember',
  '/wevibe.org.v1.MsgRemoveMember',
  '/wevibe.org.v1.MsgSetOrgConfig',
  '/wevibe.org.v1.MsgSetRepTiers',
  '/wevibe.org.v1.MsgFundTreasury',
  '/wevibe.org.v1.MsgWithdrawTreasury',
  '/wevibe.reputation.v1.MsgIncrementContribution',
  '/wevibe.reputation.v1.MsgIncrementServe',
  '/wevibe.reputation.v1.MsgRecordBan',
  '/wevibe.serve.v1.MsgSubmitDenialBatch',
];

export function getChainRpcEndpoint(): string {
  let rpc = process.env.NEXT_PUBLIC_WEVIBE_CHAIN_RPC || 'tcp://localhost:26657';
  rpc = rpc.replace(/^tcp:\/\//, 'http://');
  rpc = rpc.replace(/^rpc\./, 'http://rpc.');
  if (!rpc.startsWith('http')) {
    rpc = 'http://' + rpc;
  }
  return rpc;
}

export async function getSigningClient(signer: OfflineSigner): Promise<SigningStargateClient> {
  const rpc = getChainRpcEndpoint();
  return SigningStargateClient.connectWithSigner(rpc, signer);
}

export function buildMsgGrant(
  granterAddress: string,
  granteeAddress: string,
  msgTypeUrl: string,
  expirationDays: number,
): EncodeObject {
  const expiration = new Date();
  expiration.setDate(expiration.getDate() + expirationDays);

  const genericAuth = GenericAuthorization.fromPartial({
    msg: msgTypeUrl,
  });

  const msgGrant = MsgGrant.fromPartial({
    granter: granterAddress,
    grantee: granteeAddress,
    grant: {
      authorization: {
        typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
        value: Buffer.from(GenericAuthorization.encode(genericAuth).finish()),
      },
      expiration: {
        seconds: BigInt(Math.floor(expiration.getTime() / 1000)),
        nanos: 0,
      },
    },
  });

  return {
    typeUrl: '/cosmos.authz.v1beta1.MsgGrant',
    value: Buffer.from(MsgGrant.encode(msgGrant).finish()),
  };
}

export function buildMsgRevoke(
  granterAddress: string,
  granteeAddress: string,
  msgTypeUrl: string,
): EncodeObject {
  const msgRevoke = MsgRevoke.fromPartial({
    granter: granterAddress,
    grantee: granteeAddress,
    msgTypeUrl,
  });

  return {
    typeUrl: '/cosmos.authz.v1beta1.MsgRevoke',
    value: Buffer.from(MsgRevoke.encode(msgRevoke).finish()),
  };
}

export interface DenialEntry {
  memory_hash: string;
  nullifier: string;
  deny_key: string;
  reason: string;
}

export interface ServeEntryInput {
  memory_content_hash: Uint8Array;
  serve_key: string;
  contributor_id: string;
  nullifier: Uint8Array;
  model_id: string;
  turn_count: number;
  contributor_wallet: string;
  matched_keywords: string[];
}

interface KeywordWeightInput {
  keyword: string;
  weight?: string;
}

interface RelayBroadcastResponse {
  tx_hash: string;
  code: number;
  raw_log: string;
  height: number;
}

function encodeRepeatedStringField(tag: number, values: string[]): number[] {
  const fields: number[] = [];
  for (const value of values) {
    fields.push(...encodeStringField(tag, value));
  }
  return fields;
}

function encodeVarint(value: number): number[] {
  const result: number[] = [];
  let v = value;
  while (v > 0x7f) {
    result.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  result.push(v & 0x7f);
  return result;
}

function encodeStringField(tag: number, value: string): number[] {
  const bytes = [...Buffer.from(value)];
  return [tag, ...encodeVarint(bytes.length), ...bytes];
}

function encodeBytesField(tag: number, value: string): number[] {
  const bytes = [...Buffer.from(value, 'hex')];
  return [tag, ...encodeVarint(bytes.length), ...bytes];
}

function encodeBytesFieldFromBytes(tag: number, value: Uint8Array): number[] {
  const bytes = [...value];
  return [tag, ...encodeVarint(bytes.length), ...bytes];
}

function encodeNestedField(tag: number, fields: number[]): number[] {
  return [tag, ...encodeVarint(fields.length), ...fields];
}

function mapMemoryType(memoryType: string): number {
  if (memoryType !== 'memory') {
    throw new Error(`unsupported memory_type: ${memoryType}`);
  }
  return 1;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function connectSupportedWallet(): Promise<{ provider: WalletProvider }> {
  const providers: WalletProvider[] = ['keplr', 'leap'];
  let lastError: Error | null = null;

  for (const provider of providers) {
    try {
      const walletConnection = await connectWallet(provider);
      return { provider: walletConnection.provider };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error('No supported wallet available (Keplr or Leap)');
}

export function buildSubmitCommitmentMsg(
  signer: string,
  orgId: string,
  contentHash: Uint8Array,
  keywords: KeywordWeightInput[],
  contributorId: string,
  contributorWallet: string,
  memoryType: string,
): EncodeObject {
  const fields: number[] = [
    ...encodeStringField(0x0a, signer),
    ...encodeStringField(0x12, orgId),
    ...encodeBytesFieldFromBytes(0x1a, contentHash),
  ];

  for (const keyword of keywords) {
    const nested: number[] = [
      ...encodeStringField(0x0a, keyword.keyword),
      ...encodeStringField(0x12, keyword.weight ?? '1.0'),
    ];
    fields.push(...encodeNestedField(0x22, nested));
  }

  fields.push(
    ...encodeStringField(0x2a, contributorId),
    ...encodeStringField(0x32, contributorWallet),
    ...encodeVarint(0x38),
    ...encodeVarint(mapMemoryType(memoryType)),
  );

  return {
    typeUrl: '/wevibe.memory.v1.MsgSubmitCommitment',
    value: Uint8Array.from(fields),
  };
}

export function buildApproveMemoryMsg(
  signer: string,
  orgId: string,
  contentHash: Uint8Array,
  encryptedBlob: Uint8Array,
  committingLeader: string,
  wrappedDekEnc: Uint8Array,
  plaintextHash: Uint8Array,
  salt: Uint8Array,
  ciphertextHash: Uint8Array,
  contributorSig: Uint8Array,
  memoryType: string,
): EncodeObject {
  const fields: number[] = [
    ...encodeStringField(0x0a, signer),
    ...encodeStringField(0x12, orgId),
    ...encodeBytesFieldFromBytes(0x1a, contentHash),
    ...encodeBytesFieldFromBytes(0x22, encryptedBlob),
    ...encodeStringField(0x32, committingLeader),
    ...encodeBytesFieldFromBytes(0x3a, wrappedDekEnc),
    ...encodeVarint(0x40),
    ...encodeVarint(mapMemoryType(memoryType)),
    ...encodeBytesFieldFromBytes(0x4a, plaintextHash),
    ...encodeBytesFieldFromBytes(0x52, salt),
    ...encodeBytesFieldFromBytes(0x5a, ciphertextHash),
    ...encodeBytesFieldFromBytes(0x62, contributorSig),
  ];

  return {
    typeUrl: '/wevibe.memory.v1.MsgApproveMemory',
    value: Uint8Array.from(fields),
  };
}

export function buildReportMemoryMsg(args: {
  signer: string;
  orgId: string;
  contentHash: Uint8Array;
  contributorPubkey: string;
  approvingModerators: string[];
  upholdingModerators: string[];
  reporterPubkey: string;
  reason: string;
  plaintext?: Uint8Array;
  ciphertext?: Uint8Array;
  capsule?: Uint8Array;
  plaintextHash?: Uint8Array;
  plaintextOversized?: boolean;
}): EncodeObject {
  const fields: number[] = [
    ...encodeStringField(0x0a, args.signer),
    ...encodeStringField(0x12, args.orgId),
    ...encodeBytesFieldFromBytes(0x1a, args.contentHash),
    ...encodeStringField(0x22, args.contributorPubkey),
  ];

  for (const mod of args.approvingModerators) {
    fields.push(...encodeStringField(0x2a, mod));
  }
  for (const mod of args.upholdingModerators) {
    fields.push(...encodeStringField(0x32, mod));
  }

  fields.push(
    ...encodeStringField(0x3a, args.reporterPubkey),
    ...encodeStringField(0x42, args.reason),
  );

  if (args.plaintext && args.plaintext.length > 0) {
    fields.push(...encodeBytesFieldFromBytes(0x4a, args.plaintext));
  }
  if (args.ciphertext && args.ciphertext.length > 0) {
    fields.push(...encodeBytesFieldFromBytes(0x52, args.ciphertext));
  }
  if (args.capsule && args.capsule.length > 0) {
    fields.push(...encodeBytesFieldFromBytes(0x5a, args.capsule));
  }
  if (args.plaintextHash && args.plaintextHash.length > 0) {
    fields.push(...encodeBytesFieldFromBytes(0x62, args.plaintextHash));
  }
  if (args.plaintextOversized) {
    fields.push(...encodeVarint(0x68), ...encodeVarint(1));
  }

  return {
    typeUrl: '/wevibe.memory.v1.MsgReportMemory',
    value: Uint8Array.from(fields),
  };
}

export function buildRegisterOrgMsg(
  signer: string,
  orgId: string,
  leader: string,
  storageQuota: number,
  retrievalBudget: number,
  domain: string,
  hubServingKey: string,
  leaderWallet: string,
): EncodeObject {
  const fields: number[] = [
    ...encodeStringField(0x0a, signer),
    ...encodeStringField(0x12, orgId),
    ...encodeStringField(0x1a, leader),
    ...encodeVarint(0x20), ...encodeVarint(storageQuota),
    ...encodeVarint(0x28), ...encodeVarint(retrievalBudget),
    ...encodeStringField(0x32, domain),
    ...encodeStringField(0x3a, hubServingKey),
    ...encodeStringField(0x42, leaderWallet),
  ];

  return {
    typeUrl: '/wevibe.org.v1.MsgRegisterOrg',
    value: Uint8Array.from(fields),
  };
}

export async function relayOrgDecision(
  orgID: string,
  msgs: EncodeObject[],
  memo = '',
): Promise<string> {
  const chainId = process.env.NEXT_PUBLIC_WEVIBE_CHAIN_ID || 'wevibe-local-1';
  const wallet = await connectSupportedWallet();
  const signer = getOfflineSigner(chainId, wallet.provider);
  const client = await getSigningClient(signer);

  const [account] = await signer.getAccounts();
  if (!account) {
    throw new Error('No account found from connected wallet');
  }

  const fee = {
    amount: [{ denom: 'uvibe', amount: '5000' }],
    gas: '200000',
  };

  const txRaw = await client.sign(account.address, msgs, fee, memo);
  const txBytes = TxRaw.encode(txRaw).finish();
  const txBytesBase64 = base64Encode(txBytes);
  const canonicalBody = buildRelayCanonicalBody(orgID, account.address, txBytesBase64);

  const walletApi = wallet.provider === 'keplr' ? window.keplr : window.leap;
  if (!walletApi) {
    throw new Error('Connected wallet provider not available');
  }
  await walletApi.enable(chainId);
  const signed = await walletApi.signArbitrary(chainId, account.address, canonicalBody);

  const result = await postRelayCanonicalBody(
    orgID,
    `Wallet ${signed.signature}`,
    canonicalBody,
  ) as RelayBroadcastResponse;

  if (!result.tx_hash) {
    throw new Error('Relay broadcast missing tx_hash');
  }

  return result.tx_hash;
}

export function buildDenialBatchMsg(
  signer: string,
  orgId: string,
  epoch: number,
  entries: DenialEntry[]
): EncodeObject {
  const fields: number[] = [
    ...encodeStringField(0x0a, signer),
    ...encodeStringField(0x12, orgId),
    ...encodeVarint(0x18), ...encodeVarint(epoch),
  ];

  for (const entry of entries) {
    fields.push(0x22);
    const entryFields: number[] = [
      ...encodeBytesField(0x0a, entry.memory_hash),
      ...encodeBytesField(0x12, entry.nullifier),
      ...encodeStringField(0x1a, entry.deny_key),
      ...encodeStringField(0x22, entry.reason),
    ];
    fields.push(...encodeVarint(entryFields.length), ...entryFields);
  }

  return {
    typeUrl: '/wevibe.serve.v1.MsgSubmitDenialBatch',
    value: Uint8Array.from(fields),
  };
}

export function buildServeBatchMsg(
  signer: string,
  orgId: string,
  epoch: number,
  entries: ServeEntryInput[],
): EncodeObject {
  for (const entry of entries) {
    if (!entry.matched_keywords || entry.matched_keywords.length === 0) {
      throw new Error('matched_keywords must be non-empty per D-4.2');
    }
    for (const kw of entry.matched_keywords) {
      if (!kw || kw.trim() === '') {
        throw new Error('matched_keywords entries must be non-empty strings');
      }
    }
  }

  const fields: number[] = [
    ...encodeStringField(0x0a, signer),
    ...encodeStringField(0x12, orgId),
    ...encodeVarint(0x18), ...encodeVarint(epoch),
  ];

  for (const entry of entries) {
    fields.push(0x22);
    const entryFields: number[] = [
      ...encodeBytesField(0x0a, Buffer.from(entry.memory_content_hash).toString('hex')),
      ...encodeStringField(0x12, entry.serve_key),
      ...encodeStringField(0x1a, entry.contributor_id),
      ...encodeBytesField(0x22, Buffer.from(entry.nullifier).toString('hex')),
      ...encodeStringField(0x2a, entry.model_id),
      ...encodeVarint(0x30), ...encodeVarint(entry.turn_count),
      ...encodeStringField(0x3a, entry.contributor_wallet),
      ...encodeRepeatedStringField(0x42, entry.matched_keywords),
    ];
    fields.push(...encodeVarint(entryFields.length), ...entryFields);
  }

  return {
    typeUrl: '/wevibe.serve.v1.MsgSubmitServeBatch',
    value: Uint8Array.from(fields),
  };
}

export async function directBroadcast(
  walletAddress: string,
  msgs: EncodeObject[]
): Promise<{ txHash: string; code: number; rawLog: string }> {
  const { getOfflineSigner } = await import('./wallet-connect');
  const chainId = process.env.NEXT_PUBLIC_WEVIBE_CHAIN_ID || 'wevibe-local-1';
  const signer = getOfflineSigner(chainId);
  const client = await getSigningClient(signer);

  const fee = {
    amount: [{ denom: 'uvibe', amount: '5000' }],
    gas: '200000',
  };

  const [account] = await signer.getAccounts();
  if (!account) {
    throw new Error('No account found');
  }

  const txRaw = await client.sign(account.address, msgs, fee, '');
  const txBytes = TxRaw.encode(txRaw).finish();

  const resp = await fetch(`${getChainRpcEndpoint()}/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'broadcast_tx_commit',
      params: [txBytes],
    }),
  });

  const result = await resp.json();
  if (result.result?.CheckTx?.code !== 0) {
    throw new Error(`CheckTx failed: ${result.result?.CheckTx?.log}`);
  }
  if (result.result?.DeliverTx?.code !== 0) {
    throw new Error(`DeliverTx failed: ${result.result?.DeliverTx?.log}`);
  }

  return {
    txHash: result.result?.DeliverTx?.hash || '',
    code: result.result?.DeliverTx?.code || 0,
    rawLog: result.result?.DeliverTx?.log || '',
  };
}
