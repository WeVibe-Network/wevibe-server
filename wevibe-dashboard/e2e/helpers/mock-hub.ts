import { Page } from '@playwright/test';
import { TEST_ORG, TEST_MEMBERS, TEST_KEYWORDS } from './test-data';

export interface MockHubController {
  setLeaderPubkey(pk: string): void;
}

export async function mockHubApi(page: Page): Promise<MockHubController> {
  let leaderPubkey = TEST_ORG.leader_pubkey;

  await page.route('**/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', version: '0.2.0' }),
  }));

  await page.route('**/v1/orgs/**', (route, request) => {
    const url = request.url();

    if (request.method() === 'GET' && url.match(/\/v1\/orgs\/[^/]+$/)) {
      const orgId = url.split('/v1/orgs/')[1].split('?')[0];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...TEST_ORG, org_id: orgId, leader_pubkey: leaderPubkey }),
      });
    }

    if (request.method() === 'GET' && url.match(/\/v1\/orgs\/[^/]+\/config/)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ required_approvals: 1 }),
      });
    }

    if (request.method() === 'GET' && url.includes('/members')) {
      const dynamicMembers = TEST_MEMBERS.map(m =>
        m.role === 'leader' ? { ...m, pubkey: leaderPubkey } : m
      );
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(dynamicMembers),
      });
    }

    if (request.method() === 'POST' && url.includes('/members') && !url.includes('/wallet')) {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(TEST_MEMBERS[1]),
      });
    }

    if (request.method() === 'DELETE' && url.includes('/members/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      });
    }

    if (request.method() === 'PATCH' && url.includes('/role')) {
      const updated = { ...TEST_MEMBERS[1], role: 'moderator' };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(updated),
      });
    }

    if (request.method() === 'GET' && url.match(/\/v1\/orgs\/[^/]+\/keywords/)) {
      console.log('[MOCK] GET /keywords matched, URL:', url);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(TEST_KEYWORDS),
      });
    }

    if (request.method() === 'POST' && url.includes('/keywords')) {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ keyword: 'new-keyword' }),
      });
    }

    if (request.method() === 'PUT' && url.includes('/keywords')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      });
    }

    if (request.method() === 'DELETE' && url.includes('/keywords')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      });
    }

    if (request.method() === 'GET' && url.includes('/recovery/shares')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ share_index: 1, sealed_share: 'mock-share-data' }),
      });
    }

    if (request.method() === 'POST' && url.includes('/recovery/shares')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok' }),
      });
    }

    if (request.method() === 'GET' && url.includes('/credits')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ org_id: TEST_ORG.org_id, balance: 1000, transactions: [] }),
      });
    }

    if (request.method() === 'GET' && url.includes('/reports')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ reports: [], total: 0 }),
      });
    }

    if (request.method() === 'GET' && url.includes('/moderation/queue')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], total: 0 }),
      });
    }

    if (request.method() === 'GET' && url.includes('/memories')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ memories: [], total: 0 }),
      });
    }

    return route.continue();
  });

  await page.route('**/v1/billing/topup', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ org_id: TEST_ORG.org_id, balance: 2000 }),
  }));

  await page.route('**/v1/members/*/orgs', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ orgs: [] }),
  }));

  await page.route('**/v1/orgs', route => route.fulfill({
    status: 201,
    contentType: 'application/json',
    body: JSON.stringify({ ...TEST_ORG }),
  }));

  return {
    setLeaderPubkey(pk: string) {
      leaderPubkey = pk;
    },
  };
}
