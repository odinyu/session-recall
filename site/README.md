# Session Recall — landing page

Static, framework-free product page for [Session Recall](https://github.com/odinyu/session-recall).

- `index.html` — English (`/`)
- `zh/index.html` — Chinese (`/zh/`)
- `assets/site.css` — one stylesheet, design tokens copied from the app (`web/styles.css`)
- `assets/site.js` — copy-to-clipboard only; the page works without JS
- `assets/screenshots/{en,zh}/…-1440.webp`, `…-720.webp` — responsive derivatives of
  `docs/screenshots/…`; the originals are untouched
- `assets/og.png` — 1200×630 social card
- `_headers`, `_redirects`, `robots.txt`, `sitemap.xml` — Cloudflare Pages config and SEO

There is no build step. The deployment output directory is `site/`, published as
Cloudflare Workers static assets through `wrangler.jsonc` at the repository root.
The production site is **https://070801.top**.

---

## Deploy on Cloudflare Workers (current)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Workers** → **Connect to Git**.
2. Pick **`odinyu/session-recall`** and the **`main`** branch.
3. **Project name:** `session-recall` (must match `name` in `wrangler.jsonc`).
4. **Build command:** leave **empty**. The site has no build step.
5. **Deploy command:** `npx wrangler deploy`.
6. **Preview command:** either set `npx wrangler versions upload`, or turn off
   **Enable preview builds**; the production deploy does not need it.
7. Deploy. `wrangler.jsonc` serves `./site` as static assets; `_headers` and
   `_redirects` inside `site/` are honoured by Workers.

The first deployment gets a `session-recall.<account>.workers.dev` URL. Add the
custom domain under **Settings → Domains & Routes → Add custom domain**:
`070801.top` and, if wanted, `www.070801.top`. Workers creates the DNS record
and certificate automatically when the zone is on Cloudflare.

### Deploy from your machine

You do not have to click through the dashboard. After a one-time `npx wrangler login`:

```sh
bash scripts/deploy-site.sh
```

The script bumps the `?v=` asset version in both pages, runs
`scripts/check-site.sh`, and then runs `npx wrangler@4 deploy`. If the check or
deploy fails, it restores the HTML it changed. Flags:

```sh
bash scripts/deploy-site.sh --dry-run   # check + wrangler dry-run; no changes
bash scripts/deploy-site.sh --no-bump   # deploy without touching ?v=
```

After a successful local deploy, commit and push the bumped HTML. Otherwise the
next GitHub build will deploy the old `?v=` value and may serve cached assets.

---

## Deploy on Cloudflare Pages (alternative)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Authorize GitHub and pick **`odinyu/session-recall`**.
3. **Production branch:** `main`.
4. **Framework preset:** `None`.
5. **Build command:** leave *empty*.
6. **Build output directory:** `site`.
7. **Build watch paths** (Settings → Builds & deployments → Build watch paths): add `site/*`
   so doc-only or code-only commits do not trigger a rebuild.
8. Save and deploy. Every push to `main` redeploys; every PR gets a preview URL.

`_headers` and `_redirects` are read from the output directory automatically — there is
nothing to configure in the dashboard for them.

## Deploy by direct upload (no Git)

```sh
npx wrangler pages deploy site --project-name session-recall
```

Or drag the `site` folder onto the Pages **Direct Upload** screen. Direct uploads skip the
Git integration, so you must run the command again for every change.

## Custom domain + the `.top` nameservers

The domain **070801.top** is registered at a mainland-China registrar and its nameservers
were moved to Cloudflare on 2026-11-13. Cloudflare currently reports `tricia.ns.cloudflare.com`
and `lex.ns.cloudflare.com`. The steps below remain as the record of that migration and for
any future move.

1. **Leave the registrar's real-name verification alone.** It stays at the registrar
   and must remain complete — the domain can be suspended without it. Moving nameservers does
   not move or waive it.
2. **Note the current nameservers** at the registrar, so the change can be reverted if needed.
3. In Cloudflare: **Add a site** → enter the `.top` domain → choose the **Free** plan →
   Cloudflare shows two assigned nameservers (e.g. `xxx.ns.cloudflare.com`).
4. At the registrar, replace the existing nameserver records with those two. Remove the old
   ones rather than adding alongside them.
5. **Wait for propagation — up to 24 hours** (occasionally longer). Cloudflare emails you when
   the zone becomes active. Until then the zone is pending and nothing resolves through it.
6. In Pages → the project → **Custom domains** → **Set up a custom domain** → enter
   **`070801.top`** (and `www` if you want it). Because DNS is already on Cloudflare, the record is created
   automatically.
7. **SSL/TLS mode: Full (strict).** Cloudflare issues the edge certificate on its own.
8. **Do not enable the Cloudflare China Network.** It requires an ICP filing and an
   enterprise agreement. Overseas hosting needs no ICP, which is why this site stays on the
   standard global network.

DNS is usually fast; the 24-hour figure is the registrar's own propagation window, not
Cloudflare's.

---

## Launch checklist

### 1. Confirm the production domain

The absolute base is **`https://070801.top`**. It appears in `<link rel="canonical">`, the
`hreflang` alternates, `og:url`, `og:image`, `twitter:image` and the JSON-LD `url` in both
pages, plus `robots.txt` and `sitemap.xml`. Confirm there is no leftover staging hostname:

```sh
grep -rn "session-recall.pages.dev" site/ || echo "no placeholder domain left"
grep -rn "070801.top" site/ | wc -l
```

### 2. Bump the visible version on each release

Download links are version-less, so a new release needs no URL edit:

```
https://github.com/odinyu/session-recall/releases/latest/download/session-recall_macos-arm64.zip
https://github.com/odinyu/session-recall/releases/latest/download/session-recall_macos-intel.zip
```

The release workflow copies each versioned asset to those stable names and writes a matching
`.sha256` beside it, so the `/releases/latest/download/…` links keep working. Every release
must carry those aliases: with `fail_on_unmatched_files: true`, a missing alias fails the
release instead of leaving the site pointing at a 404.

The only per-release edit is the visible version, in three places per page: the hero meta line
(`v1.5.0 · macOS 11+ · 26.8 MB · MIT`), the footer, and the FAQ answer that quotes the build
sizes. Find them with:

```sh
grep -rn "1\.5\.0" site/index.html site/zh/index.html
```

### 3. Re-run the self-check

```sh
bash scripts/check-site.sh
```

It serves `site/` on a local port and fails if a reference 404s, if any subresource points at
an external host, if an in-page anchor has no target, or if an undocumented `TODO` is left
behind.

---

## Rebuilding the image derivatives

The screenshots in `assets/screenshots/` are generated from the PNGs in `docs/screenshots/`
at 1440 px and 720 px wide, WebP quality 0.84. `docs/screenshots/` is the source of truth
and is never modified.

Two scripts do the work: `scripts/capture-screenshots.sh` photographs the app against a
throwaway fixture index, and `scripts/webp-encode.sh` turns those PNGs into the WebP files
this site loads. The encoder is `scripts/webp-encode.html`, driven over the DevTools
protocol by `scripts/webp-encode-cdp.ts`, because `sips` cannot write WebP on this machine
and `ffmpeg` has no libwebp — the browser's own encoder is the reliable one here.

**Light set** (the default; also the source of the existing files):

```sh
bash scripts/capture-screenshots.sh --theme light
bash scripts/webp-encode.sh --src docs/screenshots/en --out site/assets/screenshots/en
bash scripts/webp-encode.sh --src docs/screenshots/zh --out site/assets/screenshots/zh
```

**Dark set.** The dark run captures into `docs/screenshots/<lang>-dark/`, so the light
originals are never overwritten; the `-dark` suffix keeps the two families of output names
apart:

```sh
bash scripts/capture-screenshots.sh --theme dark
bash scripts/webp-encode.sh --src docs/screenshots/en-dark --out site/assets/screenshots/en --suffix -dark
bash scripts/webp-encode.sh --src docs/screenshots/zh-dark --out site/assets/screenshots/zh --suffix -dark
```

Output names are `<view>-<width>.webp` and `<view>-dark-<width>.webp`:

| Light | Dark |
| --- | --- |
| `search-results-1440.webp` | `search-results-dark-1440.webp` |
| `search-results-720.webp` | `search-results-dark-720.webp` |
| `session-detail-1440.webp` | `session-detail-dark-1440.webp` |
| `session-detail-720.webp` | `session-detail-dark-720.webp` |
| `process-search-1440.webp` | `process-search-dark-1440.webp` |
| `process-search-720.webp` | `process-search-dark-720.webp` |

A file over 120 KiB is re-encoded a little lower in quality; the encoder prints the quality
it settled on for that shot, and fails the run rather than writing something oversized.
Everything else stays at 0.84.

**Every screenshot URL must carry the page's `?v=` version.** `site/_headers` serves images
with `max-age=86400`, so a browser keeps the bytes it cached for a day — and re-encoding a
screenshot under the same URL leaves every visitor on the old image. The pages therefore
request `/assets/screenshots/.../<view>-<width>.webp?v=N` (both the `src` and every
candidate in the `srcset`), where `N` is the same number as the `?v=` on `site.css`,
`site.js` and `theme-init.js`. **Bump that number whenever the image bytes change**, even
though the file names stay the same — it is the only thing that invalidates a cached
screenshot. `scripts/deploy-site.sh` bumps the `?v=` in both pages before deploying.

`og.png` is the 1200×630 social card. Its source is checked in as **`assets/og.html`** —
edit the copy there and re-render; nothing else generates this image:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars \
  --window-size=1200,630 --force-device-scale-factor=1 \
  --screenshot=site/assets/og.png \
  "file://$PWD/site/assets/og.html"
```

The window size and the device scale factor are both pinned, because the card must stay
exactly 1200×630. Its colours are the dark-theme tokens from `assets/site.css` (bg `#141715`,
ink `#e6eae3`, muted `#a2aaa0`, accent `#7cc4a7`); keep them in step if the palette changes.

The card is referenced by absolute URL from `og:image` / `twitter:image`, so its file name
never changes and it carries no cache-busting query — social scrapers do not send one.

## Cloudflare Pages limits, and why the zips are not in here

| Limit (Workers static assets / Pages free) | Value |
| --- | --- |
| Max file size | **25 MiB** |
| Max files per deployment | 20,000 |
| Builds per month (Pages Free) | 500 |

The release zips are **26.8 MB** (Apple silicon) and **29.5 MB** (Intel) — both above the
25 MiB per-file ceiling, so a deployment containing them would be rejected. They stay on
GitHub Releases and the page links out to them.

## Notes

- No framework, no bundler, no npm dependency, and **no external requests**: no web fonts, no
  CDN, no analytics, no cookie banner. The style is system fonts (`-apple-system` / SF Mono)
  and local files only, and `Content-Security-Policy: default-src 'none'` in `_headers`
  enforces it.
- Light and dark themes follow `prefers-color-scheme`.
- Because this file lives in `site/`, it is published at `/README.md`. That is harmless but
  not intended for visitors; delete it from the deploy if you would rather it were private.
- `assets/site.css`, `assets/site.js` and `assets/theme-init.js` are cached for a day,
  so their URLs carry a `?v=N` query. Bump the number in both pages whenever any of
  them changes.
