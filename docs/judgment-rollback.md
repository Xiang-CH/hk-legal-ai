# Judgment database backup and rollback

The CLI in `scripts/judgments/backup.mjs` uses installed PostgreSQL client tools. It never loads `.env`; provide `JUDGMENT_DATABASE_URL` explicitly in the process environment. Do not put URLs on the command line. Credentials are passed to subprocesses through the child environment, never arguments, logs, or the manifest.

## Create a backup

```sh
export JUDGMENT_DATABASE_URL='postgresql://user:password@host:5432/database?sslmode=require'
node scripts/judgments/backup.mjs backup ./judgments.dump
```

This creates a custom-format `pg_dump` archive, validates its table of contents with `pg_restore --list`, and writes a sibling `.manifest.json` containing the normalized source identity, timestamp, archive basename, format, and SHA-256. Protect both files as sensitive data.

## Restore to a disposable database

Create an empty disposable database first. Its name must begin `clic_judgment_test_` or `clic_judgment_restore_`. Export its URL separately, then run:

```sh
export JUDGMENT_RESTORE_DATABASE_URL='postgresql://user:password@localhost:5432/clic_judgment_test_trial'
node scripts/judgments/backup.mjs restore ./judgments.dump \
  --target-url-env JUDGMENT_RESTORE_DATABASE_URL --ack-disposable
```

Restore checks the archive checksum, source and target host/port/database identities, and the required target name. It uses `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges`. It does not drop or create databases; a populated target can fail transactionally. Review host identity carefully when aliases or proxies may refer to the same server.

## Safety and verification

No automatic `.env` loading occurs. The source URL is required for both modes; restore additionally requires a separate explicitly named target URL and acknowledgement flag. Neither URL is printed or written to the manifest. PostgreSQL child output is suppressed to avoid credential leakage; failures report only the tool and exit code.

Restore is restricted to localhost and a disposable target name. Existing archives are never overwritten. Files are created with owner-only permissions.

Local verification restored a complete fixture database, including full-text vectors, into a separate database. Counts after restore were 3 judgments, 2 documents and 2 full-text chunks. Further fresh-database tests verify all four feature migrations and rollback while preserving 6 fixture judgments, a legacy summary and a pre-existing legislation link. Importer-owned legislation links are removed by rollback.

The real 2.9 GiB production archive is saved in `.audit/judgment-backups/pre-import-20261102.dump` with its checksum manifest. An exact local restore failed because local PostgreSQL lacks `azure_ai`. The user accepted that omission and authorized production updates for testing on 2026-11-02. A strict transactional restore with `--omit-azure-ai` then restored all application tables and verified their row counts. The receipt beside the archive records the two omitted extension metadata entries and the archive checksum. Production keeps its installed `azure_ai` extension. The restored database was subsequently renamed to `clic_judgment_test_business` for staging migration and import checks. No Azure restore server was created.

## Remove the additive schema

Disable `JUDGMENT_FULLTEXT_ENABLED` before rolling back. Run `scripts/judgments/rollback.sql` against the explicitly approved target to remove all four new migrations' objects in dependency order. This deletes imported documents, paragraphs, references, embeddings and import history, and removes only importer-owned legislation links. Existing judgments, cases, summaries and pre-existing relationships remain intact. Do not use `CASCADE` or `prisma db push`.

For exact database rollback, restore the pre-import archive into a separate verified database and switch the application connection only after verification. This restores migration history as well as data. Manual down SQL alone does not reconcile Prisma's applied-migration history; before re-enabling this feature, use a reviewed forward migration or the verified pre-import restore. Do not delete migration-history rows blindly.
