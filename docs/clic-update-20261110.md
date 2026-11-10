# CLIC page maintenance, 10 November 2026

Source: `CLIC Content List_20261106.xlsx`, EN sheet. All numbers below are Column C `2nd_id`, not spreadsheet row numbers or Drupal nids.

## Requested scope

Update: 1–2, 11, 14, 204–223, 225–226, 229–230, 234, 236–247, 249–253, 255–256, 258–270, 886–887, 1493–1495, 1898–1909, 1912–1925, 1927–1931.

Remove: 224, 227–228, 231–233, 235, 248, 254, 257, 1910–1911, 1926.

## Execution and verification

- 97 requested update IDs: 92 existing pages changed, 4 already matched, and 1 missing page restored from the workbook.
- 13 requested removal IDs resolve to 12 distinct nids. ID 257 has no nid in the workbook; exact URL lookup resolves it to nid 2147, also used by ID 1911. Nids 171 and 172 were already absent; 10 existing English pages were removed.
- Target pages, chunks, incoming/outgoing page links and legislation/judgment relationships were backed up before mutation. The update/reference rebuild and deletion ran in one transaction.
- ID 252 has a spreadsheet strikethrough but was explicitly listed for update by the user. Its content was retained and updated as requested.
- ID 886 has body content before its h2. The importer was corrected to remove only the heading, rather than discarding all text preceding it. A regression test covers this ordering.
- Generated 141 replacement/new chunks for 93 pages; preserved the 4 already-current pages' 5 chunks. All 97 pages now have 146 chunks with valid 3072-dimensional embeddings and non-null English tsv.
- All 97 titles, URLs and normalized Markdown bodies match the workbook. No removed English page or chunk remains.
- Full-row checksums of pages and chunks outside this batch match their pre-operation values.
- Database lexical-search checks cover page 886's retained Legal Aid text, arbitration and writ-of-summons content. This maintenance run did not repeat a deployed chat-generation test.

Reference resolution uses workbook URLs plus pre-update database URLs, preserving references through historical paths. Two references to `/topics/civilCase/fix_trial_date/q3` remain unmapped, on nids 174 and 135. Other old edges absent from the replacement content were rebuilt according to the updated workbook; hyperlinks remain in page text.

Backup, selection mapping, generated transaction, embedding checkpoints and verification output are in ignored `scripts/index-output/clic-20261110/`. They are local operational artifacts and are not committed. Code changes can be reverted independently; reverting a PR does not restore the database backup.
