# Flowplan Marketplace

**Deutsch, kurz:** Der Flowplan Marketplace (marketplace.flowplan.org) ist der Ort, an dem Flowplan-Nutzer:innen Vorlagen teilen: Dokument- und Datenbankvorlagen, Workflows, Whiteboard-Vorlagen, Erscheinungsbilder und automatische Links. Stöbern und Importieren geht ohne Konto; zum Einreichen meldet man sich mit GitHub oder einem E-Mail-Link an. Jede Einreichung wird automatisch geprüft und dann im Bereich „Marketplace“ von flowplan-admin von Hand freigegeben. Vorlagen gehen direkt im Browser in die eigene Flowplan-Instanz – der Marketplace erfährt nie, welche Instanz das ist.

---

## What it is

A Next.js 16 app (App Router, TypeScript strict) with one SQLite database (`node:sqlite`) and its files in one data directory.

- **Browse** (`/`, `/t/<slug>`, `/u/<author>`): featured, newest, popular, categories, search; template pages with previews, description (German or English by the visitor's language), author, licence, version history, download counts, *In Flowplan öffnen*, *Herunterladen*, *Melden*.
- **Submit** (`/submit`, `/me`): upload a `.flowplan-template` file or receive it from a Flowplan instance; automatic checks; licence (CC BY 4.0 by default, CC0, MIT) and rights confirmation; status per version, edit, new version, withdraw.
- **Review** happens in flowplan-admin through the [admin API](#admin-api).
- Languages: German and English (browser language; switch in the footer).
- Privacy: no trackers, no visitor cookies (only the language choice when a visitor picks one), IP addresses only as a daily HMAC for rate limits, only anonymous download/open counters.

### Package format (`flowplan-marketplace-1`)

A `*.flowplan-template` file is a ZIP:

```
template.json            format, kind, title, summary{de,en}, description{de,en}?, category,
                         tags[≤10], minVersion, language, payload
payload/…                the kind's own exchange format, unchanged
                         document/database: flowplan-template-1 ZIP · workflow: flowplan.workflow JSON
                         whiteboard, appearance (+ fonts), link-rules: JSON
preview/1.webp … 4       optional, ≤ 1 MB each, WebP/PNG/JPEG
```

Limits: 25 MB per package, 64 KB for `template.json`. Downloads carry `template.json` with the reviewed metadata plus `license`, `author {name, handle}` and `marketplace {id, slug, version, url}`.

### Automatic checks

Every package is checked on upload and the findings (error / warning / info) are stored for the author and the review: envelope schema and sizes; ZIP guards (entry count, per-entry and total size, compression ratio, real inflated size, no `..`, absolute paths, backslashes, symlinks, encrypted or duplicate entries – also for the nested template ZIP); previews identified by their bytes; kind sanity (document/database: `flowplan-template-1` with matching kind and SHA-256 of every attachment; workflow: graph present, node types, external hosts of HTTP steps, AI and e-mail steps, webhook triggers, strings that look like credentials; link rules: patterns compile, targets are http(s); appearance: accent colour, font files are fonts). Descriptions are Markdown without HTML: HTML is removed and links are limited to http(s)/mailto.

### Statuses

`submitted → in_review → published | changes_requested | rejected`; `changes_requested → submitted` (author revises); `published → unpublished → published` (admin); `withdrawn` (author). Opening a submission in the admin API starts its review. A new version of a published template is a new submission; the published one stays until the new one is accepted.

## Browser hand-overs

**Flowplan → Marketplace** (*Im Marketplace veröffentlichen…*): the instance opens `/submit?handover=1`; the page posts `{type: "flowplan-marketplace-ready"}` to `window.opener` (target `*`) and accepts `{type: "flowplan-marketplace-package", name, bytes: ArrayBuffer}` only when `event.source === window.opener`. The package is checked, the form prefilled, and kept in IndexedDB while the author signs in.

**Marketplace → Flowplan** (*In Flowplan öffnen*): the visitor enters their instance address once (localStorage; https, http only for localhost/private networks with a warning). The page opens `<instance>/#marketplace-import`, waits for `{type: "flowplan-instance-ready", version}` from exactly that window and origin, warns if the version is older than the template's `minVersion`, and posts `{type: "flowplan-marketplace-template", id, version, bytes, sha256, slug, title, kind, author, license, url}` with target origin = the instance's origin. The instance never contacts the marketplace.

The marketplace sends no `Cross-Origin-Opener-Policy` header on purpose: both hand-overs need `window.opener` across origins.

## Public API

CORS `*` for GET. Published templates only.

| | |
|---|---|
| `GET /api/templates?kind=&category=&q=&lang=&sort=newest\|popular\|updated\|title\|featured&limit=&offset=&author=` | list (`{templates, total}`) |
| `GET /api/templates/:slug` | detail with description, versions, analysis |
| `GET /api/templates/:slug/download[?version=N]` | the package (`X-Template-Sha256`, `X-Template-Version`) |
| `GET /api/templates/:slug/previews/:n[?version=N]` | preview image |

## Admin API

For flowplan-admin. `Authorization: Bearer $MARKETPLACE_ADMIN_TOKEN`; optional `X-Admin-User: <name>` is written to the audit log next to the token's label. Repeated wrong tokens are rate-limited per client. Every change is audited.

| | |
|---|---|
| `GET /api/admin/submissions?status=a,b\|all` | queue (default: submitted, in_review, changes_requested) with findings, author, sizes |
| `GET /api/admin/submissions/:id` | detail: template.json, findings, previews (URLs), diff to the published version, author's history; starts the review |
| `GET /api/admin/submissions/:id/package` | the package |
| `GET /api/admin/submissions/:id/previews/:n` | a preview image |
| `POST /api/admin/submissions/:id/decision` | `{decision: "publish"\|"request_changes"\|"reject", message}` – e-mails the author |
| `GET /api/admin/templates?state=listed\|unpublished\|withdrawn\|all` | templates with a published version |
| `POST /api/admin/templates/:id/unpublish` `{reason}` · `POST …/republish` | id or slug |
| `GET /api/admin/reports?status=open\|resolved\|all` · `POST /api/admin/reports/:id/resolve` `{resolution}` | reports |
| `GET /api/admin/stats` | counts per status, templates, downloads, opens, open reports |
| `GET /api/admin/featured` · `POST /api/admin/featured` `{templates: [id or slug, …]}` | featured (≤ 12, in order) |
| `GET /api/admin/audit?limit=` | the audit log |

## Environment

| Variable | |
|---|---|
| `MARKETPLACE_URL` | public address, e.g. `https://marketplace.flowplan.org` (links, GitHub callback, `Secure` cookies) |
| `MARKETPLACE_DATA_DIR` | data directory (default `./data`; `/app/data` in the image) |
| `MARKETPLACE_ADMIN_TOKEN` | admin API token, the same value as in flowplan-admin; unset = admin API off |
| `MARKETPLACE_ADMIN_TOKEN_LABEL` | name of the token in the audit log (default `flowplan-admin`) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in; unset = hidden |
| `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_SECURE` (`true` for 465) | e-mail sign-in links and review notifications; unset = e-mail sign-in hidden |
| `MARKETPLACE_SECRET` | optional key for CSRF tokens and IP hashes; default: generated once as `secret.key` in the data directory |
| `MARKETPLACE_LEGAL_DIR` | folder with `impressum.de.md`, `impressum.en.md`, `datenschutz.*.md`, `nutzungsbedingungen.*.md` (default `<data>/legal`; placeholders from `docs/legal` until then) |
| `MARKETPLACE_DEMO` | `1`: demo data and demo sign-in – never in production |

See `.env.example`.

## Development

```bash
npm ci
npm run demo              # http://localhost:3000 with 10 example templates, data in ./data-demo
npm run demo -- --fresh   # start over; --prod serves the last `npm run build`
npm run typecheck && npm test && npm run build
```

Demo mode: three authors, templates of every kind (eight published, one submitted, one with changes requested), one open report, a "Demo: sign in as the demo author" button and the admin token `demo-admin-token` (unless `MARKETPLACE_ADMIN_TOKEN` is set). Without SMTP the sign-in link is shown on the page.

```bash
curl -H 'Authorization: Bearer demo-admin-token' http://localhost:3000/api/admin/submissions
```

## Deploy (Docker / Coolify)

The image `ghcr.io/yannicschuller/flowplan-marketplace` is built by `.github/workflows/docker.yml` on every push to `main` and on demand (`:latest`, `:sha-…`; amd64 and arm64). It runs as `node`, listens on port 3000, has a healthcheck on `/api/health` and keeps everything in the volume `/app/data`.

1. **DNS:** `marketplace.flowplan.org` → the Coolify server (A/AAAA, or CNAME to the server's name).
2. **Coolify:** new resource → Docker image `ghcr.io/yannicschuller/flowplan-marketplace:latest` (or the Dockerfile build pack on this repository), domain `https://marketplace.flowplan.org`, port 3000, persistent storage mounted at `/app/data`, healthcheck path `/api/health`.
3. **Environment:** `MARKETPLACE_URL`, `MARKETPLACE_ADMIN_TOKEN`, GitHub and SMTP variables (below).
4. Optional automatic roll-out: repository secrets `COOLIFY_WEBHOOK` and `COOLIFY_TOKEN` (as in flowplan-website).
5. Legal texts: put `impressum.de.md`, `impressum.en.md`, `datenschutz.de.md`, `datenschutz.en.md`, `nutzungsbedingungen.de.md`, `nutzungsbedingungen.en.md` into `/app/data/legal/`.

`docker-compose.yml` is an example for other hosts.

### GitHub OAuth app

GitHub → Settings → Developer settings → OAuth Apps → *New OAuth App*:

- Application name: `Flowplan Marketplace`
- Homepage URL: `https://marketplace.flowplan.org`
- Authorization callback URL: `https://marketplace.flowplan.org/api/auth/github/callback`

Then *Generate a new client secret* and set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. No scopes are requested (public profile only).

### SMTP

Any SMTP account that may send as `SMTP_FROM` (e.g. `marketplace@flowplan.org`; SPF/DKIM for the domain). Port 587 with STARTTLS, or 465 with `SMTP_SECURE=true`. Used for sign-in links (valid 15 minutes, once; the link opens a confirm page so mail scanners don't use it up) and review decisions.

### Admin token (flowplan-admin)

Generate once (`openssl rand -hex 32`) and set the same value as `MARKETPLACE_ADMIN_TOKEN` here and in flowplan-admin (together with `MARKETPLACE_URL=https://marketplace.flowplan.org` there).

### Backups

Everything lives in the data volume: `marketplace.db` (+ `-wal`), `packages/`, `previews/`, `secret.key`, `legal/`. Back up the whole volume (Coolify's volume backup or a file copy). For a consistent copy of the database while it runs: `sqlite3 /app/data/marketplace.db ".backup /backup/marketplace.db"` (or stop the container briefly). Restoring = putting the files back into the volume.

## Security notes

Strict Content Security Policy with a per-request nonce (`proxy.ts`): no inline scripts or event handlers, no framing, `form-action 'self'`, `base-uri 'none'`. Sessions are random tokens in an `httpOnly`, `SameSite=Lax` cookie (`Secure` on https), stored hashed; signed-in writes check the origin and a CSRF token bound to the session. Rate limits: e-mail links (per address and per hashed IP), reports, package checks, submissions, failed admin tokens.

## License

AGPL-3.0, like Flowplan. Fonts: SIL Open Font License 1.1 (`public/fonts/LICENSE-*.txt`).
