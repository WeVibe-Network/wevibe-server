import { SigningStargateClient, defaultRegistryTypes } from '@cosmjs/stargate';
import { OfflineSigner, Registry, GeneratedType } from '@cosmjs/proto-signing';
import { toBase64 } from '@cosmjs/encoding';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { MsgGrant, MsgRevoke } from 'cosmjs-types/cosmos/authz/v1beta1/tx';
import { GenericAuthorization } from 'cosmjs-types/cosmos/authz/v1beta1/authz';
import { getConfig } from '@/lib/config';

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
  '/wevibe.org.v1.MsgUpdateMemberRole',
  '/wevibe.org.v1.MsgSetServingKey',
  '/wevibe.reputation.v1.MsgIncrementContribution',
  '/wevibe.reputation.v1.MsgIncrementServe',
  '/wevibe.reputation.v1.MsgRecordBan',
  '/wevibe.serve.v1.MsgSubmitDenialBatch',
];

export function getChainRpcEndpoint(): string {
  let rpc = getConfig().chainRpc;
  rpc = rpc.replace(/^tcp:\/\//, 'http://');
  rpc = rpc.replace(/^rpc\./, 'http://rpc.');
  if (!rpc.startsWith('http')) {
    rpc = 'http://' + rpc;
  }
  return rpc;
}

// The wevibe Msg `value` fields are already-encoded protobuf bytes (hand-rolled
// encoders above). This passthrough GeneratedType returns those bytes verbatim so
// CosmJS's Registry can place them into the tx body without re-encoding.
const rawProtoType: GeneratedType = {
  encode: (message: unknown) => {
    const bytes = message instanceof Uint8Array ? message : Uint8Array.from((message as number[]) ?? []);
    return { finish: () => bytes } as unknown as ReturnType<GeneratedType['encode']>;
  },
  decode: (input: unknown) => input,
  fromPartial: (object: unknown) => object,
};

function buildWevibeRegistry(): Registry {
  const registry = new Registry(defaultRegistryTypes);
  for (const typeUrl of WEVIBE_MSG_TYPE_URLS) {
    registry.register(typeUrl, rawProtoType);
  }
  return registry;
}

export async function getSigningClient(signer: OfflineSigner): Promise<SigningStargateClient> {
  const rpc = getChainRpcEndpoint();
  return SigningStargateClient.connectWithSigner(rpc, signer, { registry: buildWevibeRegistry() });
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
  leader: string,
  storageQuota: number,
  retrievalBudget: number,
  domain: string,
  hubServingKey: string,
  leaderWallet: string,
): EncodeObject {
  const fields: number[] = [
    ...encodeStringField(0x0a, signer),
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

export function buildAddMemberMsg(
  signer: string,
  orgId: string,
  pubkey: string,
  role: string,
): EncodeObject {
  const fields: number[] = [
    ...encodeStringField(0x0a, signer),
    ...encodeStringField(0x12, orgId),
    ...encodeStringField(0x1a, pubkey),
    ...encodeStringField(0x22, role),
  ];

  return {
    typeUrl: '/wevibe.org.v1.MsgAddMember',
    value: Uint8Array.from(fields),
  };
}

export function buildRemoveMemberMsg(
  signer: string,
  orgId: string,
  pubkey: string,
): EncodeObject {
  const fields: number[] = [
    ...encodeStringField(0x0a, signer),
    ...encodeStringField(0x12, orgId),
    ...encodeStringField(0x1a, pubkey),
  ];

  return {
    typeUrl: '/wevibe.org.v1.MsgRemoveMember',
    value: Uint8Array.from(fields),
  };
}

export function buildUpdateMemberRoleMsg(
  signer: string,
  orgId: string,
  pubkey: string,
  newRole: string,
): EncodeObject {
  const fields: number[] = [
    ...encodeStringField(0x0a, signer),
    ...encodeStringField(0x12, orgId),
    ...encodeStringField(0x1a, pubkey),
    ...encodeStringField(0x22, newRole),
  ];

  return {
    typeUrl: '/wevibe.org.v1.MsgUpdateMemberRole',
    value: Uint8Array.from(fields),
  };
}

export function buildSetOrgConfigMsg(
  signer: string,
  orgId: string,
  serveAttestationRequired: boolean,
  minContributionsPerEpoch: number,
  contestStakeVibe: number,
): EncodeObject {
  const fields: number[] = [
    ...encodeStringField(0x0a, signer),
    ...encodeStringField(0x12, orgId),
    ...encodeVarint(0x18), ...encodeVarint(serveAttestationRequired ? 1 : 0),
    ...encodeVarint(0x20), ...encodeVarint(minContributionsPerEpoch),
    ...encodeVarint(0x28), ...encodeVarint(contestStakeVibe),
  ];

  return {
    typeUrl: '/wevibe.org.v1.MsgSetOrgConfig',
    value: Uint8Array.from(fields),
  };
}

export function buildSetServingKeyMsg(
  signer: string,
  orgId: string,
  newServingKey: string,
): EncodeObject {
  const fields: number[] = [
    ...encodeStringField(0x0a, signer),
    ...encodeStringField(0x12, orgId),
    ...encodeStringField(0x1a, newServingKey),
  ];

  return {
    typeUrl: '/wevibe.org.v1.MsgSetServingKey',
    value: Uint8Array.from(fields),
  };
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
): Promise<{ txHash: string; code: number; rawLog: string; deliverTxData?: Uint8Array }> {
  const decodeRpcDataField = (data: unknown): Uint8Array | undefined => {
    if (data == null) {
      return undefined;
    }

    if (data instanceof Uint8Array) {
      return data.length > 0 ? data : undefined;
    }

    if (Array.isArray(data)) {
      if (data.length === 0) {
        return undefined;
      }
      return Uint8Array.from(data.map((value) => Number(value) & 0xff));
    }

    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (trimmed === '') {
        return undefined;
      }

      const normalizedHex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
      if (/^[0-9a-fA-F]+$/.test(normalizedHex) && normalizedHex.length % 2 === 0) {
        const hexBytes = Buffer.from(normalizedHex, 'hex');
        return hexBytes.length > 0 ? Uint8Array.from(hexBytes) : undefined;
      }

      const base64Bytes = Buffer.from(trimmed, 'base64');
      return base64Bytes.length > 0 ? Uint8Array.from(base64Bytes) : undefined;
    }

    return undefined;
  };

  const { getOfflineSigner } = await import('./wallet-connect');
  const chainId = getConfig().chainId;
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
  if (account.address !== walletAddress) {
    throw new Error('Signer account mismatch for requested wallet address');
  }

  const txRaw = await client.sign(account.address, msgs, fee, '');
  const txBytes = TxRaw.encode(txRaw).finish();

  const resp = await fetch(`${getChainRpcEndpoint()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'broadcast_tx_commit',
      params: { tx: toBase64(txBytes) },
    }),
  });

  const result = await resp.json();
  if (result?.error) {
    throw new Error(result.error?.data ?? result.error?.message ?? 'RPC error');
  }
  const rpcResult = result?.result ?? {};
  const checkTx = rpcResult.check_tx ?? rpcResult.CheckTx;
  const deliverTx = rpcResult.tx_result ?? rpcResult.deliver_tx ?? rpcResult.DeliverTx;
  const checkCode = Number(checkTx?.code ?? 0);
  if (checkCode !== 0) {
    throw new Error(`CheckTx failed: ${checkTx?.log ?? checkTx?.raw_log ?? ''}`);
  }
  const deliverCode = Number(deliverTx?.code ?? 0);
  if (deliverCode !== 0) {
    throw new Error(`DeliverTx failed: ${deliverTx?.log ?? deliverTx?.raw_log ?? ''}`);
  }

  return {
    txHash: String(rpcResult.hash ?? deliverTx?.hash ?? ''),
    code: Number(deliverTx?.code ?? 0),
    rawLog: String(deliverTx?.log ?? deliverTx?.raw_log ?? ''),
    deliverTxData: decodeRpcDataField(deliverTx?.data),
  };
}
