import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import { validateShape } from './source.mjs';
import { parseJudgment } from './parse.mjs';
import { buildChunks } from './chunks.mjs';

if(!parentPort)throw Error('Estimator worker must run in a worker thread');
const billing=getEncoding('cl100k_base');
parentPort.on('message',async({file,identity,matches})=>{
 const row={sourcePath:identity.path,status:'rejected'};
 try{
  const source=await readFile(file);
  row.checksum=createHash('sha256').update(source).digest('hex');
  row.sourceBytes=source.length;
  if(matches.length!==1)throw Error(matches.length?'ambiguous-metadata':'missing-metadata');
  const data=JSON.parse(source.toString('utf8'));
  const invalid=validateShape(data,identity.language);if(invalid)throw Error(invalid);
  const html=data.html??data.content??data.judgment??data.text;
  const parsed=parseJudgment(html);
  const chunks=buildChunks(parsed.blocks,{neutral_citation:matches[0].neutralCitation,parties:matches[0].parties});
  Object.assign(row,{status:'estimated',judgmentId:matches[0].id,htmlBytes:Buffer.byteLength(html),plainTextBytes:Buffer.byteLength(parsed.plainText),blocks:parsed.blocks.length,numberedBlocks:parsed.blocks.filter(block=>block.label!==null).length,chunks:chunks.length,chunkingTokens:chunks.reduce((sum,chunk)=>sum+chunk.token_count,0),billableTokens:chunks.reduce((sum,chunk)=>sum+billing.encode(chunk.embedding_input).length,0)});
 }catch(error){row.reason=error instanceof SyntaxError?'invalid-json':error.message;}
 parentPort.postMessage(row);
});
