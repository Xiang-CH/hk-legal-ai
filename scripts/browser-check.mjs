import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Create an isolated browser profile/session without inherited browser attachment or auth settings; close removes the temporary profile. */
export function createBrowserCheck(prefix) {
 const profile=mkdtempSync(path.join(tmpdir(),`${prefix}-`));
 const session=path.basename(profile);
 // Never inherit a persistent profile, attached browser, saved auth state or session.
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));
 env.AGENT_BROWSER_PROFILE=profile;
 const browser=args=>execFileSync('agent-browser',['--session',session,'--profile',profile,...args],{encoding:'utf8',env});
 const close=()=>{try{browser(['close']);}finally{rmSync(profile,{recursive:true,force:true});}};
 return {browser,close};
}
