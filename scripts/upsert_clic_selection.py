#!/usr/bin/env python3
"""Upsert targeted CLIC pages straight from the xlsx, deduplicated by `nid` against the DB,
including a full reference-link rebuild (CLIC<->CLIC, CLIC->legislation).

Reads the EN sheet's `nid` column (dedup key = (nid, languageCode), same as
ClicPage @@unique) and the `2nd_id` column for the selection. No intermediate JSON needed.

Selection (defaults): 2nd_id 2674-2758 (adds) + 2nd_id 1,2,11,14 (updates).

Ref extraction mirrors clic-search/scripts/prepdoc.ipynb cell 26 (hklii case/legislation
links + /topics/ CLIC links), and relation writes mirror insert-clic.ts, with fixes:
  - legislation sections are matched paired (cap, section) with a leading-'s' fallback
    ('s12' -> '12'), instead of insert-clic's verbatim match + accidental cross-product;
  - page<->page edge orientation follows the live data: ("A"=referenced id, "B"=referrer id);
  - cases_ref is extracted and reported only: _ClicPageToJudgment is empty and nothing
    in the codebase writes it (court-code -> courtName mapping is unknown).

Usage (needs python with openpyxl + `psql` on PATH; DATABASE_URL from env/.env):
  python3 scripts/upsert_clic_selection.py --dry-run
  python3 scripts/upsert_clic_selection.py --apply
  python3 scripts/upsert_clic_selection.py --refs-only --apply   # rebuild refs only
  python3 scripts/upsert_clic_selection.py --apply --skip-refs   # pages only
"""
import argparse, base64, csv, html, io, os, re, shutil, subprocess, sys
from html.parser import HTMLParser

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required (uvx --with openpyxl provides it).")

COLS = {"nid": "nid", "second": "2nd_id", "title": "title", "url": "full_path",
        "topic": "topic", "content": "content", "result": "Result", "included": "Included?"}

# ---------------------------------------------------------------- helpers

def load_dotenv(path):
    vals = {}
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip().strip('"').strip("'")
    return vals

def strip_html(s):
    t = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(t)).strip()

def norm(s):
    return re.sub(r"\s+", " ", s or "").strip()

def topic_key_from_url(url):
    if isinstance(url, str) and "topics/" in url:
        seg = url.split("topics/")[1].strip().strip("/")
        return seg.split("/")[0] if seg else ""
    return ""

class LinkCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []
    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for k, v in attrs:
                if k == "href" and v:
                    self.hrefs.append(v)

# ---------------------------------------------------------------- excel

def read_selection(xlsx_path, add_lo, add_hi, update_ids):
    """Returns (selected_rows, path_map). selected_rows: list of dicts with raw cells."""
    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb["EN"]
    it = ws.iter_rows(min_row=1)
    header = [c.value for c in next(it)]
    h = [str(c).strip() if c is not None else "" for c in header]
    idx = {k: h.index(v) for k, v in COLS.items()}
    wanted_update = set(update_ids)
    selected, seen_second, struck = [], set(), set()
    path_map = {}  # normalized trailing path -> nid (for clic_ref resolution)
    for row in it:  # single pass: values + strikethrough check together
        cells = list(row)
        vals = [c.value for c in cells]
        try:
            raw_nid = vals[idx["nid"]]
            if raw_nid is None or str(raw_nid).strip() in ("", "#N/A"):
                continue
            nid = int(float(str(raw_nid).strip()))
        except (ValueError, TypeError):
            continue
        url = str(vals[idx["url"]] or "").strip()
        if url and "topics/" in url:
            path_map[url.split("topics/")[1].strip().strip("/").lower()] = nid
        c2 = vals[idx["second"]]
        if c2 is None or str(c2).strip() == "":
            continue
        try:
            v2 = int(float(str(c2).strip()))
        except ValueError:
            continue
        if not ((add_lo <= v2 <= add_hi) or v2 in wanted_update) or v2 in seen_second:
            continue
        seen_second.add(v2)
        if any(getattr(c.font, "strike", False) for c in cells if c.font):
            struck.add(v2)  # prepdoc parity: struck rows = removed
        selected.append({
            "second_id": v2, "nid": nid,
            "title": str(vals[idx["title"]] or "").strip(), "url": url,
            "topic_display": str(vals[idx["topic"]] or "").strip(),
            "content_html": str(vals[idx["content"]] or ""),
            "kind": "UPDATE" if v2 in wanted_update else "ADD",
            "struck": v2 in struck,
        })
    return selected, path_map

# ---------------------------------------------------------------- refs (prepdoc cell 26 parity)

def extract_refs(content_html, path_map):
    """Returns (clic_refs, leg_refs, case_refs). clic_refs: [{'nid'|None,'path'}]."""
    collector = LinkCollector()
    try:
        collector.feed(content_html or "")
    except Exception:
        pass
    clic, leg, cases = [], [], []
    for href in collector.hrefs:
        if "hklii" in href:
            url = href.split("?")[0]
            if url.endswith(".html"):
                url = url[:-5]
            if "cases" in href:
                meta = url.split("/cases")[1].strip().split("/") if "/cases" in url else []
                if len(meta) >= 4 - 1 and len(meta) >= 3 and meta[1:]:
                    cases.append({"court": meta[1] if len(meta) > 1 else "",
                                  "year": meta[2] if len(meta) > 2 else "",
                                  "no": meta[3] if len(meta) > 3 else ""})
            else:
                leg_type = ("ord" if "/ord/" in url else "reg" if "/reg/" in url
                            else "instrument" if "/instrument/" in url else None)
                if leg_type is None:
                    continue
                meta = url.split(f"/{leg_type}/")[1].strip().split("/")
                if not meta or not meta[0]:
                    continue
                no = meta[0]
                if leg_type == "instrument":
                    no = f"A{no}" if no.isdigit() else no
                leg.append({"type": leg_type, "no": no,
                            "section": meta[1] if len(meta) > 1 else ""})
        elif "/topics/" in href:
            rel = href.split("/topics/")[1].split("#")[0].split("?")[0].strip().strip("/")
            nid = path_map.get(rel.lower())
            clic.append({"nid": nid, "path": "/topics/" + rel})
    return clic, leg, cases

# ---------------------------------------------------------------- db via psql

def psql(dburl, sql):
    # NOTE: exec runs under a PTY, and psql wraps long values to the terminal
    # width even in unaligned mode. A huge COLUMNS keeps each row on one line,
    # which the base64 line parsing below depends on.
    psql_bin = shutil.which("psql")
    if not psql_bin:
        sys.exit("psql not found on PATH")
    env = dict(os.environ, DATABASE_URL=dburl, COLUMNS="1000000", TERM="dumb", PAGER="cat")
    p = subprocess.run([psql_bin, dburl, "-At", "-F", "\x1f", "-P", "pager=off",
                        "-v", "ON_ERROR_STOP=1", "-c", sql],
                       capture_output=True, text=True, env=env)
    if p.returncode != 0:
        sys.exit(f"psql failed: {p.stderr.strip()[:500]}")
    return p.stdout

def copy_rows(dburl, query):
    """Run a SELECT via COPY TO STDOUT (a data path psql never wraps) and parse as CSV."""
    psql_bin = shutil.which("psql")
    if not psql_bin:
        sys.exit("psql not found on PATH")
    env = dict(os.environ, DATABASE_URL=dburl)
    p = subprocess.run([psql_bin, dburl, "-v", "ON_ERROR_STOP=1", "-c",
                        "COPY (%s) TO STDOUT WITH (FORMAT csv)" % query],
                       capture_output=True, text=True, env=env)
    if p.returncode != 0:
        sys.exit(f"psql COPY failed: {p.stderr.strip()[:500]}")
    return list(csv.reader(io.StringIO(p.stdout)))

def _b64(expr):
    return "encode(convert_to(%s,'UTF8'),'base64')" % expr

def _dec(b):
    try:
        return base64.b64decode(b).decode("utf-8", "replace")
    except Exception:
        return ""

def fetch_pages(dburl, lang, nids):
    if not nids:
        return {}
    in_list = ",".join(str(n) for n in nids)
    q = ('SELECT nid, %s, %s, %s FROM "ClicPage" '
         'WHERE "languageCode" = \'%s\' AND nid IN (%s)') % (
        _b64("title"), _b64("url"), _b64("content"), lang, in_list)
    out = {}
    for parts in copy_rows(dburl, q):
        if len(parts) != 4:
            continue
        out[int(parts[0])] = {"title": _dec(parts[1]), "url": _dec(parts[2]),
                              "content": _dec(parts[3])}
    return out

def fetch_ids(dburl, lang, nids):
    if not nids:
        return {}
    in_list = ",".join(str(n) for n in sorted(set(nids)))
    q = ('SELECT id, nid FROM "ClicPage" WHERE "languageCode" = \'%s\' '
         'AND nid IN (%s)') % (lang, in_list)
    out = {}
    for parts in copy_rows(dburl, q):
        if len(parts) != 2:
            continue
        out[int(parts[1])] = int(parts[0])
    return out

def fetch_leg(dburl, lang, caps):
    caps = sorted({c for c in caps if c})
    cap_ids, sections = {}, []
    if caps:
        lit = ",".join("'" + c.replace("'", "''") + "'" for c in caps)
        q_cap = ('SELECT id, %s FROM "LegislationCap" '
                 'WHERE "languageCode" = \'%s\' AND "capNumber" IN (%s)') % (
            _b64('"capNumber"'), lang, lit)
        for parts in copy_rows(dburl, q_cap):
            if len(parts) != 2:
                continue
            try:
                cap_ids[_dec(parts[1])] = int(parts[0])
            except (ValueError, IndexError):
                continue
        q_sec = ('SELECT id, %s, %s FROM "LegislationSection" '
                 'WHERE "languageCode" = \'%s\' AND "capNumber" IN (%s)') % (
            _b64('"capNumber"'), _b64('"sectionNumber"'), lang, lit)
        for parts in copy_rows(dburl, q_sec):
            if len(parts) != 3:
                continue
            try:
                sections.append((int(parts[0]), _dec(parts[1]), _dec(parts[2])))
            except (ValueError, IndexError):
                continue
    return cap_ids, sections

def sql_lit(s):
    return "'" + (s or "").replace("'", "''") + "'"

def section_variants(section):
    cands = []
    if section:
        cands.append(section)
        stripped = re.sub(r"^[sS]", "", section)
        if stripped != section:
            cands.append(stripped)
    return cands

# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", default="/Users/cxiang/Downloads/CLIC Content List_20260924.xlsx")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--add-lo", type=int, default=2674)
    ap.add_argument("--add-hi", type=int, default=2758)
    ap.add_argument("--update-ids", default="1,2,11,14")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--include-junk", action="store_true")
    ap.add_argument("--skip-refs", action="store_true", help="pages only, no ref rebuild")
    ap.add_argument("--refs-only", action="store_true", help="rebuild refs only, no page upserts")
    a = ap.parse_args()

    update_ids = [int(x) for x in a.update_ids.split(",") if x.strip()]
    selected, path_map = read_selection(a.xlsx, a.add_lo, a.add_hi, update_ids)
    print(f"Excel selection: {len(selected)} rows")
    scoped = []
    for s in selected:
        text = strip_html(s["content_html"])
        s["content_text"] = text
        junk = (s["struck"] or s["url"] in ("#N/A", "None", "") or not s["url"]
                or "topics/" not in s["url"] or s["title"] in ("#N/A", "") or not text)
        s["junk_reason"] = ("struck" if s["struck"] else
                            "no-topics-url" if "topics/" not in s["url"] else
                            "empty" if not text or not s["title"] else "")
        s["junk"] = junk
        if a.include_junk or not junk:
            scoped.append(s)
    print(f"Skipped junk/empty/struck: {len(selected) - len(scoped)}")

    env = load_dotenv(os.path.join(os.getcwd(), ".env"))
    dburl = os.environ.get("DATABASE_URL") or env.get("DATABASE_URL")
    if not dburl:
        sys.exit("DATABASE_URL not set (env or .env)")

    # ---- page upserts
    to_insert, to_update, noop = [], [], 0
    existing = {} if a.refs_only else fetch_pages(dburl, a.lang, [s["nid"] for s in scoped])
    if not a.refs_only:
        for s in scoped:
            db = existing.get(s["nid"])
            if db is None:
                to_insert.append(s)
                continue
            fields = []
            if norm(db["title"]) != norm(s["title"]):
                fields.append("title")
            if norm(db["url"]) != norm(s["url"]):
                fields.append("url")
            if norm(db["content"]) != norm(s["content_text"]):
                fields.append("content")
            if fields:
                to_update.append((s, fields))
            else:
                noop += 1
        print(f"INSERT (nid not in DB): {len(to_insert)}")
        for s in to_insert:
            print(f"  + nid={s['nid']} 2nd={s['second_id']} | {s['title'][:70]}")
        print(f"UPDATE (nid in DB, differs): {len(to_update)}")
        for s, fields in to_update:
            print(f"  ~ nid={s['nid']} 2nd={s['second_id']} [{'+'.join(fields)}] | {s['title'][:70]}")
        print(f"NO-OP: {noop}")

    # ---- refs
    ref_plan = []
    if not a.skip_refs:
        for s in scoped:
            clic, leg, cases = extract_refs(s["content_html"], path_map)
            ref_plan.append((s, clic, leg, cases))
        n_clic = sum(len(c) for _, c, _, _ in ref_plan)
        n_clic_ok = sum(1 for _, c, _, _ in ref_plan for r in c if r["nid"] is not None)
        n_leg = sum(len(l) for _, _, l, _ in ref_plan)
        n_cases = sum(len(k) for _, _, _, k in ref_plan)
        print(f"REFS extracted: clic={n_clic} (resolved {n_clic_ok}, unresolved {n_clic - n_clic_ok}), "
              f"legislation={n_leg}, cases={n_cases} (reported only, no writer exists)")
        for s, clic, leg, cases in ref_plan:
            unres = [r["path"] for r in clic if r["nid"] is None]
            if unres:
                print(f"  nid={s['nid']} unresolved clic paths: {unres[:5]}")

    if not a.apply:
        print("dry-run — no writes. Re-run with --apply to write.")
        return

    if not a.refs_only:
        for s in to_insert:
            tkey = topic_key_from_url(s["url"]) or s["topic_display"]
            psql(dburl,
                 "INSERT INTO \"ClicPage\" (nid, title, content, topic, \"languageCode\", url, path, "
                 "\"contextualInformation\", \"lastUpdatedAt\") VALUES ("
                 f"{s['nid']}, {sql_lit(s['title'])}, {sql_lit(s['content_text'])}, "
                 f"{sql_lit(tkey)}, {sql_lit(a.lang)}, {sql_lit(s['url'])}, "
                 f"{sql_lit(s['url'].replace('https://clic.org.hk', '') if s['url'].startswith('http') else s['url'])}, "
                 f"{sql_lit(s['topic_display'])}, NOW());")
        for s, fields in to_update:
            psql(dburl,
                 f"UPDATE \"ClicPage\" SET title = {sql_lit(s['title'])}, url = {sql_lit(s['url'])}, "
                 f"path = {sql_lit(s['url'].replace('https://clic.org.hk', '') if s['url'].startswith('http') else s['url'])}, "
                 f"content = {sql_lit(s['content_text'])}, \"lastUpdatedAt\" = NOW() "
                 f"WHERE nid = {s['nid']} AND \"languageCode\" = {sql_lit(a.lang)};")
            psql(dburl, f"DELETE FROM \"clic_chunks\" WHERE nid = {s['nid']} "
                        f"AND language_code = {sql_lit(a.lang)};")
            print(f"updated nid={s['nid']} ({','.join(fields)}), stale chunks cleared")
        print(f"pages done: created={len(to_insert)} updated={len(to_update)}")

    if not a.skip_refs:
        all_nids = [s["nid"] for s in scoped]
        all_nids += [r["nid"] for s, clic, _, _ in ref_plan for r in clic if r["nid"] is not None]
        id_map = fetch_ids(dburl, a.lang, all_nids)
        caps_needed = set()
        for _, _, leg, _ in ref_plan:
            for r in leg:
                caps_needed.add(r["no"])
        cap_ids, sections = fetch_leg(dburl, a.lang, caps_needed)
        sec_index = {}
        for sid, cap, sec in sections:
            sec_index.setdefault((cap, sec), []).append(sid)
        missing_caps = sorted(c for c in caps_needed if c not in cap_ids)
        if missing_caps:
            print(f"caps not in DB (skipped): {missing_caps[:20]}")
        pp_ins, sec_ins, cap_ins = 0, 0, 0
        for s, clic, leg, _ in ref_plan:
            pid = id_map.get(s["nid"])
            if pid is None:
                print(f"  nid={s['nid']} has no DB id, refs skipped")
                continue
            stmts = [f"DELETE FROM \"_ClicPageRelationToClicPage\" WHERE \"B\" = {pid};"]
            for r in clic:
                rid = id_map.get(r["nid"]) if r["nid"] is not None else None
                if rid is not None:
                    stmts.append(f"INSERT INTO \"_ClicPageRelationToClicPage\" (\"A\", \"B\") "
                                 f"VALUES ({rid}, {pid}) ON CONFLICT DO NOTHING;")
                    pp_ins += 1
            sec_edges, cap_edges = set(), set()
            for r in leg:
                if not r["section"]:
                    if r["no"] in cap_ids:
                        cap_edges.add(cap_ids[r["no"]])
                    continue
                hit = False
                for cand in section_variants(r["section"]):
                    for sid in sec_index.get((r["no"], cand), []):
                        sec_edges.add(sid)
                        hit = True
                    if hit:
                        break
                if not hit and r["no"] in cap_ids:
                    cap_edges.add(cap_ids[r["no"]])  # fall back to cap edge
            stmts.append(f"DELETE FROM \"_ClicPageToLegislationSection\" WHERE \"A\" = {pid};")
            stmts.append(f"DELETE FROM \"_ClicPageToLegislationCap\" WHERE \"A\" = {pid};")
            for sid in sorted(sec_edges):
                stmts.append(f"INSERT INTO \"_ClicPageToLegislationSection\" (\"A\", \"B\") "
                             f"VALUES ({pid}, {sid}) ON CONFLICT DO NOTHING;")
                sec_ins += 1
            for cid in sorted(cap_edges):
                stmts.append(f"INSERT INTO \"_ClicPageToLegislationCap\" (\"A\", \"B\") "
                             f"VALUES ({pid}, {cid}) ON CONFLICT DO NOTHING;")
                cap_ins += 1
            psql(dburl, "\n".join(stmts))
        print(f"refs done: page-page edges={pp_ins}, section edges={sec_ins}, cap edges={cap_ins}")
    print("done. Next: re-chunk + embed + load these nids.")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Upsert targeted CLIC pages straight from the xlsx, deduplicated by `nid` against the DB,
including a full reference-link rebuild (CLIC<->CLIC, CLIC->legislation).
Content is converted exactly like prepdoc.ipynb (header strip + markdownify +
newline normalization), so updates compare markdown-vs-markdown.
Writes run as single transactions per phase (all-or-nothing; safe to re-run),
and dry-run prints a drop report of existing edges the rebuild would remove.

Reads the EN sheet's `nid` column (dedup key = (nid, languageCode), same as
ClicPage @@unique) and the `2nd_id` column for the selection. No intermediate JSON needed.

Selection is explicit (no defaults): --add-lo/--add-hi (2nd_id range), --update-ids
(comma-separated 2nd_ids), and/or --all (whole sheet: new vs updated auto-detected
by nid; Result=Delete rows skipped).

Ref extraction mirrors clic-search/scripts/prepdoc.ipynb cell 26 (hklii case/legislation
links + /topics/ CLIC links), and relation writes mirror insert-clic.ts, with fixes:
  - legislation sections are matched paired (cap, section) with a leading-'s' fallback
    ('s12' -> '12'), instead of insert-clic's verbatim match + accidental cross-product;
  - page<->page edge orientation follows the live data: ("A"=referenced id, "B"=referrer id);
  - cases_ref is extracted and reported only: _ClicPageToJudgment is empty and nothing
    in the codebase writes it (court-code -> courtName mapping is unknown).

Usage (needs python with openpyxl + `psql` on PATH; DATABASE_URL from env/.env):
  python3 scripts/upsert_clic_selection.py --dry-run
  python3 scripts/upsert_clic_selection.py --apply
  python3 scripts/upsert_clic_selection.py --refs-only --apply   # rebuild refs only
  python3 scripts/upsert_clic_selection.py --apply --skip-refs   # pages only
"""
import argparse, base64, csv, html, io, os, re, shutil, subprocess, sys
from html.parser import HTMLParser

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required (uvx --with openpyxl provides it).")
try:
    from markdownify import markdownify
except ImportError:
    sys.exit("markdownify is required (uvx --with markdownify provides it).")

COLS = {"nid": "nid", "second": "2nd_id", "title": "title", "url": "full_path",
        "topic": "topic", "content": "content", "result": "Result", "included": "Included?"}

# ---------------------------------------------------------------- helpers

def load_dotenv(path):
    vals = {}
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip().strip('"').strip("'")
    return vals

def normalize_newlines(text):
    # prepdoc.ipynb: 2+ consecutive newlines -> exactly two
    return re.sub(r"(\s*\n\s*){2,}", "\n\n", text)

def parse_content(content_html):
    """prepdoc.ipynb parity: drop the <h2> header line, convert to markdown,
    normalize newlines. Stored into ClicPage.content, so the compare against
    existing rows is markdown-vs-markdown and only real edits flag updates."""
    parts = (content_html or "").split("</h2>", maxsplit=1)
    no_header = parts[1].strip() if len(parts) > 1 else (content_html or "")
    return normalize_newlines(markdownify(no_header).strip())

def norm(s):
    return re.sub(r"\s+", " ", s or "").strip()

def topic_key_from_url(url):
    if isinstance(url, str) and "topics/" in url:
        seg = url.split("topics/")[1].strip().strip("/")
        return seg.split("/")[0] if seg else ""
    return ""

class LinkCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []
    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for k, v in attrs:
                if k == "href" and v:
                    self.hrefs.append(v)

# ---------------------------------------------------------------- excel

def read_selection(xlsx_path, add_lo, add_hi, update_ids, select_all=False):
    """Returns (selected_rows, path_map). selected_rows: list of dicts with raw cells."""
    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb["EN"]
    it = ws.iter_rows(min_row=1)
    header = [c.value for c in next(it)]
    h = [str(c).strip() if c is not None else "" for c in header]
    idx = {k: h.index(v) for k, v in COLS.items()}
    wanted_update = set(update_ids)
    use_range = add_lo is not None and add_hi is not None
    selected, seen_second = [], set()
    seen_nid = set()
    path_map = {}  # normalized trailing path -> nid (for clic_ref resolution)
    for row in it:  # single pass: values + strikethrough check together
        cells = list(row)
        vals = [c.value for c in cells]
        try:
            raw_nid = vals[idx["nid"]]
            if raw_nid is None or str(raw_nid).strip() in ("", "#N/A"):
                continue
            nid = int(float(str(raw_nid).strip()))
        except (ValueError, TypeError):
            continue
        url = str(vals[idx["url"]] or "").strip()
        if url and "topics/" in url:
            path_map[url.split("topics/")[1].strip().strip("/").lower()] = nid
        c2 = vals[idx["second"]]
        try:
            v2 = int(float(str(c2).strip())) if c2 is not None and str(c2).strip() != "" else None
        except ValueError:
            v2 = None
        result_flag = str(vals[idx["result"]] or "").strip()
        if select_all:
            if nid in seen_nid:
                continue
            seen_nid.add(nid)
            v2 = v2 if v2 is not None else -1
        else:
            if v2 is None:
                continue
            in_add = use_range and add_lo <= v2 <= add_hi
            if not (in_add or v2 in wanted_update) or v2 in seen_second:
                continue
            seen_second.add(v2)
            if nid in seen_nid:
                print(f"  duplicate nid={nid} at 2nd_id={v2} skipped", file=sys.stderr)
                continue
            seen_nid.add(nid)
        # prepdoc parity: struck rows = removed. Per-row (not keyed by id:
        # blank-2nd_id rows share v2=-1, so a shared key would taint them all).
        row_struck = any(getattr(c.font, "strike", False) for c in cells if c.font)
        selected.append({
            "second_id": v2, "nid": nid,
            "title": str(vals[idx["title"]] or "").strip(), "url": url,
            "topic_display": str(vals[idx["topic"]] or "").strip(),
            "content_html": str(vals[idx["content"]] or ""),
            "result_flag": result_flag,
            "kind": "UPDATE" if v2 in wanted_update else "ADD",
            "struck": row_struck,
        })
    return selected, path_map

# ---------------------------------------------------------------- refs (prepdoc cell 26 parity)

def extract_refs(content_html, path_map):
    """Returns (clic_refs, leg_refs, case_refs). clic_refs: [{'nid'|None,'path'}]."""
    collector = LinkCollector()
    try:
        collector.feed(content_html or "")
    except Exception:
        pass
    clic, leg, cases = [], [], []
    for href in collector.hrefs:
        if "hklii" in href:
            url = href.split("?")[0]
            if url.endswith(".html"):
                url = url[:-5]
            if "cases" in href:
                meta = url.split("/cases")[1].strip().split("/") if "/cases" in url else []
                if len(meta) >= 4 - 1 and len(meta) >= 3 and meta[1:]:
                    cases.append({"court": meta[1] if len(meta) > 1 else "",
                                  "year": meta[2] if len(meta) > 2 else "",
                                  "no": meta[3] if len(meta) > 3 else ""})
            else:
                leg_type = ("ord" if "/ord/" in url else "reg" if "/reg/" in url
                            else "instrument" if "/instrument/" in url else None)
                if leg_type is None:
                    continue
                meta = url.split(f"/{leg_type}/")[1].strip().split("/")
                if not meta or not meta[0]:
                    continue
                no = meta[0]
                if leg_type == "instrument":
                    no = f"A{no}" if no.isdigit() else no
                leg.append({"type": leg_type, "no": no,
                            "section": meta[1] if len(meta) > 1 else ""})
        elif "/topics/" in href:
            rel = href.split("/topics/")[1].split("#")[0].split("?")[0].strip().strip("/")
            nid = path_map.get(rel.lower())
            clic.append({"nid": nid, "path": "/topics/" + rel})
    return clic, leg, cases

# ---------------------------------------------------------------- db via psql

def psql(dburl, sql):
    # NOTE: exec runs under a PTY, and psql wraps long values to the terminal
    # width even in unaligned mode. A huge COLUMNS keeps each row on one line,
    # which the base64 line parsing below depends on.
    psql_bin = shutil.which("psql")
    if not psql_bin:
        sys.exit("psql not found on PATH")
    env = dict(os.environ, DATABASE_URL=dburl, COLUMNS="1000000", TERM="dumb", PAGER="cat")
    p = subprocess.run([psql_bin, dburl, "-At", "-F", "\x1f", "-P", "pager=off",
                        "-v", "ON_ERROR_STOP=1", "-c", sql],
                       capture_output=True, text=True, env=env)
    if p.returncode != 0:
        sys.exit(f"psql failed: {p.stderr.strip()[:500]}")
    return p.stdout

def copy_rows(dburl, query):
    """Run a SELECT via COPY TO STDOUT (a data path psql never wraps) and parse as CSV."""
    psql_bin = shutil.which("psql")
    if not psql_bin:
        sys.exit("psql not found on PATH")
    env = dict(os.environ, DATABASE_URL=dburl)
    p = subprocess.run([psql_bin, dburl, "-v", "ON_ERROR_STOP=1", "-c",
                        "COPY (%s) TO STDOUT WITH (FORMAT csv)" % query],
                       capture_output=True, text=True, env=env)
    if p.returncode != 0:
        sys.exit(f"psql COPY failed: {p.stderr.strip()[:500]}")
    return list(csv.reader(io.StringIO(p.stdout)))

def _b64(expr):
    return "encode(convert_to(%s,'UTF8'),'base64')" % expr

def _dec(b):
    try:
        return base64.b64decode(b).decode("utf-8", "replace")
    except Exception:
        return ""

def fetch_pages(dburl, lang, nids):
    if not nids:
        return {}
    in_list = ",".join(str(n) for n in nids)
    q = ('SELECT nid, %s, %s, %s FROM "ClicPage" '
         'WHERE "languageCode" = \'%s\' AND nid IN (%s)') % (
        _b64("title"), _b64("url"), _b64("content"), lang, in_list)
    out = {}
    for parts in copy_rows(dburl, q):
        if len(parts) != 4:
            continue
        out[int(parts[0])] = {"title": _dec(parts[1]), "url": _dec(parts[2]),
                              "content": _dec(parts[3])}
    return out

def fetch_ids(dburl, lang, nids):
    if not nids:
        return {}
    in_list = ",".join(str(n) for n in sorted(set(nids)))
    q = ('SELECT id, nid FROM "ClicPage" WHERE "languageCode" = \'%s\' '
         'AND nid IN (%s)') % (lang, in_list)
    out = {}
    for parts in copy_rows(dburl, q):
        if len(parts) != 2:
            continue
        out[int(parts[1])] = int(parts[0])
    return out

def fetch_leg(dburl, lang, caps):
    caps = sorted({c for c in caps if c})
    cap_ids, sections = {}, []
    if caps:
        lit = ",".join("'" + c.replace("'", "''") + "'" for c in caps)
        q_cap = ('SELECT id, %s FROM "LegislationCap" '
                 'WHERE "languageCode" = \'%s\' AND "capNumber" IN (%s)') % (
            _b64('"capNumber"'), lang, lit)
        for parts in copy_rows(dburl, q_cap):
            if len(parts) != 2:
                continue
            try:
                cap_ids[_dec(parts[1])] = int(parts[0])
            except (ValueError, IndexError):
                continue
        q_sec = ('SELECT id, %s, %s FROM "LegislationSection" '
                 'WHERE "languageCode" = \'%s\' AND "capNumber" IN (%s)') % (
            _b64('"capNumber"'), _b64('"sectionNumber"'), lang, lit)
        for parts in copy_rows(dburl, q_sec):
            if len(parts) != 3:
                continue
            try:
                sections.append((int(parts[0]), _dec(parts[1]), _dec(parts[2])))
            except (ValueError, IndexError):
                continue
    return cap_ids, sections

def sql_lit(s):
    return "'" + (s or "").replace("'", "''") + "'"

def section_variants(section):
    cands = []
    if section:
        cands.append(section)
        stripped = re.sub(r"^[sS]", "", section)
        if stripped != section:
            cands.append(stripped)
    return cands

# ---------------------------------------------------------------- main

def run_script(dburl, stmts, label):
    """Execute statements as ONE transaction fed to psql via stdin (no OS argv
    limit, however large the selection). With ON_ERROR_STOP, any failure
    aborts before COMMIT and the server rolls back on disconnect — callers can
    simply re-run with no partial state left behind."""
    import subprocess as _sp
    if not stmts:
        print(f"{label}: nothing to write, skipped")
        return
    psql_bin = shutil.which("psql")
    if not psql_bin:
        sys.exit("psql not found on PATH")
    env = dict(os.environ, DATABASE_URL=dburl)
    script = "BEGIN;\n" + "\n".join(stmts) + "\nCOMMIT;\n"
    r = _sp.run([psql_bin, dburl, "-X", "-q", "-v", "ON_ERROR_STOP=1"],
                input=script, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        sys.exit(f"{label}: FAILED, rolled back: {r.stderr.strip()[:500]}")
    print(f"{label}: committed ({len(stmts)} statements)")

def match_leg_refs(leg_list, cap_ids, sec_index):
    """Resolve extracted legislation refs to edge targets (paired cap+section,
    with leading-'s' fallback and cap fallback). Returns
    (section_ids, cap_ids, dropped_labels). Shared by the drop report and the
    apply writes so both always agree."""
    sec_edges, cap_edges, dropped = set(), set(), []
    for r in leg_list:
        if not r["section"]:
            if r["no"] in cap_ids:
                cap_edges.add(cap_ids[r["no"]])
            else:
                dropped.append(f"{r['type']}:{r['no']} (cap missing)")
            continue
        hit = False
        for cand in section_variants(r["section"]):
            for sid in sec_index.get((r["no"], cand), []):
                sec_edges.add(sid)
                hit = True
            if hit:
                break
        if not hit:
            if r["no"] in cap_ids:
                cap_edges.add(cap_ids[r["no"]])  # fall back to cap edge
            else:
                dropped.append(f"{r['type']}:{r['no']}/{r['section']} (cap+section missing)")
    return sec_edges, cap_edges, dropped

def print_drop_report(dburl, ref_plan, id_map, sec_index, cap_ids):
    """Diff each in-scope page's EXISTING outgoing edges against the planned
    rebuild set and print anything the rebuild would REMOVE without recreating.
    Silent edge loss is the failure mode this guards."""
    pids = sorted({id_map[s] for s in
                   ([e["s"]["nid"] for e in ref_plan]) if s in id_map})
    if not ref_plan:
        print("drop-report: ref scope is empty — nothing to check")
        return 0
    if not pids:
        print("drop-report: none of the in-scope pages exist in the DB yet — nothing to lose")
        return 0
    in_list = ",".join(map(str, pids))
    nid_of = {v: k for k, v in id_map.items()}
    sec_label = {}
    for (cap, sec), sids in sec_index.items():
        for sid in sids:
            sec_label[sid] = f"{cap}/{sec}"
    cap_label = {v: k for k, v in cap_ids.items()}

    exist_pp, exist_sec, exist_cap = {}, {}, {}
    for parts in copy_rows(dburl, f'SELECT "B", "A" FROM "_ClicPageRelationToClicPage" '
                                 f"WHERE \"B\" IN ({in_list})"):
        if len(parts) == 2:
            exist_pp.setdefault(int(parts[0]), set()).add(int(parts[1]))
    for parts in copy_rows(dburl, f'SELECT "A", "B" FROM "_ClicPageToLegislationSection" '
                                 f"WHERE \"A\" IN ({in_list})"):
        if len(parts) == 2:
            exist_sec.setdefault(int(parts[0]), set()).add(int(parts[1]))
    for parts in copy_rows(dburl, f'SELECT "A", "B" FROM "_ClicPageToLegislationCap" '
                                 f"WHERE \"A\" IN ({in_list})"):
        if len(parts) == 2:
            exist_cap.setdefault(int(parts[0]), set()).add(int(parts[1]))

    total_dropped = 0
    for e in ref_plan:
        s = e["s"]
        pid = id_map.get(s["nid"])
        if pid is None:
            continue
        planned_pp_ids = {id_map[n] for n in e["planned_pp"] if n in id_map}
        lost = []
        for rid in sorted(exist_pp.get(pid, set()) - planned_pp_ids):
            lost.append(f"page nid={nid_of.get(rid, '?')}")
        for sid in sorted(exist_sec.get(pid, set()) - e["planned_sec"]):
            lost.append(f"section {sec_label.get(sid, sid)}")
        for cid in sorted(exist_cap.get(pid, set()) - e["planned_cap"]):
            lost.append(f"cap {cap_label.get(cid, cid)}")
        if lost:
            total_dropped += len(lost)
            print(f"  nid={s['nid']} rebuild would DROP {len(lost)} existing edge(s): {lost[:8]}")
    if not total_dropped:
        print("drop-report: rebuild recreates every existing edge — nothing lost")
    else:
        print(f"drop-report: {total_dropped} existing edge(s) would be dropped "
              f"(unresolved targets) — review before --apply")
    return total_dropped

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", default="/Users/cxiang/Downloads/CLIC Content List_20260924.xlsx")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--add-lo", type=int, default=None,
                      help="2nd_id range start for adds (requires --add-hi)")
    ap.add_argument("--add-hi", type=int, default=None,
                      help="2nd_id range end for adds (requires --add-lo)")
    ap.add_argument("--update-ids", default="",
                      help="comma-separated 2nd_ids for updates, e.g. 1,2,11,14")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--dry-run", action="store_true", help="explicit no-op: read-only, no writes (the default)")
    ap.add_argument("--include-junk", action="store_true")
    ap.add_argument("--skip-refs", action="store_true", help="pages only, no ref rebuild")
    ap.add_argument("--refs-only", action="store_true", help="rebuild refs only, no page upserts")
    ap.add_argument("--insert-only", action="store_true",
                      help="insert new pages only; existing rows (and their refs/chunks) "
                           "are left untouched")
    ap.add_argument("--summary", action="store_true",
                      help="print only aggregate statistics, not per-page listings")
    ap.add_argument("--require-no-drop", action="store_true",
                      help="fail closed: abort (non-zero exit) if the drop report "
                           "finds any existing edge the rebuild would remove")
    ap.add_argument("--all", action="store_true",
                      help="select every row with a nid (auto-detect new vs updated "
                           "across the whole sheet) instead of a 2nd_id scope; "
                           "rows flagged Result=Delete are still skipped")
    a = ap.parse_args()

    if (a.add_lo is None) != (a.add_hi is None):
        ap.error("--add-lo and --add-hi must be given together")
    update_ids = [int(x) for x in a.update_ids.split(",") if x.strip()]
    if a.add_lo is None and not update_ids and not a.all:
        ap.error("no selection: pass --add-lo/--add-hi, --update-ids, and/or --all")
    selected, path_map = read_selection(a.xlsx, a.add_lo, a.add_hi, update_ids, a.all)
    print(f"Excel selection: {len(selected)} rows")
    scoped = []
    for s in selected:
        text = parse_content(s["content_html"])
        s["content_text"] = text
        junk = (s["struck"] or s.get("result_flag") == "Delete"
                or s["url"] in ("#N/A", "None", "") or not s["url"]
                or "topics/" not in s["url"] or s["title"] in ("#N/A", "") or not text)
        s["junk_reason"] = ("struck" if s["struck"] else
                            "no-topics-url" if "topics/" not in s["url"] else
                            "empty" if not text or not s["title"] else "")
        s["junk"] = junk
        if a.include_junk or not junk:
            scoped.append(s)
    print(f"Skipped junk/empty/struck: {len(selected) - len(scoped)}")

    env = load_dotenv(os.path.join(os.getcwd(), ".env"))
    dburl = os.environ.get("DATABASE_URL") or env.get("DATABASE_URL")
    if not dburl:
        sys.exit("DATABASE_URL not set (env or .env)")

    # ---- page upserts
    to_insert, to_update, noop = [], [], 0
    existing = {} if a.refs_only else fetch_pages(dburl, a.lang, [s["nid"] for s in scoped])
    if not a.refs_only:
        for s in scoped:
            db = existing.get(s["nid"])
            if db is None:
                to_insert.append(s)
                continue
            fields = []
            if norm(db["title"]) != norm(s["title"]):
                fields.append("title")
            if norm(db["url"]) != norm(s["url"]):
                fields.append("url")
            if norm(db["content"]) != norm(s["content_text"]):
                fields.append("content")
            if fields:
                to_update.append((s, fields))
            else:
                noop += 1
        print(f"INSERT (nid not in DB): {len(to_insert)}")
        if not a.summary:
            for s in to_insert:
                print(f"  + nid={s['nid']} 2nd={s['second_id']} | {s['title'][:70]}")
        print(f"UPDATE (nid in DB, differs): {len(to_update)}")
        if not a.summary:
            for s, fields in to_update:
                print(f"  ~ nid={s['nid']} 2nd={s['second_id']} [{'+'.join(fields)}] | {s['title'][:70]}")
        print(f"NO-OP: {noop}")
        if a.insert_only and to_update:
            print(f"insert-only: {len(to_update)} update(s) would be skipped")

    # ---- refs: extract + resolve (read-only; feeds both the dry-run drop
    # report and the apply writes)
    ref_plan = []  # (s, clic, leg, cases, planned_pp, planned_sec, planned_cap, dropped_leg)
    id_map, cap_ids, sec_index = {}, {}, {}
    if not a.skip_refs:
        for s in scoped:
            clic, leg, cases = extract_refs(s["content_html"], path_map)
            ref_plan.append({"s": s, "clic": clic, "leg": leg, "cases": cases})
        all_nids = [s["nid"] for s in scoped]
        all_nids += [r["nid"] for e in ref_plan for r in e["clic"] if r["nid"] is not None]
        id_map = fetch_ids(dburl, a.lang, all_nids)
        caps_needed = {r["no"] for e in ref_plan for r in e["leg"]}
        cap_ids, sections = fetch_leg(dburl, a.lang, caps_needed)
        for sid, cap, sec in sections:
            sec_index.setdefault((cap, sec), []).append(sid)
        if a.insert_only:
            before = len(ref_plan)
            ref_plan = [e for e in ref_plan if e["s"]["nid"] not in id_map]
            print(f"insert-only: refs scoped to {len(ref_plan)} new page(s) (was {before})")
        for e in ref_plan:
            sec_edges, cap_edges, dropped = match_leg_refs(e["leg"], cap_ids, sec_index)
            e["planned_pp"] = {r["nid"] for r in e["clic"] if r["nid"] is not None}
            e["planned_sec"] = sec_edges
            e["planned_cap"] = cap_edges
            e["dropped_leg"] = dropped
        n_clic = sum(len(e["clic"]) for e in ref_plan)
        n_clic_ok = sum(1 for e in ref_plan for r in e["clic"] if r["nid"] is not None)
        n_leg = sum(len(e["leg"]) for e in ref_plan)
        n_cases = sum(len(e["cases"]) for e in ref_plan)
        print(f"REFS extracted: clic={n_clic} (resolved {n_clic_ok}, unresolved {n_clic - n_clic_ok}), "
              f"legislation={n_leg}, cases={n_cases} (reported only, no writer exists)")
        for e in ref_plan:
            unres = [r["path"] for r in e["clic"] if r["nid"] is None]
            if unres and not a.summary:
                print(f"  nid={e['s']['nid']} unresolved clic paths: {unres[:5]}")
        if a.summary:
            n_unres_pages = sum(1 for e in ref_plan
                                if any(r["nid"] is None for r in e["clic"]))
            print(f"unresolved clic paths on {n_unres_pages} page(s)")
        missing_caps = sorted({r["no"] for e in ref_plan for r in e["leg"]} - set(cap_ids))
        if missing_caps:
            print(f"caps not in DB (no edge possible): {missing_caps[:20]}")
        for e in ref_plan:
            if e["dropped_leg"]:
                print(f"  nid={e['s']['nid']} leg refs resolving to nothing: {e['dropped_leg'][:8]}")
        drops = print_drop_report(dburl, ref_plan, id_map, sec_index, cap_ids)
        if drops and a.require_no_drop:
            sys.exit(f"aborting: --require-no-drop set with {drops} edge(s) "
                     f"at risk; resolve targets or re-run without the flag")

    if not a.apply:
        print("dry-run — no writes. Re-run with --apply to write.")
        return

    # ---- apply: ONE transaction for pages + refs together. Page ids are
    # referenced via subselects, so newly inserted pages resolve inside the
    # same txn. Any failure aborts before COMMIT -> full rollback, and a
    # re-run is clean (page upserts are content-compared, ref writes are
    # delete+recreate). A duplicate nid now fails the whole apply atomically
    # instead of leaving partial progress.
    def _pid(nid):
        return (f'(SELECT id FROM "ClicPage" WHERE nid = {nid} '
                f'AND "languageCode" = {sql_lit(a.lang)})')

    stmts, n_ins, n_upd = [], 0, 0
    if a.insert_only and to_update:
        print(f"insert-only: skipping {len(to_update)} update(s), chunks and refs untouched")
    if not a.refs_only:
        for s in to_insert:
            tkey = topic_key_from_url(s["url"]) or s["topic_display"]
            pth = s["url"].replace("https://clic.org.hk", "") if s["url"].startswith("http") else s["url"]
            stmts.append(
                "INSERT INTO \"ClicPage\" (nid, title, content, topic, \"languageCode\", url, path, "
                "\"contextualInformation\", \"lastUpdatedAt\") VALUES ("
                f"{s['nid']}, {sql_lit(s['title'])}, {sql_lit(s['content_text'])}, "
                f"{sql_lit(tkey)}, {sql_lit(a.lang)}, {sql_lit(s['url'])}, "
                f"{sql_lit(pth)}, {sql_lit(s['topic_display'])}, NOW());")
            n_ins += 1
        for s, fields in ([] if a.insert_only else to_update):
            pth = s["url"].replace("https://clic.org.hk", "") if s["url"].startswith("http") else s["url"]
            stmts.append(
                f"UPDATE \"ClicPage\" SET title = {sql_lit(s['title'])}, url = {sql_lit(s['url'])}, "
                f"path = {sql_lit(pth)}, content = {sql_lit(s['content_text'])}, "
                f"\"lastUpdatedAt\" = NOW() "
                f"WHERE nid = {s['nid']} AND \"languageCode\" = {sql_lit(a.lang)};")
            stmts.append(f"DELETE FROM \"clic_chunks\" WHERE nid = {s['nid']} "
                         f"AND language_code = {sql_lit(a.lang)};")
            if not a.summary:
                n_upd += 1
            print(f"queued update nid={s['nid']} ({','.join(fields)}) + chunk clear")
    pp_ins = sec_ins = cap_ins = n_ref_pages = 0
    if not a.skip_refs:
        insert_set = {s["nid"] for s in to_insert} if not a.refs_only else set()
        for e in ref_plan:
            s = e["s"]
            if s["nid"] not in id_map and s["nid"] not in insert_set:
                print(f"  nid={s['nid']} has no DB id and is not being inserted, refs skipped")
                continue
            P = _pid(s["nid"])
            stmts.append(f"DELETE FROM \"_ClicPageRelationToClicPage\" WHERE \"B\" = {P};")
            for rnid in sorted(e["planned_pp"]):
                # target known pre-existing, or inserted earlier in this txn
                if rnid in id_map or rnid in insert_set:
                    stmts.append(f"INSERT INTO \"_ClicPageRelationToClicPage\" (\"A\", \"B\") "
                                 f"VALUES ({_pid(rnid)}, {P}) ON CONFLICT DO NOTHING;")
                    pp_ins += 1
            stmts.append(f"DELETE FROM \"_ClicPageToLegislationSection\" WHERE \"A\" = {P};")
            stmts.append(f"DELETE FROM \"_ClicPageToLegislationCap\" WHERE \"A\" = {P};")
            for sid in sorted(e["planned_sec"]):
                stmts.append(f"INSERT INTO \"_ClicPageToLegislationSection\" (\"A\", \"B\") "
                             f"VALUES ({P}, {sid}) ON CONFLICT DO NOTHING;")
                sec_ins += 1
            for cid in sorted(e["planned_cap"]):
                stmts.append(f"INSERT INTO \"_ClicPageToLegislationCap\" (\"A\", \"B\") "
                             f"VALUES ({P}, {cid}) ON CONFLICT DO NOTHING;")
                cap_ins += 1
            n_ref_pages += 1
    run_script(dburl, stmts,
               f"apply (pages +{n_ins} ~{n_upd}; refs pp={pp_ins} sec={sec_ins} cap={cap_ins} "
               f"on {n_ref_pages} pages)")
    print("done. Next: re-chunk + embed + load these nids.")

if __name__ == "__main__":
    main()
