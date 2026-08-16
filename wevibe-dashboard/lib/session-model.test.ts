// Unit tests for session-model normalization + provider surfacing
// (session-model.ts). Pure functions only — no network, no filesystem.
// Mirrors lib/wallet-seed-wrap.test.ts harness style.
// Run via:
//   npx tsx lib/session-model.test.ts

import {
  resolveExtractionProvider,
  resolveSessionModel,
  resolveSessionModelSlug,
} from './session-model';

let failed = 0;
let total = 0;

function report(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}\n  ${detail}`);
}

function main(): void {
  // ---- 1. resolveSessionModelSlug backward-compat (slug-only wrapper) ----

  // 1a. Plain slug passthrough.
  const plainSlug = resolveSessionModelSlug('deepseek/deepseek-v4-pro-0813');
  report(
    'resolveSessionModelSlug: plain slug passthrough',
    plainSlug === 'deepseek/deepseek-v4-pro-0813',
    `got "${plainSlug}" (expected "deepseek/deepseek-v4-pro-0813")`,
  );

  // 1b. JSON-stringified record -> bare .id slug.
  const jsonSlug = resolveSessionModelSlug('{"id":"a/b","providerID":"orcarouter","variant":"default"}');
  report(
    'resolveSessionModelSlug: JSON record -> .id slug',
    jsonSlug === 'a/b',
    `got "${jsonSlug}" (expected "a/b")`,
  );

  // 1c. Empty string -> empty string.
  const emptySlug = resolveSessionModelSlug('');
  report(
    'resolveSessionModelSlug: empty string -> empty string',
    emptySlug === '',
    `got "${emptySlug}" (expected "")`,
  );

  // 1d. Invalid JSON passthrough (treated as a plain slug).
  const invalidJson = resolveSessionModelSlug('not json');
  report(
    'resolveSessionModelSlug: invalid JSON passthrough',
    invalidJson === 'not json',
    `got "${invalidJson}" (expected "not json")`,
  );

  // 1e. JSON without an id passthrough (whole trimmed text preserved).
  const noIdJson = resolveSessionModelSlug('{"foo":1}');
  report(
    'resolveSessionModelSlug: JSON without id passthrough',
    noIdJson === '{"foo":1}',
    `got "${noIdJson}" (expected '{"foo":1}')`,
  );

  // ---- 2. resolveSessionModel: providerID survival ----

  // 2a. Full record: slug AND providerID both surfaced.
  const resolved = resolveSessionModel('{"id":"deepseek/deepseek-v4-flash-0731","providerID":"orcarouter","variant":"default"}');
  const fullOk = resolved.slug === 'deepseek/deepseek-v4-flash-0731' && resolved.providerID === 'orcarouter';
  report(
    'resolveSessionModel: slug + providerID both surfaced',
    fullOk,
    `got { slug: "${resolved.slug}", providerID: ${JSON.stringify(resolved.providerID)} } (expected { slug: "deepseek/deepseek-v4-flash-0731", providerID: "orcarouter" })`,
  );

  // 2b. Record without providerID -> providerID undefined.
  const noProvider = resolveSessionModel('{"id":"x/y"}');
  const noProviderOk = noProvider.slug === 'x/y' && noProvider.providerID === undefined;
  report(
    'resolveSessionModel: providerID absent -> undefined',
    noProviderOk,
    `got { slug: "${noProvider.slug}", providerID: ${JSON.stringify(noProvider.providerID)} } (expected providerID undefined)`,
  );

  // 2c. Non-string providerID -> undefined.
  const nonStringProvider = resolveSessionModel('{"id":"x/y","providerID":123}');
  const nonStringOk = nonStringProvider.slug === 'x/y' && nonStringProvider.providerID === undefined;
  report(
    'resolveSessionModel: non-string providerID -> undefined',
    nonStringOk,
    `got { slug: "${nonStringProvider.slug}", providerID: ${JSON.stringify(nonStringProvider.providerID)} } (expected providerID undefined)`,
  );

  // 2d. Whitespace-only providerID -> undefined.
  const wsProvider = resolveSessionModel('{"id":"x/y","providerID":"  "}');
  const wsOk = wsProvider.slug === 'x/y' && wsProvider.providerID === undefined;
  report(
    'resolveSessionModel: whitespace-only providerID -> undefined',
    wsOk,
    `got { slug: "${wsProvider.slug}", providerID: ${JSON.stringify(wsProvider.providerID)} } (expected providerID undefined)`,
  );

  // 2e. Plain slug -> providerID undefined.
  const plainResolved = resolveSessionModel('x/y');
  const plainOk = plainResolved.slug === 'x/y' && plainResolved.providerID === undefined;
  report(
    'resolveSessionModel: plain slug -> providerID undefined',
    plainOk,
    `got { slug: "${plainResolved.slug}", providerID: ${JSON.stringify(plainResolved.providerID)} } (expected providerID undefined)`,
  );

  // ---- 3. resolveExtractionProvider routing ----

  // 3a. orcarouter producer routes to orcarouter.
  const routeOrca = resolveExtractionProvider('orcarouter', 'openrouter');
  report(
    'resolveExtractionProvider: orcarouter producer -> orcarouter',
    routeOrca === 'orcarouter',
    `got "${routeOrca}" (expected "orcarouter")`,
  );

  // 3b. Absent providerID -> fallback.
  const routeAbsent = resolveExtractionProvider(undefined, 'openrouter');
  report(
    'resolveExtractionProvider: absent providerID -> fallback',
    routeAbsent === 'openrouter',
    `got "${routeAbsent}" (expected "openrouter")`,
  );

  // 3c. Absent providerID -> ollama fallback preserved.
  const routeOllama = resolveExtractionProvider(undefined, 'ollama');
  report(
    'resolveExtractionProvider: absent providerID -> ollama fallback',
    routeOllama === 'ollama',
    `got "${routeOllama}" (expected "ollama")`,
  );

  // 3d. Non-orcarouter producer still uses fallback.
  const routeOther = resolveExtractionProvider('openrouter', 'ollama');
  report(
    'resolveExtractionProvider: non-orcarouter producer -> fallback',
    routeOther === 'ollama',
    `got "${routeOther}" (expected "ollama")`,
  );

  if (failed > 0) {
    console.log(`\nFAILED ${failed} of ${total} session-model tests`);
    process.exit(1);
  }
  console.log(`\nAll ${total} session-model tests PASSED`);
}

main();
