#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const session=`clic-layout-${process.pid}`;
const url=process.env.CHAT_LAYOUT_URL??'http://localhost:3210/clic-chat-hkulaw/c';
const browser=args=>execFileSync('agent-browser',['--session',session,...args],{encoding:'utf8'});
try {
 for(const [width,height] of [[390,844],[430,932],[1280,800]]){
  browser(['set','viewport',String(width),String(height)]);
  browser(['open',url]);
  const result=browser(['eval',`(() => {
   const header=document.querySelector('nav');
   const composer=document.querySelector('form');
   if(!header||!composer)throw Error('Chat layout did not render');
   const headerHeight=header.getBoundingClientRect().height;
   const composerBottom=composer.getBoundingClientRect().bottom;
   if(headerHeight<24||headerHeight>64)throw Error('Header must stay compact; actual height: '+headerHeight);
   if(Math.abs(innerHeight-composerBottom)>40)throw Error('Composer must reach the viewport bottom; actual bottom: '+composerBottom);
   if(document.documentElement.scrollWidth>innerWidth)throw Error('Page overflows horizontally');
   return {width:innerWidth,height:innerHeight,headerHeight,composerBottom};
  })()`]);
  process.stdout.write(result);
 }
} finally { browser(['close']); }
