<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:02100a,100:2fe07a&height=160&section=header&text=WeVibe%20Dashboard&fontColor=54f59a&fontSize=42&fontAlignY=40&desc=Org%20management%20and%20curation%20UI&descAlignY=64&descSize=16" alt="WeVibe Dashboard" width="100%" />

![Next.js](https://img.shields.io/badge/Next.js-000000?style=flat-square&logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
[![status-alpha](https://img.shields.io/badge/status-alpha-ffc266?style=flat-square)](https://github.com/WeVibe-Network)
[![license-Apache--2.0](https://img.shields.io/badge/license-Apache--2.0-82aaff?style=flat-square)](../LICENSE)
[![docs-wevibe-docs](https://img.shields.io/badge/docs-wevibe--docs-54f59a?style=flat-square)](https://github.com/WeVibe-Network/wevibe-docs)
[![%40WeVibe__Network](https://img.shields.io/badge/%40WeVibe__Network-0a0a0a?style=flat-square&logo=x&logoColor=white)](https://x.com/WeVibe_Network)

</div>

---

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
