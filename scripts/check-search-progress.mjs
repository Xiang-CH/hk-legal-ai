#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const session=`clic-progress-${process.pid}`;
const url=new URL(process.env.CHAT_LAYOUT_URL??'http://localhost:3210/clic-chat-hkulaw/c');
if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Local test app required');
const browser=args=>execFileSync('agent-browser',['--session',session,...args],{encoding:'utf8'});
try {
 browser(['set','viewport','390','844']);
 browser(['open',url.href]);
 for(const scenario of ['short','completed','running','failed']){
  const count=scenario==='short'?4:12;
  const parts=Array.from({length:count},(_,index)=>({type:'tool-search_judgments',toolCallId:`tool-${index}`,input:{query:`query ${index}`},state:'output-available',output:{results:[]}}));
  if(scenario==='running')parts[11]={...parts[11],state:'input-available'};
  if(scenario==='failed')parts[11]={...parts[11],state:'output-error',errorText:'Test failure'};
  const messages=[{id:'user',role:'user',parts:[{type:'text',text:'Test search progress'}]},{id:'assistant',role:'assistant',parts:[...parts,{type:'text',text:'Answer remains visible'}]}];
  browser(['eval',`localStorage.setItem('clic-chat:conversations:v1',JSON.stringify([{id:'progress-test',title:'Progress test',createdAt:1,updatedAt:1}]));localStorage.setItem('clic-chat:messages:progress-test:v1',${JSON.stringify(JSON.stringify(messages))})`]);
  url.searchParams.set('sessionId','progress-test');
  browser(['open',url.href]);
  browser(['wait','--text','Answer remains visible']);
  const result=browser(['eval',`(() => {
   const toggle=[...document.querySelectorAll('button')].find(button=>button.textContent.includes('Show details'));
   const rows=()=>document.querySelectorAll('[data-pending]').length;
   if(${count}===4){if(toggle||rows()!==4)throw Error('Short progress should remain inline');return 'Short progress passed';}
   if(!toggle||toggle.getAttribute('aria-expanded')!=='false')throw Error('Long progress should start collapsed');
   if(rows()!==${scenario==='running'?1:0})throw Error('Collapsed progress should expose only the current activity');
   if(${scenario==='failed'}&&!toggle.textContent.includes('1 failed'))throw Error('Failure must remain visible in the summary');
   toggle.click();return 'Collapsed ${scenario} progress passed';
  })()`]);
  process.stdout.write(result);
  if(count>4){
   browser(['wait','--text','Hide details']);
   browser(['eval',`if(document.querySelectorAll('[data-pending]').length!==12)throw Error('Expanded progress must show every step')`]);
  }
 }
} finally {browser(['close']);}
