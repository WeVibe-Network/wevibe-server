# WeVibe Dashboard

WeVibe Dashboard is the hub-hosted web control surface for organization management and curation in the public WeVibe Network.

- **Framework:** Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS
- **Default port:** `3000`
- **Container support:** `wevibe-dashboard/Dockerfile`

## Alpha status

The dashboard is in active alpha. Primary workflows are implemented and exercised by end-to-end tests, with additional UX and identity improvements planned.

## What it includes today

- Moderation review queue
- Memory browser and direct memory authoring
- Member management and org configuration
- Keyword taxonomy management
- Recovery status and billing surfaces
- Contributor session extract → review → submit flow
- Chain submit tooling and denial-batch panel
- Reports surface
- Profile pages, including public profiles at `/u/[wallet]`

## Architecture boundary

- The dashboard calls the hub over HTTP.
- Chain-bound actions are signed in the client wallet and broadcast directly to chain RPC via CosmJS.
- The hub does not relay leader-signed transactions for this flow.

## Local data and crypto integrations

- Vendors `wevibe-sdk-wasm` from `vendor/wevibe-sdk-wasm`
- Uses `better-sqlite3` server routes under `app/api/sessions/*` to read the local coding-agent session database for the contributor extract flow

## Local development

From `wevibe-server/wevibe-dashboard`:

```bash
npm run dev
npm run build
npm run type-check
npm run test:e2e
```

Additional script:

```bash
npm run test:mcp
```

## Repository layout

- `app/` — App Router pages and API routes
- `app/(dashboard)/` — authenticated dashboard surfaces
- `app/u/[wallet]/` — public profile route
- `components/` — shared UI components
- `lib/` — hub client, chain client, auth, and org context
- `e2e/` — Playwright end-to-end suite
- `docs/` — topology and design docs

## Links

- Docs: https://github.com/WeVibe-Network/wevibe-docs
- Org: https://github.com/WeVibe-Network
- X: https://x.com/WeVibe_Network
