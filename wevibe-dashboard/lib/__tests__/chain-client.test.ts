import { buildServeBatchMsg, buildDenialBatchMsg } from '../chain-client';

function toHex(arr: number[]): string {
  return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}

function findAll(hex: string, byte: number): number[] {
  const results: number[] = [];
  const hexByte = byte.toString(16).padStart(2, '0');
  let idx = 0;
  while (true) {
    const found = hex.indexOf(hexByte, idx);
    if (found === -1) break;
    if (found % 2 === 0) {
      results.push(found / 2);
    }
    idx = found + 1;
  }
  return results;
}

const vectors = [
  {
    name: 'single entry with one keyword',
    entry: {
      memory_content_hash: new Uint8Array([0x01, 0x02, 0x03]),
      serve_key: 'serve_key_1',
      contributor_id: 'contrib_1',
      nullifier: new Uint8Array([0x04, 0x05, 0x06]),
      model_id: 'gpt-4',
      turn_count: 10,
      contributor_wallet: 'wevibe1xxx',
      matched_keywords: ['keyword1'],
    },
  },
  {
    name: 'single entry with three keywords',
    entry: {
      memory_content_hash: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      serve_key: 'my_serve_key',
      contributor_id: 'alice',
      nullifier: new Uint8Array([0xc0, 0xde]),
      model_id: 'claude-3',
      turn_count: 42,
      contributor_wallet: 'wevibe1abc123',
      matched_keywords: ['react', 'typescript', 'nextjs'],
    },
  },
];

let failed = 0;

function runTests() {
  console.log('buildServeBatchMsg_RejectsEmptyMatchedKeywords...');
  try {
    buildServeBatchMsg('signer1', 'org1', 1, [
      {
        memory_content_hash: new Uint8Array([0x01]),
        serve_key: 'key',
        contributor_id: 'id',
        nullifier: new Uint8Array([0x02]),
        model_id: 'm',
        turn_count: 1,
        contributor_wallet: 'w',
        matched_keywords: [],
      },
    ]);
    console.log('  FAIL: expected error was not thrown');
    failed++;
  } catch (e) {
    if (e instanceof Error && e.message.includes('matched_keywords must be non-empty')) {
      console.log('  PASS');
    } else {
      console.log('  FAIL: wrong error:', e);
      failed++;
    }
  }

  console.log('buildServeBatchMsg_RejectsWhitespaceMatchedKeywords...');
  try {
    buildServeBatchMsg('signer1', 'org1', 1, [
      {
        memory_content_hash: new Uint8Array([0x01]),
        serve_key: 'key',
        contributor_id: 'id',
        nullifier: new Uint8Array([0x02]),
        model_id: 'm',
        turn_count: 1,
        contributor_wallet: 'w',
        matched_keywords: ['valid', '  '],
      },
    ]);
    console.log('  FAIL: expected error was not thrown');
    failed++;
  } catch (e) {
    if (e instanceof Error && e.message.includes('matched_keywords entries must be non-empty')) {
      console.log('  PASS');
    } else {
      console.log('  FAIL: wrong error:', e);
      failed++;
    }
  }

  console.log('buildServeBatchMsg_EncodesMatchedKeywords...');
  for (const v of vectors) {
    const msg = buildServeBatchMsg('signer1', 'org1', 1, [v.entry as any]);
    const hex = toHex([...msg.value]);
    const keywordCount = v.entry.matched_keywords.length;
    const tag42Count = findAll(hex, 0x42).length;
    if (tag42Count === keywordCount) {
      console.log(`  PASS: ${v.name} — found ${tag42Count} × 0x42 tags for ${keywordCount} keywords`);
    } else {
      console.log(`  FAIL: ${v.name} — expected ${keywordCount} 0x42 tags, got ${tag42Count}`);
      failed++;
    }
  }

  console.log('buildServeBatchMsg_TypeUrlIsServeBatch...');
  const msg = buildServeBatchMsg('signer1', 'org1', 1, [vectors[0].entry as any]);
  if (msg.typeUrl === '/wevibe.serve.v1.MsgSubmitServeBatch') {
    console.log('  PASS');
  } else {
    console.log(`  FAIL: typeUrl is ${msg.typeUrl}`);
    failed++;
  }

  console.log('buildServeBatchMsg_EncodesHeaderFields...');
  const msg2 = buildServeBatchMsg('signer_addr', 'org_addr', 99, [vectors[0].entry as any]);
  const hex2 = toHex([...msg2.value]);
  const signerTag = hex2.indexOf('0a' + 'signer_addr'.length.toString(16).padStart(2, '0'));
  if (signerTag !== -1) {
    console.log('  PASS');
  } else {
    console.log('  FAIL: signer field not found');
    failed++;
  }

  if (failed > 0) {
    console.log(`\nFAILED ${failed} tests`);
    process.exit(1);
  } else {
    console.log('\nAll tests passed');
  }
}

runTests();
