import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class EmbeddingBudgetExceeded extends Error {
 constructor(){super('Persisted embedding budget exhausted');this.code='EMBEDDING_BUDGET_EXHAUSTED';}
}
function validate(state){
 if(state.version!==1||!['pilot','full'].includes(state.scope)||!Number.isSafeInteger(state.tokenLimit)||state.tokenLimit<1||!Number.isSafeInteger(state.reservedTokens)||state.reservedTokens<0||!Number.isSafeInteger(state.observedProviderTokens)||state.observedProviderTokens<0)throw Error('Invalid embedding budget ledger');
 return state;
}
function atomicWrite(file,state){
 const temporary=`${file}.${randomUUID()}.partial`;
 try{fs.writeFileSync(temporary,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}
 finally{fs.rmSync(temporary,{force:true});}
}
export function createBudget(file,{approvedUsd,usdPerMillion,scope,initialReservedTokens=0,initialObservedTokens=0}){
 if(!Number.isFinite(approvedUsd)||approvedUsd<=0||!Number.isFinite(usdPerMillion)||usdPerMillion<=0)throw Error('Positive explicit approval and verified price required');
 const state=validate({version:1,scope,approvedUsd,usdPerMillion,tokenLimit:Math.floor(approvedUsd*1000000/usdPerMillion),reservedTokens:initialReservedTokens,observedProviderTokens:initialObservedTokens,createdAt:new Date().toISOString()});
 if(state.reservedTokens>state.tokenLimit||state.observedProviderTokens>state.reservedTokens)throw Error('Initial usage exceeds approval');
 fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true,mode:0o700});
 fs.writeFileSync(file,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});return state;
}
export function readBudget(file){return validate(JSON.parse(fs.readFileSync(file,'utf8')));}
async function updateBudget(file,change){
 const lock=`${file}.lock`;
 let descriptor;
 for(let attempt=0;attempt<100;attempt++){
  try{descriptor=fs.openSync(lock,'wx',0o600);fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,host:os.hostname()}));break;}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
 }
 if(descriptor===undefined)throw Error('Embedding budget ledger is locked; inspect owner before recovery');
 try{
  const state=readBudget(file);
  const event=change(state);
  state.updatedAt=new Date().toISOString();atomicWrite(file,state);
  fs.appendFileSync(`${file}.events.jsonl`,JSON.stringify({at:state.updatedAt,...event})+'\n',{mode:0o600});
  return state;
 }finally{fs.closeSync(descriptor);fs.rmSync(lock,{force:true});}
}
export async function reserveBudgetTokens(file,{tokens,scope,purpose}){
 if(!Number.isSafeInteger(tokens)||tokens<0)throw Error('Invalid token reservation');
 return updateBudget(file,state=>{
  if(state.scope!==scope)throw Error('Embedding scope does not match approval');
  if(state.observedProviderTokens>state.tokenLimit||state.reservedTokens+tokens>state.tokenLimit)throw new EmbeddingBudgetExceeded();
  state.reservedTokens+=tokens;
  return {kind:'reservation',tokens,purpose,scope,totalReservedTokens:state.reservedTokens};
 });
}
export async function recordProviderUsage(file,tokens){
 if(!Number.isSafeInteger(tokens)||tokens<0)throw Error('Invalid provider usage');
 const state=await updateBudget(file,current=>{current.observedProviderTokens+=tokens;return {kind:'provider-usage',tokens,totalObservedTokens:current.observedProviderTokens};});
 if(state.observedProviderTokens>state.reservedTokens)throw Error('Provider usage exceeded reservations; stop and reconcile billing');
 return state;
}
