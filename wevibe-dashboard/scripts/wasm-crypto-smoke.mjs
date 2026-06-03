import assert from 'node:assert/strict';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

const FIXED_SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const HKDF_INFO = new TextEncoder().encode('wevibe-x25519-v1');

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error('Invalid hex value');
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

async function main() {
  const sdkModule = await import('/Users/jerrysmith/Desktop/wevibe-workspace/wevibe-sdk/pkg-nodejs/wevibe_sdk_wasm.js');
  const sdk = sdkModule.default ?? sdkModule;

  let hasFailure = false;

  const state = {
    dek: null,
    encKey: null,
    searchKey: null,
    auditKey: null,
    xPriv: null,
    xPub: null,
  };

  const runCheck = (name, fn) => {
    try {
      fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      hasFailure = true;
      console.error(`FAIL ${name}`);
      if (error instanceof Error) {
        console.error(error.stack ?? error.message);
      } else {
        console.error(String(error));
      }
    }
  };

  runCheck('generate_dek returns 32 bytes', () => {
    const dek = sdk.generate_dek();
    assert.ok(dek instanceof Uint8Array, 'DEK must be Uint8Array');
    assert.equal(dek.length, 32, 'DEK must be 32 bytes');
    state.dek = dek;
  });

  runCheck('derive_epoch_keys returns enc/search/audit keys', () => {
    assert.ok(state.dek, 'DEK not initialized');

    const epoch0 = sdk.derive_epoch_keys(state.dek, 0);
    assert.ok(Array.isArray(epoch0), 'derive_epoch_keys must return an array');
    assert.equal(epoch0.length, 3, 'derive_epoch_keys must return [enc, search, audit]');

    const [encKey, searchKey, auditKey] = epoch0;
    assert.ok(encKey instanceof Uint8Array, 'encKey must be Uint8Array');
    assert.ok(searchKey instanceof Uint8Array, 'searchKey must be Uint8Array');
    assert.ok(auditKey instanceof Uint8Array, 'auditKey must be Uint8Array');
    assert.ok(encKey.length > 0, 'encKey must not be empty');
    assert.ok(searchKey.length > 0, 'searchKey must not be empty');
    assert.ok(auditKey.length > 0, 'auditKey must not be empty');

    state.encKey = encKey;
    state.searchKey = searchKey;
    state.auditKey = auditKey;
  });

  runCheck('deriveX25519FromSeed algorithm is deterministic', () => {
    const seed = hexToBytes(FIXED_SEED_HEX);
    const xPriv1 = hkdf(sha256, seed, new Uint8Array(0), HKDF_INFO, 32);
    const xPub1 = x25519.getPublicKey(xPriv1);

    const xPriv2 = hkdf(sha256, seed, new Uint8Array(0), HKDF_INFO, 32);
    const xPub2 = x25519.getPublicKey(xPriv2);

    assert.equal(xPriv1.length, 32, 'x25519 private key must be 32 bytes');
    assert.equal(xPub1.length, 32, 'x25519 public key must be 32 bytes');
    assert.ok(bytesEqual(xPriv1, xPriv2), 'x25519 private keys differ for same seed');
    assert.ok(bytesEqual(xPub1, xPub2), 'x25519 public keys differ for same seed');

    state.xPriv = xPriv1;
    state.xPub = xPub1;
  });

  runCheck('seal_to_pubkey/open_envelope roundtrip succeeds', () => {
    assert.ok(state.encKey, 'encKey not initialized');
    assert.ok(state.xPub, 'x25519 public key not initialized');
    assert.ok(state.xPriv, 'x25519 private key not initialized');

    const blob = sdk.seal_to_pubkey(state.encKey, state.xPub);
    assert.ok(blob instanceof Uint8Array, 'sealed blob must be Uint8Array');
    assert.ok(blob.length > 0, 'sealed blob must not be empty');

    const opened = sdk.open_envelope(blob, state.xPriv);
    assert.ok(opened instanceof Uint8Array, 'opened envelope must be Uint8Array');
    assert.ok(bytesEqual(opened, state.encKey), 'opened bytes do not match original encKey');
  });

  runCheck('master_key_to_mnemonic roundtrip succeeds', () => {
    assert.ok(state.dek, 'DEK not initialized');

    const mnemonic = sdk.master_key_to_mnemonic(state.dek);
    const words = mnemonic.trim().split(/\s+/);
    assert.equal(words.length, 24, 'mnemonic must be 24 words');

    const back = sdk.mnemonic_to_master_key(mnemonic);
    assert.ok(back instanceof Uint8Array, 'mnemonic_to_master_key must return Uint8Array');
    assert.ok(bytesEqual(back, state.dek), 'mnemonic roundtrip did not recover original DEK');
  });

  if (hasFailure) {
    process.exit(1);
  }

  console.log('ALL CHECKS PASS');
}

main().catch((error) => {
  console.error('FAIL smoke script execution');
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
