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
  return { court, year: Number.isFinite(year) ? year : null, number: number ?? _fileMatch?.[1] ?? null,
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
/** Stream a file into SHA-256 without loading the full judgment into memory. */
export const checksum = async _filePath2 => { const _hasher=crypto.createHash('sha256'); for await (const _buffer of fs.createReadStream(_filePath2)) _hasher.update(_buffer); return _hasher.digest('hex'); };
/** Return a rejection reason for malformed or empty content; null means the supported shape is valid. */
export function validateShape(data, language) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'invalid-json-shape';
  const html = data.html ?? data.content ?? data.judgment ?? data.text;
  if (typeof html !== 'string' || !html.trim()) return 'empty-content';
  return language && !['EN','TC'].includes(language) ? 'invalid-language' : null;
}
