# @quorvel/web

Quorvel marketing site (landing page). Faithful port of the v7 design into
Next.js 14 (App Router).

## Architecture

- `app/layout.tsx` — root layout: metadata (title/description/OG/Twitter),
  favicon, theme color, and Google Fonts (Space Grotesk, Inter, JetBrains Mono).
- `app/page.tsx` — server component; renders the v7 markup (SSR'd for SEO)
  and mounts the client script runner.
- `app/LandingScripts.tsx` — client component; injects the original v7 IIFE
  once after mount (nav shadow, reveals, marquee, live ledger, primitive
  dial, canvas globe, code typing, waitlist form).
- `app/globals.css` — the full v7 stylesheet (asset URLs rewritten to
  `/assets/...`).
- `app/_data/bodyHtml.ts` — v7 body markup as a string (server-only).
- `app/_data/appJs.ts` — v7 inline script as a string (client-only).
- `public/assets/` — all 17 image assets.

## Local development

From the repo root:

```bash
pnpm install
pnpm --filter @quorvel/web dev
```

Then open http://localhost:3001

## Build

```bash
pnpm --filter @quorvel/web build
pnpm --filter @quorvel/web start
```

## Notes

- The waitlist form posts to Formspree (`https://formspree.io/f/xrewbpaw`).
- Pricing buttons currently open the waitlist overlay. Paddle.js checkout
  will be wired in at billing go-live.
- To deploy on Vercel, set the project root to `apps/web`.
