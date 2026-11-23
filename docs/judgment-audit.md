# Judgment source audit

Run `node scripts/judgments/audit.mjs [--dir DIR] [--output FILE]`. Output is JSONL, one source file per line; `FILE.summary.json` contains totals. With no output path, JSONL goes to stdout and totals to stderr.

Set `JUDGMENT_DATABASE_URL` explicitly to reconcile candidate identities against PostgreSQL. The command reads existing `Judgment` metadata inside a `READ ONLY` transaction and always rolls it back. It does not migrate, write, embed, or print connection details. Without a database it reports source inventory and `not-reconciled` outcomes. Paths are interpreted as court/year/judgment-number/language.json; EN/TC and EN_cit/TC_cit filenames are case-insensitive. Other files are accounted separately. Checksums are SHA-256. Output files must not already exist.

The source schema varies; content validation recognizes `html`, `content`, `judgment`, or `text` string fields. Identity reconciliation is a candidate match on normalized court/year/number/language and does not claim proceedings/action-number equivalence. Review ambiguous and unmatched outcomes before ingestion.
