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
