const SEED_KEK_INFO = new TextEncoder().encode('wevibe-seed-kek-v1');
const PRF_EVAL_SALT = new TextEncoder().encode('wevibe-prf-eval-v1');

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
  hkdfSaltB64: string;
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
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    },
    timeout: 60000,
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

/** Discovers a resident passkey and returns both credential id and PRF output. */
export async function discoverPasskeyPrf(): Promise<{ credentialId: Uint8Array; prfOutput: Uint8Array }> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: bytesToArrayBuffer(randomBytes(32)),
    allowCredentials: [],
    userVerification: 'required',
    timeout: 60000,
    extensions: {
      prf: {
        eval: {
          first: bytesToArrayBuffer(PRF_EVAL_SALT),
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

  return {
    credentialId: new Uint8Array(credential.rawId),
    prfOutput: new Uint8Array(first.slice(0)),
  };
}

/** Obtains the deterministic PRF output for a credential with fixed evaluation salt. */
async function getPrfOutput(credentialId: Uint8Array): Promise<Uint8Array> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: bytesToArrayBuffer(randomBytes(32)),
    allowCredentials: [
      {
        type: 'public-key',
        id: bytesToArrayBuffer(credentialId),
        transports: ['internal'],
      },
    ],
    userVerification: 'required',
    timeout: 60000,
    extensions: {
      prf: {
        eval: {
          first: bytesToArrayBuffer(PRF_EVAL_SALT),
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

  return new Uint8Array(first.slice(0));
}

/** Derives an AES-256-GCM key-encryption-key from PRF output via HKDF. */
async function deriveSeedKek(prfOutput: Uint8Array, hkdfSalt: Uint8Array): Promise<CryptoKey> {
  const prfKey = await crypto.subtle.importKey(
    'raw',
    bytesToArrayBuffer(prfOutput),
    'HKDF',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: bytesToArrayBuffer(hkdfSalt),
      info: bytesToArrayBuffer(SEED_KEK_INFO),
    },
    prfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypts a 32-byte Ed25519 seed using PRF → HKDF derived KEK and AES-GCM. */
export async function wrapSeed(credentialId: Uint8Array, seed: Uint8Array): Promise<WrappedSeed> {
  const hkdfSalt = randomBytes(32);
  const iv = randomBytes(12);
  const prfOutput = await getPrfOutput(credentialId);

  try {
    const kek = await deriveSeedKek(prfOutput, hkdfSalt);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bytesToArrayBuffer(iv) },
      kek,
      bytesToArrayBuffer(seed),
    );

    return {
      v: 1,
      hkdfSaltB64: bytesToBase64(hkdfSalt),
      ivB64: bytesToBase64(iv),
      ctB64: bytesToBase64(new Uint8Array(ciphertext)),
    };
  } finally {
    prfOutput.fill(0);
  }
}

/** Decrypts a wrapped seed payload from a provided PRF output. */
export async function decryptSeedWithPrf(
  prfOutput: Uint8Array,
  wrapped: WrappedSeed,
): Promise<Uint8Array> {
  try {
    if (wrapped.v !== 1) {
      throw new Error(`Unsupported wrapped seed version: ${wrapped.v}`);
    }

    const hkdfSalt = base64ToBytes(wrapped.hkdfSaltB64);
    const iv = base64ToBytes(wrapped.ivB64);
    const ciphertext = base64ToBytes(wrapped.ctB64);

    const kek = await deriveSeedKek(prfOutput, hkdfSalt);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytesToArrayBuffer(iv) },
      kek,
      bytesToArrayBuffer(ciphertext),
    );

    return new Uint8Array(plaintext);
  } finally {
    prfOutput.fill(0);
  }
}

/** Decrypts a wrapped seed payload using PRF → HKDF derived KEK and AES-GCM. */
export async function unwrapSeed(
  credentialId: Uint8Array,
  wrapped: WrappedSeed,
): Promise<Uint8Array> {
  const prfOutput = await getPrfOutput(credentialId);
  return decryptSeedWithPrf(prfOutput, wrapped);
}
