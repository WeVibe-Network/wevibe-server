// Merkle root construction for chain commitments.
// Byte-for-byte parity with hub Go implementation at
// wevibe-hub/internal/chain/merkle.go (ComputeMerkleRoot).
//
// Algorithm:
//   - If 0 leaves: sha256(empty)
//   - If 1 leaf:   sha256(leaf)
//   - If N leaves:
//       1. Sort RAW leaves by their hex encoding (NOT pre-hashed)
//       2. If odd count, duplicate the last entry
//       3. For each adjacent pair, concatenate and sha256
//       4. Subsequent layers operate on the hash bytes from the previous layer
//       5. Repeat until one root remains; emit as hex.
//
// CO-011a.4 R-MERKLE-PARITY confirmed via fixture tests.

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

function bufToHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const h = await crypto.subtle.digest('SHA-256', toArrayBuffer(data));
  return new Uint8Array(h);
}

export async function computeMerkleRoot(leaves: Uint8Array[]): Promise<string> {
  if (leaves.length === 0) {
    return bufToHex(await sha256(new Uint8Array(0)));
  }

  if (leaves.length === 1) {
    return bufToHex(await sha256(leaves[0]));
  }

  // Sort RAW leaves by their hex encoding (matches Go: hex.EncodeToString of raw bytes).
  let layer: Uint8Array[] = leaves.slice().sort((a, b) => {
    const ha = bufToHex(a);
    const hb = bufToHex(b);
    if (ha < hb) return -1;
    if (ha > hb) return 1;
    return 0;
  });

  while (layer.length > 1) {
    if (layer.length % 2 !== 0) {
      layer.push(layer[layer.length - 1]);
    }
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1];
      const combined = new Uint8Array(left.length + right.length);
      combined.set(left, 0);
      combined.set(right, left.length);
      next.push(await sha256(combined));
    }
    layer = next;
  }

  return bufToHex(layer[0]);
}

export async function hashContribution(content: Uint8Array): Promise<Uint8Array> {
  return sha256(content);
}