import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function workBuddyLaunchFile(env=process.env) {
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),'beautiCode','hosts','workbuddy','startup.lock');
}
export function workBuddyLaunchActive(file=workBuddyLaunchFile()) {
  let lease;
  try {
    lease=JSON.parse(fs.readFileSync(file,'utf8'));
  } catch {
    // Exclusive creation precedes the owner record. Do not reclaim a newly
    // created file while another launcher is still writing it.
    try { return Date.now()-fs.statSync(file).mtimeMs<180_000; } catch { return false; }
  }
  if (lease.schema!=='beauticode.wb-launch/v1' || !Number.isInteger(lease.pid) || lease.pid<1 ||
    !Number.isFinite(lease.startedAt) || Date.now()<lease.startedAt || Date.now()-lease.startedAt>180_000) return false;
  try {process.kill(lease.pid,0);return true;} catch {return false;}
}
export async function withWorkBuddyLaunch(operation,file=workBuddyLaunchFile()) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const token=crypto.randomUUID();
  let acquired=false;
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const handle=fs.openSync(file,'wx');
      try {fs.writeFileSync(handle,JSON.stringify({schema:'beauticode.wb-launch/v1',pid:process.pid,startedAt:Date.now(),token}));acquired=true;}
      finally {fs.closeSync(handle);}
      break;
    } catch(error) {
      if(error.code!=='EEXIST')throw error;
      if(workBuddyLaunchActive(file)||attempt===1)throw Object.assign(new Error('WB_LAUNCH_IN_PROGRESS'),{code:'WB_LAUNCH_IN_PROGRESS'});
      fs.rmSync(file,{force:true});
    }
  }
  if(!acquired)throw new Error('WB_LAUNCH_IN_PROGRESS');
  try {return await operation();}
  finally {
    try {if(JSON.parse(fs.readFileSync(file,'utf8')).token===token) fs.rmSync(file,{force:true});} catch {}
  }
}
