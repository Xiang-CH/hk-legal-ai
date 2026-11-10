# Internal CLIC content dashboard

Route: `/clic-chat-hkulaw/internal/content`.

Staff unlock the page with the shared admin key, upload an Excel content list, and enter page numbers for Add, Update and Delete. Numbers use the EN sheet's column C (`2nd_id`), including both ends of ranges such as `2759–2973`. Other languages are outside this first version.

## Enable in an environment

1. Apply all pending migrations, including `20261111000000_content_admin_sessions`, through the normal Prisma migration deployment. Existing page, link and chunk tables must already exist.
2. Set `CLIC_CONTENT_ADMIN_TOKEN` to a random value of at least 24 characters in that environment. Share it with authorized staff through your normal secret-sharing channel. The key is sent only at login, then cleared from page memory. It is never saved in localStorage or the URL. Rotate the server variable to replace the shared key and invalidate existing sessions.
3. Configure `DATABASE_URL`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, and `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` as for the existing application. This index expects 3072-dimensional embeddings.

Every API request checks a server-side session and the current key version. The page itself contains no content data until it is unlocked. There is no public link from the chat navigation. Sharing the dashboard URL alone does not grant access. The target database is the environment's `DATABASE_URL`; use a separate preview database when staff must not affect production.

## Sessions and login protection

Successful login sets a random, opaque cookie for 7 days. It is HttpOnly, SameSite=Strict and Secure in production, scoped to the content API, and host-only. PostgreSQL stores only its SHA-256 hash, key version and expiry. Reloads and new tabs on the same hostname reuse the session. Different preview hostnames require separate login. **Lock dashboard** revokes the server session and expires the cookie; rotating the shared key also invalidates sessions. Mutating endpoints require a same-origin Origin header.

PostgreSQL atomically reserves at most 5 login attempts per 1-hour window across all instances and clients. Successful attempts also count; an attacker cannot reset the counter or bypass it by spoofing IP headers or submitting the key to content endpoints. Further attempts return HTTP 429 with Retry-After. The cooldown affects new logins for everyone sharing this database, so a deliberate attack can temporarily prevent sign-in. Existing authenticated sessions continue to work. The fixed window expires automatically. There is no in-memory limiter and no additional KV service. Database errors fail closed.

## Staff workflow

- Upload an `.xlsx` file, up to 12 MB. It is read in the browser; only selected rows and reference mappings are sent to the server. A selected batch and its before/after preview must fit the hosting response limits. The UI asks for a smaller batch when needed.
- Enter up to 500 page IDs across the three actions. Missing/duplicate IDs, overlapping actions, invalid English URLs and empty article bodies are rejected. Add requires an absent nid; Update requires an existing page.
- Deletion rows may omit nid. Exact URL lookup resolves them; already-absent pages show a no-op. Multiple requested delete numbers can map to the same physical page. Review shows requested entries, while the database removes that record only once.
- A workbook deletion mark or strikethrough is shown as a warning if staff explicitly select Add or Update. The selected action takes precedence; body and URL validation still apply.
- Review totals, the change bar, action filters and per-article code diffs. Open **Compare changes** for red removals, green additions, line numbers and inline text highlights. Choose Unified or Side by side; unchanged sections can be expanded. On phones, each article stacks below its page number/action so the diff uses the full width. Unified diffs wrap to fit; side-by-side diffs scroll horizontally within the comparison. The diff includes title, URL, topic, context and Markdown content, and is loaded only when opened. Nothing is changed by upload or preview.
- Choose **Apply reviewed changes**. The server prepares chunks and embeddings in bounded requests, saving progress in Postgres. Keep the tab open for processing; after interruption, unlock the dashboard and select the batch under Recent batches to resume. Use **Load older batches** when it is outside the newest 20 entries.
- The final request rechecks reviewed pages for concurrent edits, then writes pages, references and chunks in one transaction. A failure rolls back all live changes. If content has changed since preview, create a fresh preview. The dashboard's completed state means the whole batch was committed; completed requests are idempotent.

Existing page IDs are retained on updates. Outgoing page/legislation links are rebuilt from workbook content. Canonical CLIC URLs and the legacy `www.clic.org.hk` / `wwwnew.clic.org.hk` aliases are matched by normalized path; unrelated hosts cannot override those mappings. Existing case relationships are preserved on updates because this project has no supported case-link writer. Deletes remove incoming/outgoing page links, other page relationships and English search chunks. Unresolved CLIC, legislation or case references are reported rather than invented.

`content_import_jobs` retains the file name, selected page metadata, before/after content and completed results for inspection; in-progress chunks and vectors are stored separately in `content_import_chunks`. This is a shared-key activity history, not per-person identity tracking. Access to it is restricted by the same key. Normal database backups remain necessary; the dashboard does not offer one-click rollback. Operators can remove old completed job records under their retention policy once they no longer need the history. Preserve incomplete records if imports may be resumed. Staged rows are removed after successful publication and cascade when the owning job is removed.

## Verification

`pnpm test:content-admin` runs parsing/authentication tests. For full database tests, point `CONTENT_ADMIN_TEST_DATABASE_URL` to an isolated localhost PostgreSQL database with pgvector and the project schema/migrations applied. The suite refuses non-local hosts and truncates the fixture tables. It uses a local embedding-provider fixture, not a paid model service.

Set `CLIC_TEST_WORKBOOK` to a local November 6 workbook path to additionally exercise the real file.

The suite covers read-only preview, resumed indexing, atomic add/update/delete, reference and chunk writes, stale-preview rejection, rollback after a forced database error, and repeated completed requests. Browser verification uses the same isolated database and a synthetic workbook; production content is not used for test mutations.

## Initial preview setup

The import-history migration was applied to the configured CLIC database during implementation. The `feat/clic-content-dashboard` preview branch has a dedicated admin key configured as a Vercel Secret. The preview targets the existing CLIC database: choosing Apply there publishes live content changes. Production remains disabled until its own admin key is configured.

The staging migration moves existing JSON checkpoints into the new table before removing vector arrays from job payloads. It waits for active import steps using a table lock. Reload older dashboard tabs after deployment to resume using the new version. New steps process at most 16 vectors, and final publication copies staged vectors inside PostgreSQL.
