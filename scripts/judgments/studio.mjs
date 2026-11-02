#!/usr/bin/env node
import { spawn } from 'node:child_process';

const url=new URL(process.env.DATABASE_URL??'');
url.searchParams.set('options','-c default_transaction_read_only=on');
const child=spawn('pnpm',['exec','drizzle-kit','studio','--config','drizzle.config.ts','--host','127.0.0.1','--port','4983'],{
 stdio:'inherit',env:{...process.env,DRIZZLE_DATABASE_URL:url.href},
});
child.on('error',()=>{console.error('Unable to start Drizzle Studio');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
