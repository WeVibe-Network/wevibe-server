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

function utf8Hex(value: string): string {
  return Buffer.from(value).toString('hex');
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

const serveMultiEntries = [
  {
    memory_content_hash: new Uint8Array([0x10, 0x11, 0x12]),
    serve_key: 'serve_key_alpha',
    contributor_id: 'contrib_alpha',
    nullifier: new Uint8Array([0x20, 0x21, 0x23]),
    model_id: 'model-alpha',
    turn_count: 2,
    contributor_wallet: 'wevibe1alpha',
    matched_keywords: ['alpha', 'beta'],
  },
  {
    memory_content_hash: new Uint8Array([0x30, 0x31, 0x32]),
    serve_key: 'serve_key_gamma',
    contributor_id: 'contrib_gamma',
    nullifier: new Uint8Array([0x40, 0x41, 0x43]),
    model_id: 'model-gamma',
    turn_count: 3,
    contributor_wallet: 'wevibe1gamma',
    matched_keywords: ['gamma'],
  },
];

const denialEntries = [
  {
    memory_hash: 'aabbccdd',
    nullifier: '01020304',
    deny_key: 'deny_key_alpha',
    reason: 'policy_violation_alpha',
  },
  {
    memory_hash: '11223344',
    nullifier: '05060708',
    deny_key: 'deny_key_beta',
    reason: 'policy_violation_beta',
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

  console.log('buildServeBatchMsg_AllowsEmptyEntriesArray...');
  const emptyServeMsg = buildServeBatchMsg('s', 'o', 1, []);
  const emptyServeHex = toHex([...emptyServeMsg.value]);
  if (
    emptyServeMsg.typeUrl === '/wevibe.serve.v1.MsgSubmitServeBatch' &&
    emptyServeHex === '0a017312016f1801'
  ) {
    console.log('  PASS');
  } else {
    console.log(`  FAIL: typeUrl=${emptyServeMsg.typeUrl} hex=${emptyServeHex}`);
    failed++;
  }

  console.log('buildServeBatchMsg_EncodesMultipleEntries...');
  const multiServeMsg = buildServeBatchMsg('signer_multi', 'org_multi', 7, serveMultiEntries);
  const multiServeHex = toHex([...multiServeMsg.value]);
  const expectedKeywordTags =
    serveMultiEntries[0].matched_keywords.length + serveMultiEntries[1].matched_keywords.length;
  const actualKeywordTags = findAll(multiServeHex, 0x42).length;
  const hasBothServeKeys =
    multiServeHex.includes(utf8Hex(serveMultiEntries[0].serve_key)) &&
    multiServeHex.includes(utf8Hex(serveMultiEntries[1].serve_key));
  if (hasBothServeKeys && actualKeywordTags === expectedKeywordTags) {
    console.log('  PASS');
  } else {
    console.log(
      `  FAIL: hasBothServeKeys=${hasBothServeKeys} keywordTags=${actualKeywordTags}/${expectedKeywordTags}`,
    );
    failed++;
  }

  console.log('buildServeBatchMsg_EncodesTurnCountVarint...');
  const turnCountMsg = buildServeBatchMsg('turn_signer', 'turn_org', 1, [
    {
      memory_content_hash: new Uint8Array([0xaa, 0xbb]),
      serve_key: 'turn_key',
      contributor_id: 'turn_id',
      nullifier: new Uint8Array([0xcc, 0xdd]),
      model_id: 'turn_model',
      turn_count: 300,
      contributor_wallet: 'wevibe1turn',
      matched_keywords: ['turn'],
    },
  ]);
  const turnCountHex = toHex([...turnCountMsg.value]);
  if (turnCountHex.includes('30ac02')) {
    console.log('  PASS');
  } else {
    console.log(`  FAIL: turn_count varint marker 30ac02 not found in ${turnCountHex}`);
    failed++;
  }

  console.log('buildServeBatchMsg_DeterministicBytes...');
  const serveDetA = buildServeBatchMsg('det_signer', 'det_org', 5, [serveMultiEntries[0]]);
  const serveDetB = buildServeBatchMsg('det_signer', 'det_org', 5, [serveMultiEntries[0]]);
  const serveDetHexA = toHex([...serveDetA.value]);
  const serveDetHexB = toHex([...serveDetB.value]);
  if (serveDetHexA === serveDetHexB) {
    console.log('  PASS');
  } else {
    console.log(`  FAIL: first=${serveDetHexA} second=${serveDetHexB}`);
    failed++;
  }

  console.log('buildDenialBatchMsg_AllowsEmptyEntriesArray...');
  const emptyDenialMsg = buildDenialBatchMsg('s', 'o', 1, []);
  const emptyDenialHex = toHex([...emptyDenialMsg.value]);
  if (
    emptyDenialMsg.typeUrl === '/wevibe.serve.v1.MsgSubmitDenialBatch' &&
    emptyDenialHex === '0a017312016f1801'
  ) {
    console.log('  PASS');
  } else {
    console.log(`  FAIL: typeUrl=${emptyDenialMsg.typeUrl} hex=${emptyDenialHex}`);
    failed++;
  }

  console.log('buildDenialBatchMsg_EncodesMultipleEntries...');
  const multiDenialMsg = buildDenialBatchMsg('deny_signer', 'deny_org', 3, denialEntries);
  const multiDenialHex = toHex([...multiDenialMsg.value]);
  const hasBothDenyKeys =
    multiDenialHex.includes(utf8Hex(denialEntries[0].deny_key)) &&
    multiDenialHex.includes(utf8Hex(denialEntries[1].deny_key));
  const reasonFieldHex =
    '22' +
    denialEntries[0].reason.length.toString(16).padStart(2, '0') +
    utf8Hex(denialEntries[0].reason);
  if (hasBothDenyKeys && multiDenialHex.includes(reasonFieldHex)) {
    console.log('  PASS');
  } else {
    console.log(`  FAIL: hasBothDenyKeys=${hasBothDenyKeys} reasonFieldPresent=${multiDenialHex.includes(reasonFieldHex)}`);
    failed++;
  }

  console.log('buildDenialBatchMsg_DeterministicBytes...');
  const denialDetA = buildDenialBatchMsg('deny_det_signer', 'deny_det_org', 9, denialEntries);
  const denialDetB = buildDenialBatchMsg('deny_det_signer', 'deny_det_org', 9, denialEntries);
  const denialDetHexA = toHex([...denialDetA.value]);
  const denialDetHexB = toHex([...denialDetB.value]);
  if (denialDetHexA === denialDetHexB) {
    console.log('  PASS');
  } else {
    console.log(`  FAIL: first=${denialDetHexA} second=${denialDetHexB}`);
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
