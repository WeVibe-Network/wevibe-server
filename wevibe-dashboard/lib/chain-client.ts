import { SigningStargateClient } from '@cosmjs/stargate';
import { OfflineSigner } from '@cosmjs/proto-signing';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { MsgGrant, MsgRevoke } from 'cosmjs-types/cosmos/authz/v1beta1/tx';
import { GenericAuthorization } from 'cosmjs-types/cosmos/authz/v1beta1/authz';

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