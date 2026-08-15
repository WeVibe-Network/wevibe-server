// Unit tests for the pure wallet-error detail builder (copy-error.ts).
// Exercises ONLY buildWalletErrorDetail — pure, Node-import-safe, no DOM,
// no clipboard (copyToClipboard is deliberately NOT imported here). Mirrors
// lib/wallet-seed-wrap.test.ts harness style.
// Run via:
//   npx tsx lib/copy-error.test.ts

import { buildWalletErrorDetail } from './copy-error';

let failed = 0;
let total = 0;

function report(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}\n  ${detail}`);
}

function main() {
  // (a) Error WITH stack: detail carries message + name + stack first frame.
  const errWithStack = new Error('keplr wallet not found');
  const stackLines = (errWithStack.stack ?? '').split('\n');
  const firstFrame = stackLines.find((line) => line.includes(' at ')) ?? '';
  const detailA = buildWalletErrorDetail(errWithStack, {
    chainId: 'wevibe-devnet-1',
    detectedWallets: ['keplr'],
  });
  report(
    'Error with stack: message + name + first stack frame present',
    detailA.includes('keplr wallet not found')
      && detailA.includes('Error')
      && firstFrame.length > 0
      && detailA.includes(firstFrame),
    `message ${detailA.includes('keplr wallet not found')}, name ${detailA.includes('Error')}, first frame "${firstFrame.trim()}" ${detailA.includes(firstFrame)}`,
  );

  // (b) Non-Error thrown value: detail carries the raw string.
  const detailB = buildWalletErrorDetail('provider rejected the request', {
    chainId: 'wevibe-devnet-1',
    detectedWallets: [],
  });
  report(
    'non-Error thrown value: raw string present',
    detailB.includes('provider rejected the request'),
    `contains raw string ${detailB.includes('provider rejected the request')}`,
  );

  // (c) Zero detected wallets: "none" rendered AND chainId value present.
  const chainId = 'wevibe-local-42';
  const detailC = buildWalletErrorDetail(new Error('no wallet'), {
    chainId,
    detectedWallets: [],
  });
  report(
    'zero wallets: renders "none" and the chainId',
    detailC.includes('detected=none') && detailC.includes(chainId),
    `detected=none ${detailC.includes('detected=none')}, chainId ${detailC.includes(chainId)}`,
  );

  // (d) Both providers detected: both names present.
  const detailD = buildWalletErrorDetail(new Error('no wallet'), {
    chainId: 'wevibe-devnet-1',
    detectedWallets: ['keplr', 'leap'],
  });
  report(
    'detected wallets [keplr, leap]: both names present',
    detailD.includes('keplr') && detailD.includes('leap'),
    `keplr ${detailD.includes('keplr')}, leap ${detailD.includes('leap')}`,
  );

  // (e) Error with NO stack: message present, Stack section header absent.
  const errNoStack = new Error('window.keplr is undefined');
  delete (errNoStack as { stack?: unknown }).stack;
  const detailE = buildWalletErrorDetail(errNoStack, {
    chainId: 'wevibe-devnet-1',
    detectedWallets: [],
  });
  report(
    'Error without stack: message present, Stack header absent',
    detailE.includes('window.keplr is undefined') && !detailE.includes('Stack:'),
    `message ${detailE.includes('window.keplr is undefined')}, header absent ${!detailE.includes('Stack:')}`,
  );

  if (failed > 0) {
    console.log(`\nFAILED ${failed} of ${total} copy-error tests`);
    process.exit(1);
  }
  console.log(`\nAll ${total} copy-error tests PASSED`);
}

main();
