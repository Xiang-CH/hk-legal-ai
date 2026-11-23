#!/usr/bin/env node
import {createBrowserCheck} from './browser-check.mjs';
const url=new URL(process.env.CHAT_LAYOUT_URL??'http://localhost:3210/clic-chat-hkulaw/c');
if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Local test app required');
const {browser,close}=createBrowserCheck('clic-stream');
try{
 browser(['set','viewport','390','844']);browser(['open',url.href]);
 const messages=Array.from({length:16},(_,i)=>({id:`saved-${i}`,role:i%2?'assistant':'user',parts:[{type:'text',text:`Previous message ${i}. `+'Long conversation content. '.repeat(30)}]}));
 browser(['eval',`localStorage.setItem('clic-chat:conversations:v1',JSON.stringify([{id:'stream-test',title:'Stream test',createdAt:1,updatedAt:1}]));localStorage.setItem('clic-chat:messages:stream-test:v1',${JSON.stringify(JSON.stringify(messages))})`]);
 url.searchParams.set('sessionId','stream-test');browser(['open',url.href]);browser(['wait','--text','Previous message 15.']);
 // The response is generated entirely in the browser; no provider/network request is made.
 browser(['eval',`window.fetch=async()=>new Response(new ReadableStream({start(controller){
 const encoder=new TextEncoder();const emit=part=>controller.enqueue(encoder.encode('data: '+JSON.stringify(part)+'\\n\\n'));
 emit({type:'start',messageId:'streamed-answer'});emit({type:'text-start',id:'answer'});
 let index=0;window.releaseStream=()=>{emit({type:'text-end',id:'answer'});emit({type:'finish'});controller.enqueue(encoder.encode('data: [DONE]\\n\\n'));controller.close();};
 window.streamTick=setInterval(()=>{emit({type:'text-delta',id:'answer',delta:'Streamed passage '+(++index)+'. Long answer text grows over several viewport heights.\\n\\n'});window.streamCount=index;if(index>=100){clearInterval(window.streamTick);window.releaseStream();}},100);
 }}),{headers:{'Content-Type':'text/event-stream','x-vercel-ai-ui-message-stream':'v1'}})`]);
 browser(['fill','textarea','Continue with a longer answer']);
 browser(['press','Enter']);
 browser(['wait','--fn','window.streamCount >= 15']);
 process.stdout.write(browser(['eval',`(() => {const v=document.querySelector('[data-radix-scroll-area-viewport]');const gap=v.scrollHeight-v.clientHeight-v.scrollTop;if(gap>80)throw Error('Streaming did not follow bottom: '+gap);v.scrollTop-=250;window.manualScrollTop=v.scrollTop;return {followingGap:gap,manualScrollTop:v.scrollTop};})()`]));
 browser(['wait','--fn','window.streamCount >= 25']);
 process.stdout.write(browser(['eval',`(() => {const v=document.querySelector('[data-radix-scroll-area-viewport]');if(Math.abs(v.scrollTop-window.manualScrollTop)>30)throw Error('Manual scroll was overridden');v.scrollTop=v.scrollHeight;return 'Manual scroll preserved';})()`]));
 browser(['wait','--fn','window.streamCount >= 35']);
 process.stdout.write(browser(['eval',`(() => {const v=document.querySelector('[data-radix-scroll-area-viewport]');const gap=v.scrollHeight-v.clientHeight-v.scrollTop;if(gap>80)throw Error('Follow did not resume: '+gap);clearInterval(window.streamTick);window.releaseStream();return 'Follow resumed at bottom';})()`]));
}catch(error){process.stderr.write(browser(['eval',`({count:window.streamCount,text:document.body.innerText.slice(-1500),inputs:[...document.querySelectorAll('textarea')].map(e=>({value:e.value,placeholder:e.placeholder})),forms:document.forms.length})`]));throw error;}finally{close();}
