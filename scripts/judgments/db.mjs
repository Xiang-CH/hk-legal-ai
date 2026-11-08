import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checksum } from './source.mjs';
/** Validate the explicit target and backup/restore evidence before writes. Only local disposable databases may bypass a backup. */
export async function verifyWriteAccess({ apply = false, testDatabase = false, ackBackup,allowProduction=false,restoreReceipt,acceptAzureAiOmission=false,databaseUrl = process.env.JUDGMENT_DATABASE_URL } = {}) {
  if (!databaseUrl) throw new Error('JUDGMENT_DATABASE_URL is required; .env is not loaded');
  const url = new URL(databaseUrl);
  if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('PostgreSQL URL required');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const name = decodeURIComponent(url.pathname.slice(1));
  if (apply) {
    const local=['localhost','127.0.0.1','::1'].includes(host);
    if(!local&&!allowProduction)throw Error('Remote writes require explicit --allow-production');
    if (testDatabase) {
      if(!local)throw Error('Disposable test bypass is restricted to localhost');
      if (!/^clic_judgment_test_[a-z0-9_]+$/i.test(name)) throw new Error('Disposable database name required');
    } else {
      if (!ackBackup) throw new Error('--ack-backup manifest path required');
      const manifest = JSON.parse(await readFile(ackBackup, 'utf8'));
      if (manifest.source !== `${host}:${url.port || '5432'}/${name.toLowerCase()}` || !/^[a-f0-9]{64}$/.test(manifest.sha256) || path.basename(manifest.archive) !== manifest.archive) throw new Error('Invalid backup manifest');
      if (await checksum(path.resolve(path.dirname(ackBackup), manifest.archive)) !== manifest.sha256) throw new Error('Backup checksum mismatch');
      if(!local){
        if(!restoreReceipt)throw Error('A verified application-data restore receipt is required');
        const receipt=JSON.parse(await readFile(restoreReceipt,'utf8'));
        if(receipt.archiveSha256!==manifest.sha256||receipt.source!==manifest.source||receipt.applicationDataRestored!==true||receipt.strictTransactionalRestore!==true||receipt.target===manifest.source||!receipt.tables||!Number.isSafeInteger(receipt.tables.Judgment)||receipt.tables.Judgment<1)throw Error('Restore receipt does not verify this backup');
        const omissions=receipt.omittedExtensions??[];
        if(omissions.some(extension=>extension!=='azure_ai')||(omissions.length&&!acceptAzureAiOmission))throw Error('Restore extension omission requires explicit acceptance');
      }
    }
  }
  return databaseUrl;
}
