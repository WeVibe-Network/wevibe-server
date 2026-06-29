# WeVibe Dashboard Whitepaper

Version: 0.5 · Sprint 24

## Mission

wevibe-dashboard is the human interface for org leaders and moderators. It provides review queues, member management, rotation tooling, and analytics powered entirely by wevibe-hub APIs. No dashboard component touches plaintext memories beyond what moderators are allowed to see.

## Core Principles

1. **Hub-only data access** — dashboard never connects directly to databases or wevibe-chain.
2. **Moderator-first UX** — queue prioritisation, guard findings, lifecycle state, and relationship context visible at a glance.
3. **Seamless admin workflows** — membership, treasury funding, epoch rotation, and configuration managed in one surface.
4. **Strict separation** — playback views render decrypted memory only when moderator privileges permit.

## Feature Highlights

- **Moderation queue**: displays pending commitments, guard detections, proposed relationships, validity metadata, and allows approve/reject + commentary.
- **Lifecycle controls**: leaders can archive, relate, set validity bounds, or kick off contests directly from the UI.
- **Org analytics**: retrieval confidence distribution, serve volumes, contest status, and treasury trends sourced from hub metrics.
- **Member operations**: invite/remove members, assign roles, trigger epoch rotations (integrates with anchor manifests).
- **Registry explorer**: searchable list of public orgs and keywords for discovery.

## Security Model

- Authentication via org member ed25519 keypair stored in browser (MVP) or wallet connector (future Solana/EVM support).
- All sensitive actions require guardian approval flows; rotation actions cross-check anchor manifest signatures.
- Dashboard caches minimal data; sensitive payloads stored in IndexedDB encrypted with WebCrypto (`AES-GCM`).

## Roadmap

- Integrate serve receipt review (view contested memories).
- Multi-language localization.
- Fine-grained audit log exports compatible with compliance tooling.

## Sprint 24 Updates

- Introduced a dedicated Reports queue that surfaces moderator votes, escalation totals, and final resolutions in lockstep with the hub’s `required_approvals` governance.
- Settings now exposes the `required_approvals` field, enabling leaders to tune quorum policy without redeploying infrastructure or touching chain state directly.
- The dashboard consumes the new Accept / Deny / Report actions emitted by the OpenCode plugin, ensuring reported memories stay quarantined until moderators act.
