// One-off: stream-split a giant top-level JSON array file into sharded .jsonl (no full read).
// Single-pass scanner: each char is processed exactly once (chars retained across
// 1MB reads are marked scanned, never re-counted). Handles strings/escapes/UTF-8.
// Usage: node scripts/split-json.mjs <input.json> <output-prefix> [--shard=25000]
import fs from 'fs';
import { StringDecoder } from 'string_decoder';
const [input, prefix] = process.argv.slice(2);
const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(k + '=')); return m ? parseInt(m.slice(k.length + 1), 10) : d; };
const SHARD = arg('--shard', 25000);
const fd = fs.openSync(input, 'r');
const BUF = Buffer.alloc(1024 * 1024);
const decoder = new StringDecoder('utf8');
let pos = 0, bytesRead;
let bufStr = '', scanned = 0; // scanned = chars of bufStr already processed
let depth = 0, inStr = false, esc = false, objStart = -1;
let objCount = 0, shardN = 0, out = null;
const openShard = () => { out?.end(); out = fs.createWriteStream(`${prefix}.shard-${String(shardN++).padStart(4, '0')}.jsonl`); };
openShard();
while ((bytesRead = fs.readSync(fd, BUF, 0, BUF.length, pos)) > 0) {
  pos += bytesRead;
  bufStr += decoder.write(BUF.subarray(0, bytesRead));
  for (let i = scanned; i < bufStr.length; i++) {
    const ch = bufStr[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') { if (depth === 1 && ch === '{' && objStart === -1) objStart = i; depth++; }
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 1 && ch === '}' && objStart !== -1) {
        out.write(bufStr.slice(objStart, i + 1) + '\n');
        objStart = -1;
        if (++objCount % SHARD === 0) openShard();
        if (objCount % 25000 === 0) console.log(`  ${objCount} objects`);
      }
    }
  }
  if (objStart !== -1) { bufStr = bufStr.slice(objStart); objStart = 0; scanned = bufStr.length; }
  else { bufStr = ''; scanned = 0; }
}
bufStr += decoder.end();
if (bufStr.trim() !== '' && bufStr.trim() !== ']') throw new Error(`trailing garbage: ${bufStr.slice(-100)}`);
if (depth !== 0) throw new Error(`unbalanced: depth=${depth}`);
out.end();
console.log(`DONE objects=${objCount} shards=${shardN}`);
