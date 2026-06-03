/* tslint:disable */
/* eslint-disable */

export function compute_blind_token(keyword: string, search_key: Uint8Array): string;

export function decrypt_symmetric(blob: Uint8Array, key: Uint8Array): Uint8Array;

export function derive_epoch_keys(master_key: Uint8Array, epoch: number): Array<any>;

export function encrypt_symmetric(plaintext: Uint8Array, key: Uint8Array): Uint8Array;

export function generate_dek(): Uint8Array;

export function generate_identity(): Array<any>;

export function master_key_to_mnemonic(master_key: Uint8Array): string;

export function mnemonic_to_master_key(phrase: string): Uint8Array;

export function open_envelope(blob: Uint8Array, privkey: Uint8Array): Uint8Array;

export function reconstructSecret(shares_json: string, threshold: number): Uint8Array;

export function seal_to_pubkey(plaintext: Uint8Array, recipient_pubkey: Uint8Array): Uint8Array;

export function sign(privkey: Uint8Array, data: Uint8Array): Uint8Array;

export function splitSecret(secret: Uint8Array, threshold: number, total_shares: number): any;

export function verify(pubkey: Uint8Array, signature: Uint8Array, data: Uint8Array): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly compute_blind_token: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly decrypt_symmetric: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly derive_epoch_keys: (a: number, b: number, c: number) => [number, number, number];
    readonly encrypt_symmetric: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly generate_identity: () => any;
    readonly master_key_to_mnemonic: (a: number, b: number) => [number, number, number, number];
    readonly mnemonic_to_master_key: (a: number, b: number) => [number, number, number];
    readonly open_envelope: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly reconstructSecret: (a: number, b: number, c: number) => [number, number, number, number];
    readonly seal_to_pubkey: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly sign: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly splitSecret: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly verify: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly generate_dek: () => any;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
