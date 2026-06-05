const PRF_SALT = new TextEncoder().encode('wevibe-identity-wrap-v1');

type PrfCreateExtensionResults = AuthenticationExtensionsClientOutputs & {
  prf?: {
    enabled?: boolean;
  };
};

type PrfGetExtensionResults = AuthenticationExtensionsClientOutputs & {
  prf?: {
    results?: {
      first?: ArrayBuffer;
    };
  };
};

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function requirePublicKeyCredential(
  credential: Credential | null,
  operation: 'create' | 'get',
): PublicKeyCredential {
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error(`Passkey ${operation} did not return a PublicKeyCredential`);
  }
  return credential;
}

/** Wrapped seed payload persisted after AES-GCM encryption. */
export type WrappedSeed = {
  v: 1;
  ivB64: string;
  ctB64: string;
};

/** Returns true when the browser exposes the WebAuthn passkey API. */
export function isPasskeySupported(): boolean {
  return typeof window.PublicKeyCredential !== 'undefined';
}

/** Creates a resident, UV-required passkey and reports PRF extension availability. */
export async function createIdentityPasskey(opts: {
  userId: Uint8Array;
  userName: string;
  displayName: string;
  rpName?: string;
}): Promise<{ credentialId: Uint8Array; prfSupported: boolean }> {
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: bytesToArrayBuffer(randomBytes(32)),
    rp: {
      id: window.location.hostname,
      name: opts.rpName ?? 'WeVibe',
    },
    user: {
      id: bytesToArrayBuffer(opts.userId),
      name: opts.userName,
      displayName: opts.displayName,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    extensions: {
      prf: {},
    } as AuthenticationExtensionsClientInputs,
  };

  const created = await navigator.credentials.create({ publicKey });
  const credential = requirePublicKeyCredential(created, 'create');
  const ext = credential.getClientExtensionResults() as PrfCreateExtensionResults;

  return {
    credentialId: new Uint8Array(credential.rawId),
    prfSupported: ext.prf?.enabled === true,
  };
}

/** Derives the deterministic PRF secret from a passkey credential and imports it as AES-GCM key material. */
export async function derivePrfKey(credentialId: Uint8Array): Promise<CryptoKey> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: bytesToArrayBuffer(randomBytes(32)),
    allowCredentials: [
      {
        type: 'public-key',
        id: bytesToArrayBuffer(credentialId),
      },
    ],
    userVerification: 'required',
    extensions: {
      prf: {
        eval: {
          first: bytesToArrayBuffer(PRF_SALT),
        },
      },
    } as AuthenticationExtensionsClientInputs,
  };

  const asserted = await navigator.credentials.get({ publicKey });
  const credential = requirePublicKeyCredential(asserted, 'get');
  const ext = credential.getClientExtensionResults() as PrfGetExtensionResults;
  const first = ext.prf?.results?.first;

  if (!(first instanceof ArrayBuffer)) {
    throw new Error('Passkey PRF result missing: expected prf.results.first ArrayBuffer');
  }

  return crypto.subtle.importKey('raw', first, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypts a 32-byte Ed25519 seed with AES-GCM using a fresh random IV. */
export async function wrapSeed(key: CryptoKey, seed: Uint8Array): Promise<WrappedSeed> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bytesToArrayBuffer(iv) },
    key,
    bytesToArrayBuffer(seed),
  );

  return {
    v: 1,
    ivB64: bytesToBase64(iv),
    ctB64: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

/** Decrypts a wrapped seed payload with the passkey-derived AES-GCM key. */
export async function unwrapSeed(key: CryptoKey, wrapped: WrappedSeed): Promise<Uint8Array> {
  if (wrapped.v !== 1) {
    throw new Error(`Unsupported wrapped seed version: ${wrapped.v}`);
  }

  const iv = base64ToBytes(wrapped.ivB64);
  const ciphertext = base64ToBytes(wrapped.ctB64);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytesToArrayBuffer(iv) },
    key,
    bytesToArrayBuffer(ciphertext),
  );

  return new Uint8Array(plaintext);
}
