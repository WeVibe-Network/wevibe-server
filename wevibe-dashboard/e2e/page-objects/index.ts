import { Page, Locator } from '@playwright/test';

export class SidebarPage {
  readonly page: Page;
  readonly sessionsLink: Locator;
  readonly moderationLink: Locator;
  readonly reportsLink: Locator;
  readonly memoriesLink: Locator;
  readonly membersLink: Locator;
  readonly billingLink: Locator;
  readonly settingsLink: Locator;
  readonly keywordsLink: Locator;
  readonly recoveryLink: Locator;
  readonly epochLink: Locator;
  readonly createOrgLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.sessionsLink = page.getByTestId('nav-sessions');
    this.moderationLink = page.getByTestId('nav-moderation');
    this.reportsLink = page.getByTestId('nav-reports');
    this.memoriesLink = page.getByTestId('nav-memories');
    this.membersLink = page.getByTestId('nav-members');
    this.billingLink = page.getByTestId('nav-billing');
    this.settingsLink = page.getByTestId('nav-settings');
    this.keywordsLink = page.getByTestId('nav-keywords');
    this.recoveryLink = page.getByTestId('nav-recovery');
    this.epochLink = page.getByTestId('nav-epoch');
    this.createOrgLink = page.getByTestId('nav-create-org');
  }

  async navigateTo(path: string) {
    await this.page.goto(path);
  }
}

export class MembersPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async getMemberRows() {
    return this.page.locator('table tbody tr');
  }

  async clickInviteTab() {
    await this.page.getByTestId('invite-tab').click();
  }

  async fillInviteForm(pubkey: string, x25519Pubkey: string, role: string) {
    await this.page.getByTestId('invite-pubkey-input').fill(pubkey);
    await this.page.getByTestId('invite-x25519-input').fill(x25519Pubkey);
    await this.page.getByTestId('invite-role-select').selectOption(role);
  }

  async submitInvite() {
    await this.page.getByTestId('invite-submit').click();
  }
}

export class KeywordsPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async getKeywordList() {
    return this.page.getByTestId('keyword-list');
  }
}

export class RecoveryPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async saveShares() {
    await this.page.getByTestId('recovery-save-button').click();
  }

  async retrieveShare() {
    await this.page.getByTestId('recovery-retrieve-button').click();
  }
}

export class EpochPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async rotateEpoch() {
    await this.page.getByTestId('epoch-rotate-button').click();
  }
}
