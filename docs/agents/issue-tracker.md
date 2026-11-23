# Issue tracker

Issues and specs live in GitHub Issues in Xiang-CH/hk-legal-ai.
Use the gh CLI with an explicit --repo Xiang-CH/hk-legal-ai.

Publish tickets as GitHub issues. Read relevant tickets with
gh issue view, including their bodies, labels, and comments.

Use native sub-issues and blocking dependencies where supported.
Otherwise record "Part of #N" and "Blocked by: #N" in issue bodies.

Before closing an issue, post a comment explaining the outcome.
Keep existing tickets/ files and tickets/INDEX.md synchronized with their corresponding GitHub Issues when status or scope changes. GitHub Issues are the source of truth for new work.

Use only verified issue links recorded in the ticket file or tickets/INDEX.md. Do not infer an issue number from a ticket number. For a legacy ticket without a confirmed issue, keep its local status accurate and explicitly mark the GitHub mapping as unconfirmed. When that ticket becomes active work, search GitHub Issues for a matching scope; record a verified link in the ticket and index, or create a corresponding issue if none exists. Then synchronize both records.

PRs as a request surface: no.
