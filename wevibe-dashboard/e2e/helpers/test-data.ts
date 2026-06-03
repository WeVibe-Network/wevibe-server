export const TEST_ORG = {
  org_id: 'test-org-1',
  org_name: 'Test Organization',
  domain: 'testing',
  leader_pubkey: 'leader-pubkey-abcd1234',
  current_epoch: 1,
  egress_mode: 'unrestricted',
  allowed_providers: [],
  status: 'active',
  rotation_status: 'active',
  required_approvals: 1,
  created_at: '2026-01-01T00:00:00Z',
};

export const TEST_MEMBERS = [
  {
    org_id: 'test-org-1',
    pubkey: 'leader-pubkey-abcd1234',
    x25519_pubkey: 'x25519-leader-key',
    role: 'leader',
    join_epoch: 0,
    history_access_from_epoch: 0,
    authorized_until_epoch: null,
    active: true,
    joined_at: '2026-01-01T00:00:00Z',
    wallet_address: 'wevibe1leader000000000000000000000',
  },
  {
    org_id: 'test-org-1',
    pubkey: 'mod-pubkey-efgh5678',
    x25519_pubkey: 'x25519-mod-key',
    role: 'moderator',
    join_epoch: 1,
    history_access_from_epoch: 1,
    authorized_until_epoch: null,
    active: true,
    joined_at: '2026-01-02T00:00:00Z',
    wallet_address: null,
  },
  {
    org_id: 'test-org-1',
    pubkey: 'member-pubkey-ijkl9012',
    x25519_pubkey: 'x25519-member-key',
    role: 'member',
    join_epoch: 1,
    history_access_from_epoch: 1,
    authorized_until_epoch: null,
    active: true,
    joined_at: '2026-01-03T00:00:00Z',
    wallet_address: 'wevibe1member00000000000000000000',
  },
  {
    org_id: 'test-org-1',
    pubkey: 'contrib-pubkey-mnop3456',
    x25519_pubkey: 'x25519-contrib-key',
    display_name: 'Contributor Test User',
    role: 'contributor',
    join_epoch: 1,
    history_access_from_epoch: 1,
    authorized_until_epoch: null,
    active: true,
    joined_at: '2026-01-04T00:00:00Z',
    wallet_address: 'wevibe1contrib0000000000000000000',
  },
];

export const TEST_KEYWORDS = [
  { keyword: 'docker', deprecated: false, created_at: '2026-01-01T00:00:00Z', usage_count: 0 },
  { keyword: 'kubernetes', deprecated: false, created_at: '2026-01-01T00:00:00Z', usage_count: 0 },
  { keyword: 'nginx', deprecated: true, created_at: '2026-01-01T00:00:00Z', usage_count: 0 },
];

export const TEST_EPOCH_MANIFEST = {
  org_id: 'test-org-1',
  epoch_id: 1,
  pk_mod: 'test-pk-mod-key',
  signed_by: 'leader-pubkey-abcd1234',
  signature: 'test-signature',
  created_at: '2026-01-01T00:00:00Z',
};

export const TEST_RECOVERY_SHARE = {
  org_id: 'test-org-1',
  share_index: 1,
  holder_pubkey: 'leader-pubkey-abcd1234',
  sealed_share: 'encrypted-share-data',
};

export const TEST_CREDIT_BALANCE = {
  org_id: 'test-org-1',
  balance: 1000,
  transactions: [],
};
