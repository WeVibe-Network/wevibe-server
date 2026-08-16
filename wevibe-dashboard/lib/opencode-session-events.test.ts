// Unit tests for the session-source discriminator in opencode-session-events.ts:
// getDbPath() decides whether session pickup reads the OPENCODE_DB_PATH override
// or the default OpenCode DB location. Pure env-based logic only — no DB opened.
// Mirrors lib/wallet-seed-wrap.test.ts harness style.
// Run via:
//   npx tsx lib/opencode-session-events.test.ts

import { homedir } from 'os';
import { join } from 'path';

import { getDbPath } from './opencode-session-events';

let failed = 0;
let total = 0;

function report(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}\n  ${detail}`);
}

function main(): void {
  const defaultPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  const originalDbPath = process.env.OPENCODE_DB_PATH;

  try {
    // 1. OPENCODE_DB_PATH set -> override wins.
    process.env.OPENCODE_DB_PATH = '/tmp/bench/session-db/opencode.db';
    const overridden = getDbPath();
    report(
      'getDbPath: OPENCODE_DB_PATH override wins',
      overridden === '/tmp/bench/session-db/opencode.db',
      `got "${overridden}" (expected "/tmp/bench/session-db/opencode.db")`,
    );

    // 2. OPENCODE_DB_PATH empty string -> default (empty-string hardening).
    process.env.OPENCODE_DB_PATH = '';
    const emptied = getDbPath();
    report(
      'getDbPath: empty-string override -> default path',
      emptied === defaultPath,
      `got "${emptied}" (expected "${defaultPath}")`,
    );

    // 3. OPENCODE_DB_PATH deleted -> default.
    delete process.env.OPENCODE_DB_PATH;
    const unset = getDbPath();
    report(
      'getDbPath: unset env -> default path',
      unset === defaultPath,
      `got "${unset}" (expected "${defaultPath}")`,
    );
  } finally {
    // Restore the original environment so the test is clean/repeatable.
    if (originalDbPath === undefined) {
      delete process.env.OPENCODE_DB_PATH;
    } else {
      process.env.OPENCODE_DB_PATH = originalDbPath;
    }
  }

  if (failed > 0) {
    console.log(`\nFAILED ${failed} of ${total} opencode-session-events tests`);
    process.exit(1);
  }
  console.log(`\nAll ${total} opencode-session-events tests PASSED`);
}

main();
