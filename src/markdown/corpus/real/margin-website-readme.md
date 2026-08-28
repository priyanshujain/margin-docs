# margin website

The marketing site for **Margin** — the offline book-writing and publishing app. Built with
[Astro](https://astro.build), it's a single landing page that ships almost no JavaScript and
reuses the app's *Quiet Press* design system (Literata + Hanken Grotesk, warm light/dark themes).

## Develop

```sh
cd website
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # static output to website/dist/
pnpm preview    # preview the production build
```

## Where to change things

Almost everything lives in **`src/data/site.ts`**:

- `price` — the one-time price (`"$5"` / `"$10"` …). Shown everywhere automatically.
- `repo` — the GitHub repo (`priyanshujain/margin`) that hosts release artifacts.
- `buyUrl` — point this at a payment processor (Gumroad / Polar / Stripe / Lemon Squeezy)
  when one is wired up; until then it falls back to the GitHub releases page.
- `faqs`, `compare`, `publishTargets` — the page content.

## Downloads

Download buttons resolve the **latest GitHub release** asset per OS at runtime
(`src/components/DownloadScript.astro`):

- macOS → `.dmg`
- Windows → `.msi`
- Linux → `.AppImage` (falls back to `.deb` / `.rpm`)

The OS is auto-detected for the primary button. If the GitHub API is unreachable or there's no
published release yet, every button falls back to the releases page — so they always work.

## Deploy

`pnpm build` produces a fully static `dist/` that hosts anywhere — GitHub Pages, Cloudflare
Pages, Netlify, Vercel. Set the real domain in `astro.config.mjs` (`site`) for correct
canonical / Open Graph URLs.

## Fonts

`public/fonts/` carries the same OFL variable fonts the app bundles (Literata, Hanken Grotesk),
so the site matches the product exactly.
