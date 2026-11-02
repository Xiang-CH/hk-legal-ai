# Judgment pilot review

The preview enables `JUDGMENT_FULLTEXT_ENABLED=true` against the verified production pilot. Production application deployment remains unchanged. Full-corpus embedding approval remains pilot-only; this PR does not claim the full rollout is complete.

PR: https://github.com/Xiang-CH/hk-legal-ai/pull/20. The feature flag is configured for the `feat/judgment-fulltext-pipeline` preview branch only. Preview deployments require Vercel sign-in under the project's existing access policy.

## Database inspection through Tailscale

Start `pnpm db:studio:drizzle` on the Mac, then run `tailscale serve --bg --https=443 --yes http://127.0.0.1:4983`. The Studio backend listens only on loopback. Tailscale Serve exposes it inside the tailnet. Database connections default to read-only.

Backend: `https://macbook.tail029bb3.ts.net/`. Drizzle's browser client is hosted at `https://local.drizzle.studio`; select the tailnet host and port 443. The backend uses POST requests, so a GET to its root returns 404 even when it is healthy. A POST with `{"type":"init"}` verifies the API. Tailscale access requires a connected, permitted device.

Stop exposure with `tailscale serve --https=443 off`, then stop the Studio process. Prisma remains the application's schema and migration owner; Drizzle is used for inspection only. Do not run Drizzle push or migrations against this database.
