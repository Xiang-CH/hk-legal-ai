import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Classify a corpus-relative file and extract its court, year, number and language without reading content. */
export function parseSourcePath(root, file) {
  const rel = path.relative(root, file).split(path.sep);
  if (rel.length < 3 || rel[0].startsWith('.')) return null;
  const court = rel[0].toUpperCase();
  const year = Number(rel[1]);
  const base = rel.at(-1);
  const sidecar = /^(EN|TC)_cit\.json$/i.test(base);
  const languageFile = base.match(/^(EN|TC)\.json$/i);
  const number = rel.length >= 4 && /^\d+$/.test(rel.at(-2)) ? rel.at(-2) : null;
  const _fileMatch = base.match(/^(\d+)(?:[-_](EN|TC))?\.json$/i);
  const numberConflict = number !== null && _fileMatch && Number(number) !== Number(_fileMatch[1]);
  return { court, year: Number.isFinite(year) ? year : null, number: numberConflict ? null : number ?? _fileMatch?.[1] ?? null,
    language: languageFile?.[1].toUpperCase() ?? base.match(/^(EN|TC)_cit\.json$/i)?.[1].toUpperCase() ?? _fileMatch?.[2]?.toUpperCase() ?? null, kind: sidecar ? 'sidecar' : (languageFile || _fileMatch) ? 'content' : 'other', path: rel.join('/') };
}

/** Yield regular corpus files recursively; ignore symlinks and propagate directory read failures. */
export async function* walk(root) {
  for (const ent of await fs.promises.readdir(root, { withFileTypes: true })) {
    const _filePath = path.join(root, ent.name);
    if (ent.isDirectory()) yield* walk(_filePath);
    else if (ent.isFile()) yield _filePath;
  }
}
export async function readSourceSnapshot(file) {
  const bytes = await fs.promises.readFile(file);
  return {bytes, digest:crypto.createHash('sha256').update(bytes).digest('hex')};
}

/** Stream a file into SHA-256 without loading the full judgment into memory. */
export const checksum = async _filePath2 => { const _hasher=crypto.createHash('sha256'); for await (const _buffer of fs.createReadStream(_filePath2)) _hasher.update(_buffer); return _hasher.digest('hex'); };
/** Return a rejection reason for malformed or empty content; null means the supported shape is valid. */
export const sourceHtml = data => data.html ?? data.content ?? data.judgment ?? data.text;

export function checkSourceIdentity(identity, judgment, data = {}) {
  const citation = `[${identity.year}] ${identity.court} ${Number(identity.number)}`.toLowerCase();
  for (const value of [judgment.neutralCitation, data.neutralCitation, data.neutral_citation].filter(value => value != null && value !== '')) {
    if (String(value).trim().replace(/\s+/g, ' ').toLowerCase() !== citation) throw Error('Conflicting neutral citation');
  }
  const expected = `/${identity.language}/cases/${identity.court}/${identity.year}/${Number(identity.number)}`.toLowerCase();
  for (const value of [judgment.url, data.url].filter(value => value != null)) {
    const url = new URL(value, 'https://hklii.hk');
    if (!['http:', 'https:'].includes(url.protocol) || !['hklii.hk','www.hklii.hk','hklii.org','www.hklii.org'].includes(url.hostname)) throw Error('Conflicting source URL');
    const pathname = url.pathname.toLowerCase()
      .replace(/^\/eng\/hk\/cases\//, '/en/cases/').replace(/^\/chi\/hk\/cases\//, '/tc/cases/')
      .replace(/\/$/, '').replace(/\.html?$/, '');
    if (pathname !== expected) throw Error('Conflicting source URL');
  }
  if (!judgment.url && !judgment.neutralCitation) throw Error('Uncorroborated judgment identity');
}

export function validateShape(data, language) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'invalid-json-shape';
  const html = sourceHtml(data);
  if (typeof html !== 'string' || !html.trim()) return 'empty-content';
  return language && !['EN','TC'].includes(language) ? 'invalid-language' : null;
}
