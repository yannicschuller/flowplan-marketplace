<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## This repository

- Domain logic lives in `lib/` and works on plain `Request`/`Response`; `app/api/**` only forwards to `lib/routes.ts` and `lib/admin.ts`. Keep it that way so `tests/` can call it without Next.js.
- The shared contract with the Flowplan server and flowplan-admin (package format, hand-over messages, admin API) is described in the README. Message shapes and API paths are a contract: change them only together with the other repositories.
- UI texts in German and English side by side: `t("Deutsch", "English")`, German informal "du". Code comments and commits in English.
- No inline scripts or style attributes (strict CSP in `proxy.ts`), no visitor cookies or tracking, never store IP addresses (use `ipKey()`).
- Checks: `npm run typecheck`, `npm test`, `npm run build`.
