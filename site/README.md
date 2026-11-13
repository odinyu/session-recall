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

1. **Leave the registrar's real-name verification (实名认证) alone.** It stays at the registrar
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
8. **Do not enable the Cloudflare China Network.** It requires an ICP filing (备案) and an
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

### 2. Refresh the versioned download URLs on each release

Every download link is a direct GitHub Releases URL with the version in the path, so a new
release means editing them by hand. Find them all with:

```sh
grep -rn "1\.3\.0" site/index.html site/zh/index.html
```

Per page the version appears in **three** places: the hero buttons, the final call to action,
and the JSON-LD `downloadUrl`. Also bump the visible version in the header/footer meta lines
(`v1.3.0 · macOS 11+ · 26.7 MB · MIT`) and in the FAQ answer that quotes the two build sizes.

```
https://github.com/odinyu/session-recall/releases/download/v1.3.0/session-recall_1.3.0_macos-arm64.zip
https://github.com/odinyu/session-recall/releases/download/v1.3.0/session-recall_1.3.0_macos-intel.zip
```

Each zip has a matching `.sha256` asset beside it on the release.

### 3. Re-run the self-check

```sh
bash scripts/check-site.sh
```

It serves `site/` on a local port and fails if a reference 404s, if any subresource points at
an external host, if an in-page anchor has no target, or if an undocumented `TODO` is left
behind.

---

## Rebuilding the image derivatives

The screenshots in `assets/screenshots/` were generated from the PNGs in `docs/screenshots/`
at 1440 px and 720 px wide, WebP quality 0.84, via headless Chrome (canvas `toDataURL`).
`docs/screenshots/` is the source of truth and is never modified.

On this machine `sips` cannot write WebP and `ffmpeg` has no libwebp, so Chrome is the encoder:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --allow-file-access-from-files \
  --virtual-time-budget=60000 --dump-dom "file:///path/to/encoder.html"
```

`og.png` is a 1200×630 headless-Chrome screenshot of a small HTML layout, rendered with
`--window-size=1200,630 --force-device-scale-factor=1`.

## Cloudflare Pages limits, and why the zips are not in here

| Limit (Workers static assets / Pages free) | Value |
| --- | --- |
| Max file size | **25 MiB** |
| Max files per deployment | 20,000 |
| Builds per month (Pages Free) | 500 |

The release zips are **26.7 MB** (Apple silicon) and **29.5 MB** (Intel) — both above the
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
- `assets/site.css` and `assets/site.js` are cached for a day, so their URLs carry a
  `?v=N` query. Bump the number in both pages whenever either file changes.
