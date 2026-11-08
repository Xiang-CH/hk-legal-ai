# Judgment pilot review

The preview enables `JUDGMENT_FULLTEXT_ENABLED=true` against the verified production pilot. Production application deployment remains unchanged. Full-corpus embedding approval remains pilot-only; this PR does not claim the full rollout is complete.

PR: https://github.com/Xiang-CH/hk-legal-ai/pull/20. The feature flag is configured for the `feat/judgment-fulltext-pipeline` preview branch only. Preview deployments require Vercel sign-in under the project's existing access policy.

## Database inspection through Tailscale

Provision a dedicated SELECT-only login using `scripts/judgments/provision-studio-role.mjs` with `STUDIO_ADMIN_DATABASE_URL` supplied privately and the intended application `DATABASE_URL`. It refuses to overwrite `.env.studio`; the resulting file contains only the new restricted connection and is owner-readable and ignored by Git. Creating roles requires administrator credentials; the application login cannot do this. Existing application-owned future tables receive SELECT grants through default privileges.

For local inspection, start `pnpm db:studio:drizzle` on the Mac. No Tailscale exposure is needed. The launcher requires `DRIZZLE_READONLY_DATABASE_URL`, checks that the role has no elevated memberships or persistent database/schema/table/sequence write permissions, and refuses the application writer credentials. The backend listens only on loopback. Any future network exposure requires a separate explicit request. The session read-only default is an additional precaution; actual SELECT-only grants enforce the restriction even if a user changes that default. Existing PUBLIC privileges to create temporary tables are not grants to alter application data.

The old application-credential Studio endpoint was stopped during this correction. The user confirmed that Tailscale exposure was only needed temporarily and is no longer requested; leave it disabled. The restricted launcher remains available for future local inspection. Never fall back to `DATABASE_URL` when restricted credentials are unavailable.

Historical backend, now disabled: `https://macbook.tail029bb3.ts.net/`. Drizzle's browser client is hosted at `https://local.drizzle.studio`; select the tailnet host and port 443. The backend uses POST requests, so a GET to its root returns 404 even when it is healthy. A POST with `{"type":"init"}` verifies the API. Tailscale access requires a connected, permitted device.

Stop exposure with `tailscale serve --https=443 off`, then stop the Studio process. Prisma remains the application's schema and migration owner; Drizzle is used for inspection only. Do not run Drizzle push or migrations against this database.
