import { test as base, expect, Page } from '@playwright/test';
import { mockHubApi, MockHubController } from './helpers/mock-hub';
import { SidebarPage } from './page-objects';

type WeVibeFixtures = {
  connectedPage: Page;
  mockHub: void;
  sidebar: SidebarPage;
};

export const test = base.extend<WeVibeFixtures>({
  mockHub: async ({ page }, use) => {
    const controller = await mockHubApi(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const pubkeyHex = await page.evaluate(async () => {
      const DB_NAME = 'wevibe-dashboard';
      const STORE_NAME = 'keys';
      const KEY_ID = 'dashboard-identity';

      function openDB(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open(DB_NAME, 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
              db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }

      try {
        const db = await openDB();
        const existing = await new Promise<any>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.get(KEY_ID);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });

        if (existing) return existing.pubkeyHex as string;

        const keyPair = await crypto.subtle.generateKey(
          { name: 'Ed25519' },
          true,
          ['sign', 'verify'],
        );

        const rawPubkey = await crypto.subtle.exportKey('raw', keyPair.publicKey);
        const pubkeyHex = Array.from(new Uint8Array(rawPubkey))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');

        const identity = {
          id: KEY_ID,
          publicKey: keyPair.publicKey,
          privateKey: keyPair.privateKey,
          pubkeyHex,
          createdAt: new Date().toISOString(),
        };

        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          const req = store.put(identity);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });

        return pubkeyHex;
      } catch (e) {
        console.error('[E2E FIXTURE] Failed to set up test identity:', e);
        return '';
      }
    });
    controller.setLeaderPubkey(pubkeyHex);
    await use();
  },

  sidebar: async ({ page }, use) => {
    const sidebar = new SidebarPage(page);
    await use(sidebar);
  },

  connectedPage: async ({ page, mockHub }, use) => {
    await mockHubApi(page);
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await use(page);
  },
});

export { expect } from '@playwright/test';