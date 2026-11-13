# Flowplan Marketplace

**Deutsch, kurz:** Der Flowplan Marketplace (marketplace.flowplan.org) ist der Ort, an dem Flowplan-Nutzer:innen Vorlagen teilen: Dokument- und Datenbankvorlagen, Workflows, Whiteboard-Vorlagen, Erscheinungsbilder und automatische Links. Stöbern und Importieren geht ohne Konto; zum Einreichen meldet man sich mit GitHub oder einem E-Mail-Link an. Jede Einreichung wird automatisch geprüft und dann im Bereich „Marketplace“ von flowplan-admin von Hand freigegeben. Vorlagen gehen direkt im Browser in die eigene Flowplan-Instanz – der Marketplace erfährt nie, welche Instanz das ist.

---

## What it is

A Next.js 16 app (App Router, TypeScript strict) with one SQLite database (`node:sqlite`) and its files in one data directory.

- **Browse** (`/`, `/t/<slug>`, `/u/<author>`): featured, newest, popular, categories, search; template pages with previews, description (German or English by the visitor's language), author, licence, version history, download counts, *In Flowplan öffnen*, *Herunterladen*, *Melden*.
- **Submit** (`/submit`, `/me`): upload a `.flowplan-template` file or receive it from a Flowplan instance; automatic checks; licence (CC BY 4.0 by default, CC0, MIT) and rights confirmation; status per version with the review team's message (changes requested, rejected, unpublished with reason – the only channel for GitHub-only accounts), edit, new version, withdraw; *Konto löschen* / *Delete account* (see [Accounts and retention](#accounts-and-retention)).
- **Review** happens in flowplan-admin through the [admin API](#admin-api).
- Languages: German and English (browser language; *DE / EN* switch in the header and in the footer, both `/lang/de|en?next=<path>`, which only sets the language cookie).
- Privacy: no trackers, no visitor cookies (only the language choice when a visitor picks one), IP addresses only as a daily HMAC for rate limits, only anonymous download/open counters.

### Package format (`flowplan-marketplace-1`)

A `*.flowplan-template` file is a ZIP:

```
template.json            format, kind, title, titles{de?,en}, summary{de,en}, description{de,en}?,
                         category, tags[≤10], minVersion, language, payload
payload/…                the kind's own exchange format, unchanged
                         document/database: flowplan-template-1 ZIP · workflow: flowplan.workflow JSON
                         (+ optional payload/workflow-meta.json for the viewer, see below)
                         whiteboard, appearance (+ fonts), link-rules: JSON
preview/1.webp … 4       optional, ≤ 1 MB each, WebP/PNG/JPEG
```

`title` is the template's title in its own language; `titles {de?, en?}` (each ≤ 120 characters) is the title per interface language – cards, template pages, search and sorting by title use the visitor's (else the other one, else `title`). Readers that don't know `titles` keep using `title`. Limits: 25 MB per package, 64 KB for `template.json`. Downloads carry `template.json` with the reviewed metadata plus `license`, `author {name, handle}` and `marketplace {id, slug, version, url}`.

**The English title is required for everything an author submits** (new template, new version, a new package for a waiting submission): `titles.en` must be in the package (Flowplan's publish dialog asks for it – *Titel (Englisch)*, the German one optional) and `titleEn` in the submit form. A package without it – from a Flowplan before this rule, or made by hand – gets the error finding `title-en-missing` (at `titles.en`: *update Flowplan and publish from there again*) already in `POST /api/packages/inspect`, so the submit page shows it right after the hand-over or upload, and `POST /api/submissions` answers `422 package_invalid` with it; a form without `titleEn` answers `400 invalid_form` with `fields: ["titleEn"]`. For submissions the marketplace sets `title` itself: the German title for German content (`language: "de"`) when there is one, else the English one. The package check as such (official seed, an admin's package replacement, stored templates) still accepts packages without `titles`: published templates from before the rule keep their one title in both languages, nothing is guessed.

### Automatic checks

Every package is checked on upload and the findings (error / warning / info) are stored for the author and the review: envelope schema and sizes; ZIP guards (entry count, per-entry and total size, compression ratio, real inflated size, no `..`, absolute paths, backslashes, symlinks, encrypted or duplicate entries – also for the nested template ZIP); previews identified by their bytes; kind sanity (document/database: `flowplan-template-1` with matching kind and SHA-256 of every attachment; workflow: graph present, node types, external hosts of HTTP steps, AI and e-mail steps, webhook triggers, strings that look like credentials; link rules: patterns compile, targets are http(s); appearance: accent colour, font files are fonts). Descriptions are Markdown without HTML: HTML is removed and links are limited to http(s)/mailto.

### Security scan

For the review, every version also gets a **security scan** (`lib/security-scan.ts`, kept in `lib/security-store.ts`): each finding has a severity – **block**, **warn** or **info** –, a code, the place (`entry#/json/path`, `payload/template.zip!files/<id>` inside the nested template) and an explanation in German and English. The **verdict** is `clean` (*unbedenklich*), `review` (*prüfen*: a warn finding) or `block` (*blockieren*: a block finding) with the counts per severity.

- **All kinds:** the archive read leniently entry by entry (unsafe paths, symlinks, duplicates, encrypted entries, zip bombs, entries over 10 MB / 25 MB, hidden and dot files, files outside `payload/` and `preview/`); what each file really is (executables by bytes or name, nested archives other than the payload's own, unexpected types for the kind, 1×1 tracking pixels); JSON that is not UTF-8; in every string: bidi overrides, zero-width characters and look-alike letters in the title, `javascript:`/`vbscript:`/`data:` addresses (also with entities or whitespace inside), URL shorteners, IP literals, private networks and localhost, known tracker hosts, credentials (AWS, GCP, Azure, Slack, Discord, Telegram, GitHub, GitLab, Stripe, OpenAI, Anthropic, SendGrid, private keys, JWTs, bearer tokens, `user:password@` in addresses, passwords and keys in query strings; placeholders like `{{…}}` are fine) and personal data (e-mail addresses, phone numbers, IBANs with a valid checksum – documentation domains are ignored). Values are reported masked.
- **Documents and databases:** HTML in the content (`<script>`, `on…=` handlers, `<meta http-equiv>`, `<base>`, `srcdoc`, active inline styles: block; `<iframe>`, `<object>`, `<style>`, forms: warn – Flowplan's sanitizer removes them, the scan reports them anyway), embeds and their hosts, pictures from the net (load when the page opens), formulas calling network functions (Flowplan has none), attachments by their bytes (declared type vs. content, executables, Office files with macros – `vbaProject.bin`, `.docm`/`.xlsm` … –, legacy OLE files, SVG with scripts, `foreignObject`, handlers, entities or external references, PDF with JavaScript, `/Launch`, embedded files, `SubmitForm`).
- **Workflows:** node types Flowplan doesn't know (block), HTTP steps (hosts and methods as info; private, loopback, metadata and IP-literal targets, credentials in the address and fixed values in `Authorization`-like headers: block; `http://` and variable targets: warn), e-mail steps to fixed outside addresses, webhooks (and token instead of signature), mail triggers accepting any sender, AI steps with prompt-injection or exfiltration phrases, schedules Flowplan can't run, loops above Flowplan's limit, cycles in the graph, steps that delete or change permissions.
- **Whiteboards:** pictures from the net, embeds and links with their hosts.
- **Appearance:** the theme only with Flowplan's fields (`accent` as `#rrggbb`, `background`, `fonts.ui|display|mono`), nothing that looks like CSS or markup; fonts by magic bytes, size (5 MB), the table directory (count, tags, every table inside the file; WOFF ratios), `fvar` (variable), SVG glyphs with scripts.
- **Link rules:** a ReDoS heuristic (nested quantifiers, overlapping alternatives, adjacent quantifiers), a timed run against adversarial input in a worker thread that is terminated after 250 ms, catch-alls (empty matches, patterns that match most ordinary words), targets: https (http: warn, `javascript:`/`data:`/`file:`: block), IP or private hosts.

The scan runs when a version's detail or the queue is read and nothing (or an older scan) is stored, on every start for pending and published versions whose scan is from an older `SCANNER_VERSION`, and on `POST /api/admin/submissions/:id/rescan` (*Erneut prüfen*). A changed package (another SHA-256) is scanned again. **Block** keeps a version from being published: `POST …/decision {decision: "publish"}` answers `409 security_blocked` unless it carries `securityOverride` – the reviewer's reason (at least 10 characters), stored for exactly this package and written to the audit log (`security_override`, with the blocking codes). Requesting changes and rejecting always work. A package an admin replaces (`POST …/package`, see [Editing as admin](#editing-as-admin)) is scanned the same way: the answer (also of `?dryRun=1`) carries `security`; replacing the package of a **published** template publishes it at once, so a block verdict there needs the form field `securityOverride` too (`409 security_blocked` otherwise), recorded for the new version.

### Workflow viewer

Workflow templates get a read-only viewer on their page and in the submit preview: the diagram at the graph's own node positions (server-rendered SVG, pan by dragging or the arrow keys, zoom with the buttons, Ctrl/⌘ + wheel, pinch or + and −, *Einpassen* fits everything), a node's settings in a side panel (a bottom sheet on phones) after a click or Enter, risk markings with colour, symbol and word (HTTP steps with their host as text, AI and e-mail steps; derived from the node types – the meta can only add a marking), a legend, *Was er macht* – a summary generated from the graph (trigger, then the steps in order with their branches) in the visitor's language – and *Nach dem Import legst du fest* with the workflow's gaps.

Flowplan adds `payload/workflow-meta.json` to every workflow package it builds (the workflow itself is unchanged):

```
{ "format": "flowplan.workflow-meta", "version": 1,
  "nodes": { "<node type>": { "name": {de, en}, "description": {de, en}, "group": "trigger|logic|records|pages|notify|ai|http",
                              "icon": "<SVG path data, viewBox 0 0 256 256, filled>", "ports": {"<port>": {de, en}}?,
                              "external": true?, "ai": true?, "email": true? } },
  "gaps": [ { "id", "label": {de, en}, "kind", "optional": true? } ] }
```

`nodes` holds exactly the node types the graph uses. A gap is a gallery workflow's `$ask:<id>` token or the id of a reference (database, page, person …) of a published workflow. Everything is checked like the rest of the package (`lib/workflow-meta.ts`): texts are length-limited, unknown fields are dropped, an `icon` that is not plain path data is dropped (finding `workflow-meta-icon`), a broken file gives the finding `workflow-meta-invalid`. Without the file (older packages) the viewer shows the raw node types with a generic symbol. Nothing from a package is rendered as HTML, nothing is fetched or linked, large graphs are cut at 100 nodes with a note, settings at 40 rows per node. Code: `lib/workflow-view.ts` (model and summary), `lib/workflow-svg.ts` (SVG), `lib/workflow-viewer.ts` (from a package), `components/workflow-viewer.tsx`.

### Statuses

`submitted → in_review → published | changes_requested | rejected`; `changes_requested → submitted` (author revises); `published → unpublished → published` (admin); `withdrawn` (author). Opening a submission in the admin API starts its review. A new version of a published template is a new submission; the published one stays until the new one is accepted.

## Official templates

Flowplan's built-in templates (documents and databases, whiteboards, workflows) are in the marketplace from the first start, by the built-in author **Flowplan** (`/u/flowplan`, badge *Offiziell* / *Official* on cards, template pages and the author page, filter *Nur offizielle* / *Official only* on the browse page). That author has no e-mail address and no GitHub account and can't sign in; nobody else can get the handle `flowplan`.

How they get there:

1. In the Flowplan repository: `npm run marketplace-official -- ../flowplan-marketplace/seed/official` writes one `<slug>.flowplan-template` per built-in template.
2. Commit `seed/official/` here.
3. The image rebuild (`.github/workflows/docker.yml`) ships the folder as `/app/seed/official`; the next start publishes what is new or changed (`lib/official.ts`, called from `instrumentation.ts`). By hand: `npm run seed-official [-- <folder>]` (uses `MARKETPLACE_DATA_DIR`).

Per file – the file name without `.flowplan-template` is the template's stable key and, if free, its slug:

- **new** → a new template, published at once;
- **changed** (SHA-256 of the file) → a new version, published at once (no review);
- **unchanged** → nothing;
- **unpublished by an admin** → left alone, also when the file changes (republish it in flowplan-admin to get updates again);
- **fails the normal package checks**, or the kind changed → skipped with a warning in the log; the other files and the start go on;
- **removed from the folder** → the template stays as it is (unpublish it in flowplan-admin).

Metadata an admin edited in flowplan-admin is kept across these updates ([Editing as admin](#editing-as-admin)). The metadata comes from `template.json`; two optional fields there: `license` (default `CC0-1.0`) and `changelog`. Every change is in the audit log with actor `seed` (`official_created`, `official_updated`; `official_skipped` and `official_invalid` once per file content). Demo mode (`npm run demo`) loads the folder too.

## Browser hand-overs

**Flowplan → Marketplace** (*Im Marketplace veröffentlichen…*): the instance opens `/submit?handover=1`; the page posts `{type: "flowplan-marketplace-ready"}` to `window.opener` (target `*`) and accepts `{type: "flowplan-marketplace-package", name, bytes: ArrayBuffer}` only when `event.source === window.opener`. The package is checked, the form prefilled, and kept in IndexedDB while the author signs in.

**Marketplace → Flowplan** (*In Flowplan öffnen*): before an instance is saved, the box offers the hosted Flowplan as one button (*In app.flowplan.org öffnen*, `MARKETPLACE_DEFAULT_INSTANCE`) with *Eigene Instanz verwenden …* below; a click stores it, so the next visit shows the compact *In <host> öffnen* with *Instanz ändern*. The visitor's own address is entered once (localStorage; https, http only for localhost/private networks with a warning). A Flowplan instance that links to the marketplace appends `#from=<url-encoded origin>`; on any page that origin (same rules) becomes the saved instance, the fragment is removed from the address bar (`history.replaceState`, query and other fragment parts stay) and a one-time notice *Instanz übernommen: <host> · ändern* appears when it changed. The fragment never reaches the server. The page opens `<instance>/#marketplace-import`, waits for `{type: "flowplan-instance-ready", version}` from exactly that window and origin, warns if the version is older than the template's `minVersion`, and posts `{type: "flowplan-marketplace-template", id, version, bytes, sha256, slug, title, kind, author, license, url}` with target origin = the instance's origin. The instance never contacts the marketplace.

The marketplace sends no `Cross-Origin-Opener-Policy` header on purpose: both hand-overs need `window.opener` across origins.

## Public API

CORS `*` for GET. Published templates only.

| | |
|---|---|
| `GET /api/templates?kind=&category=&q=&lang=&sort=newest\|popular\|updated\|title\|featured&limit=&offset=&author=&official=1` | list (`{templates, total}`); each template has `official: true\|false` and `titles: {de, en}` (the title per interface language, `title` where the package has none; `title` itself stays the template's own and `sort=title` sorts by it) |
| `GET /api/templates/:slug` | detail with description, versions, analysis |
| `GET /api/templates/:slug/download[?version=N]` | the package (`X-Template-Sha256`, `X-Template-Version`); counts a download for a person's click (`?via=open` an opening from the template page), once per visitor, version and day – crawlers, link previews and scripts (by user agent and Fetch Metadata) don't count (`lib/download-count.ts`); `/robots.txt` keeps crawlers out of `/api/` |
| `GET /api/templates/:slug/previews/:n[?version=N]` | preview image |

## Admin API

For flowplan-admin. `Authorization: Bearer $MARKETPLACE_ADMIN_TOKEN`; optional `X-Admin-User: <name>` is written to the audit log next to the token's label. Repeated wrong tokens are rate-limited per client. Every change is audited.

| | |
|---|---|
| `GET /api/admin/submissions?status=a,b\|all` | queue (default: submitted, in_review, changes_requested) with findings, author, sizes |
| `GET /api/admin/submissions/:id` | detail: template.json, findings, previews (URLs), diff to the published version, author's history, for workflows `workflow` (below), `security` (below); starts the review |
| `GET /api/admin/submissions/:id/package` | the package |
| `GET /api/admin/submissions/:id/previews/:n` | a preview image |
| `POST /api/admin/submissions/:id/decision` | `{decision: "publish"\|"request_changes"\|"reject", message, securityOverride?}` – e-mails the author; publishing a `block` verdict needs `securityOverride` (a reason, audited), else `409 security_blocked` |
| `POST /api/admin/submissions/:id/rescan` | runs the [security scan](#security-scan) again (audited as `security_rescan`), answers `{security}` |
| `GET /api/admin/templates?state=listed\|unpublished\|withdrawn\|all` | templates with a published version |
| `POST /api/admin/templates/:id/unpublish` `{reason}` · `POST …/republish` | id or slug; e-mails the author (the reason on unpublish, a short note on republish) if an address is known – `notified` in the answer |
| `POST /api/admin/users/:id/delete` `{reason}` | id or handle; deletes the account like *Konto löschen* (below) on the author's request, `reason` required, audited as `account_deleted`; answers `{deleted, notified, templates, published, versions, reports}`. The built-in author Flowplan: `403 system_account` |
| `GET /api/admin/reports?status=open\|resolved\|all` · `POST /api/admin/reports/:id/resolve` `{resolution}` | reports |
| `GET /api/admin/stats` | counts per status, templates, downloads, opens, open reports |
| `GET /api/admin/featured` · `POST /api/admin/featured` `{templates: [id or slug, …]}` | featured (≤ 12, in order) |
| `GET /api/admin/audit?limit=` | the audit log |
| `PATCH /api/admin/templates/:id` · `PATCH /api/admin/submissions/:id` | edit the metadata of a published template (id or slug; its published version) or of a submission in review (`submitted`, `in_review`, `changes_requested`) – see [Editing as admin](#editing-as-admin) |
| `POST …/previews` (multipart, files in `preview`) · `DELETE …/previews/:n` · `POST …/previews/order` `{order: [n, …]}` | add, remove, reorder the previews (on `templates/:id` or `submissions/:id`) |
| `POST …/package` (multipart `package`, optional `changelog`; `?dryRun=1` only checks) | replace the package (on `templates/:id` or `submissions/:id`) |

For a workflow submission the detail has `workflow: {summary: {de, en}, viewer: {de, en}}` (`null` for other kinds): `summary` is *Was er macht* as plain text (one line for the trigger, then `1. …` per step); `viewer.<lang>` is what the template page shows – `svg` (the diagram as markup: only `svg, defs, marker, g, rect, path, text, title`, every text escaped, no styles, scripts or links; it is styled by the class names `wf-…`, see `app/globals.css`), `bounds {x, y, w, h}`, `nodes` (id, type, label, name, description, group, icon path, position, host, risks, ports, `settings` – read-only rows, see `SettingValue` in `lib/workflow-view.ts` – and the step number), `edges`, `loops`, `summary {lead, steps, notes}`, `gaps` (labels), `shown`/`total` and `risks {ai, email, external, hosts}`.

Every submission in the queue carries `security: {verdict, label {de, en}, counts {block, warn, info}, scannedAt, scannerVersion, overridden}` (`null` until the first scan, which then runs in the background); the detail carries the full scan: `security: {verdict, label, counts, findings: [{severity, code, at, de, en, count?}], scannedAt, scannerVersion, sha256, kind, override: {reason, by, at} | null}`.

### Editing as admin

`lib/admin-edit.ts`. Two scopes, the same endpoints: **`templates/:id`** edits the template's published version (listed or unpublished; a withdrawn one answers `409 withdrawn`), **`submissions/:id`** a version waiting for review (other states: `409 not_in_review`).

`PATCH` takes JSON with any of `title`, `titles: {de?, en?}` (a changed `title` without `titles` becomes the English title and empties the German one, so the new title shows in both languages; an English title, once there, can be changed but not removed – `400 invalid_form` with `fields: ["titles.en"]`), `summary: {de?, en?}`, `description: {de?, en?}` (Markdown, shown as before), `category`, `tags`, `language`, `minVersion`, `slug`, plus `notify` (boolean), `message` (to the author, ≤ 2000) and `also` (`["previews", "package"]`: changes made through the other endpoints, named in the same e-mail). Validation is the submit form's (`400 invalid_form` with `fields`); `license` is the author's choice (`400 license_readonly`), other keys `400 unknown_field`, nothing changed `400 no_changes`. The answer: `{ok, scope, templateId, versionId, slug, number, status, sha256, size, findings, official, adminOverrides, changed, notified}`.

- **In place, no new version.** Metadata and previews change the version itself: its number and status stay, the package is rebuilt – the payload entries are copied unchanged, `template.json` and `preview/*` are new – and checked again like a submission (`422 package_invalid` with `findings` if not); SHA-256, size and findings are recomputed (`X-Template-Sha256` of the download matches). This is simpler and more robust than a new version for what is only metadata: no second review, no pending-version conflicts, the version history and download counts stay as they are. Preview URLs carry `&r=<hash>` so cached images are replaced.
- **Recorded on the version** as `adminEdits` (`{at, by, fields, message, notify, notified}`, in the submission detail) and in the audit log: `admin_edit` with `fields` and `changes` (before/after for every field, only the lengths for descriptions), `admin_previews_added`, `admin_previews_reordered`, `admin_preview_removed`, `admin_package_replaced` – actor as everywhere (token label + `X-Admin-User`).
- **Slug:** `a-z`, `0-9`, `-`, at most 60 characters, unique (`409 slug_taken`, also for an old address that still redirects to another template). The old address keeps working: `/t/<old>` and `/api/templates/<old>[/download|/previews/:n]` answer `308` to the new one (table `slug_redirects`; renaming back removes it; account deletion removes them). Only the edited version's `template.json` gets the new slug and URL; `marketplace.id` is the stable key.
- **Previews:** at most 4, each at most 1 MB, WebP, PNG or JPEG by their bytes (`413 preview_too_large`, `415 preview_type`, `409 preview_limit`); stored by their real type and numbered 1… in order.
- **Package:** the normal checks (`422 package_invalid` with `findings`, `409 kind_mismatch`); `?dryRun=1` (or a form field `dryRun=1`) returns `{dryRun, ok, kind, kindMatches, findings, analysis, size, sha256, previews}` and stores nothing. The new package's payload replaces the old one, its previews too if it brings any (else the current ones stay); the metadata stays as stored. On a submission the version is replaced in place; on a published template it becomes a **new published version** at once, marked as by admin (`adminEdits` `["package"]`, `changelog` from the form or "Paket vom Prüfteam ersetzt"), refused while another version waits (`409 pending_version` – edit that submission) or while the template is unpublished (`409 not_listed`).
- **Author notification:** `notify` defaults to `true` for `templates/:id` and `false` for `submissions/:id` (a decision e-mail follows). The e-mail: *Ein Admin hat deine Vorlage „…“ angepasst: <Felder>* with the message. Accounts without an address (GitHub only) see the same on `/me` under the version; so does everybody. The preview and package endpoints never e-mail – name them in `also` of the closing `PATCH`. The built-in author Flowplan gets nothing.
- **Official templates** can be edited too. The changed metadata fields (and `previews`) are kept in `templates.admin_overrides` (`adminOverrides` in the answers and in `GET /api/admin/templates`): a changed seed file still brings a new version with its payload, but with the admin's values for those fields and the current previews; fields the admin didn't touch follow the file. A replaced package lasts until the seed file changes.
- Rate limit: 300 edits per hour.

Official templates (see [Official templates](#official-templates)) carry `official: true` in `GET /api/admin/templates` and in submissions, and their `author` has `official: true` (everybody else: `false`). They can be unpublished, republished and featured like any other template; an unpublished one is not published again by the next start.

## Accounts and retention

**Deleting an account** – by the author on `/me` (*Konto löschen*: a plain form POST to `/api/me/delete` with the session's CSRF token and the handle typed again; the session is checked again) or by the maintainer through `POST /api/admin/users/:id/delete`. It removes, in one transaction: the user row (name, e-mail address, GitHub link), sessions, sign-in links, the account's rate-limit keys, every template of the account with all versions (published ones disappear at once), their download/open counters and the reports about them (deleted with the template – nothing left to act on). After the commit the package and preview files of every version are deleted from the data volume. The audit log keeps its entries, but in entries about the account, its templates and versions the author's name, handle and address are replaced by `gelöschtes Konto` (the address in every entry); the deletion itself is logged as `account_deleted` with counts only. If the account has an e-mail address, a confirmation goes there right after the deletion; the address is not kept anywhere. The built-in author Flowplan can't be deleted. Code: `lib/account.ts`.

**Retention** (`lib/cleanup.ts`, hourly – a timer started in `instrumentation.ts`, and also when a rate-limit window starts): expired sessions; sign-in links a day after they ran out (until then a late click says "expired"); rate-limit windows older than two days. Everything else stays until the author withdraws or deletes it.

## Environment

| Variable | |
|---|---|
| `MARKETPLACE_URL` | public address, e.g. `https://marketplace.flowplan.org` (links, GitHub callback, `Secure` cookies) |
| `MARKETPLACE_DATA_DIR` | data directory (default `./data`; `/app/data` in the image) |
| `MARKETPLACE_OFFICIAL_DIR` | folder with the [official templates](#official-templates) (default `./seed/official`; `/app/seed/official` in the image) |
| `MARKETPLACE_ADMIN_TOKEN` | admin API token, the same value as in flowplan-admin; unset = admin API off |
| `MARKETPLACE_ADMIN_TOKEN_LABEL` | name of the token in the audit log (default `flowplan-admin`) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in; unset = hidden |
| `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_SECURE` (`true` for 465) | e-mail sign-in links and notifications (decisions, unpublish, admin edits, account deletion); unset = e-mail sign-in hidden |
| `MARKETPLACE_SECRET` | optional key for CSRF tokens and IP hashes; default: generated once as `secret.key` in the data directory |
| `MARKETPLACE_IMPRESSUM_URL` | Impressum (https, default `https://flowplan.org/impressum`); the footer links there and `/impressum` redirects there (308). For the default address visitors land on `/de/impressum` or `/en/impressum` of the website in their language; other addresses are used as given |
| `MARKETPLACE_PRIVACY_URL` | privacy policy (https, default `https://flowplan.org/datenschutz`), the same way via `/datenschutz` |
| `MARKETPLACE_DEFAULT_INSTANCE` | Flowplan instance the *In Flowplan öffnen* box preselects for visitors who haven't saved their own (https origin, default `https://app.flowplan.org`); empty or `off`: no preselection, the box asks for the address |
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
5. Legal texts: Impressum and privacy policy are those of flowplan.org (`MARKETPLACE_IMPRESSUM_URL`, `MARKETPLACE_PRIVACY_URL`; the defaults fit marketplace.flowplan.org). The Nutzungsbedingungen at `/nutzungsbedingungen` are part of the code (`content/legal/nutzungsbedingungen.de.md`, `.en.md`); nothing to set up.

`docker-compose.yml` is an example for other hosts.

### GitHub OAuth app

GitHub → Settings → Developer settings → OAuth Apps → *New OAuth App*:

- Application name: `Flowplan Marketplace`
- Homepage URL: `https://marketplace.flowplan.org`
- Authorization callback URL: `https://marketplace.flowplan.org/api/auth/github/callback`

Then *Generate a new client secret* and set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. No scopes are requested (public profile only).

### SMTP

Any SMTP account that may send as `SMTP_FROM` (e.g. `marketplace@flowplan.org`; SPF/DKIM for the domain). Port 587 with STARTTLS, or 465 with `SMTP_SECURE=true`. Used for sign-in links (valid 15 minutes, once; the link opens a confirm page so mail scanners don't use it up), review decisions, unpublish/republish notes, admin edits and the account deletion confirmation. GitHub-only accounts get none of these; `/me` shows every decision with its message.

### Admin token (flowplan-admin)

Generate once (`openssl rand -hex 32`) and set the same value as `MARKETPLACE_ADMIN_TOKEN` here and in flowplan-admin (together with `MARKETPLACE_URL=https://marketplace.flowplan.org` there).

### Backups

Everything lives in the data volume: `marketplace.db` (+ `-wal`), `packages/`, `previews/`, `secret.key`. Back up the whole volume (Coolify's volume backup or a file copy). For a consistent copy of the database while it runs: `sqlite3 /app/data/marketplace.db ".backup /backup/marketplace.db"` (or stop the container briefly). Restoring = putting the files back into the volume.

## Security notes

Strict Content Security Policy with a per-request nonce (`proxy.ts`): no inline scripts or event handlers, no framing, `form-action 'self'`, `base-uri 'none'`. Sessions are random tokens in an `httpOnly`, `SameSite=Lax` cookie (`Secure` on https), stored hashed; signed-in writes check the origin and a CSRF token bound to the session. Rate limits: e-mail links (per address and per hashed IP), reports, package checks, submissions, failed admin tokens.

## License

AGPL-3.0, like Flowplan. Fonts: SIL Open Font License 1.1 (`public/fonts/LICENSE-*.txt`).
