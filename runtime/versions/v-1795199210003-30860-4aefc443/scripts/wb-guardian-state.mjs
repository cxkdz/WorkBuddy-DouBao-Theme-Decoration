import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const WORKBUDDY_MANUAL_CODES = new Set(['WB_REPAIR_STALE','WB_REPAIR_AMBIGUOUS','WB_REPAIR_SUPPRESSED','WB_CDP_NO_TARGET']);
const snapshotKey = processes => processes.map(p=>`${p.pid}:${p.createdAtMs}`).sort().join(',');

/** Stop repair for this generation, but keep observing intentional close/reopen. */
export function createWorkBuddyRecovery({file,guardianPid}) {
  let blocked = null;
  let lastState = '';
  function write(state, fields={}) {
    const identity = JSON.stringify({state,...fields});
    if (identity === lastState) return;
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary,JSON.stringify({schema:'beauticode.wb-recovery/v1',guardianPid,updatedAt:new Date().toISOString(),state,...fields})+'\n');
      fs.renameSync(temporary,file);
      lastState=identity;
    } finally { fs.rmSync(temporary,{force:true}); }
  }
  return {
    observe(processes) {
      if (blocked && blocked === snapshotKey(processes)) return false;
      if (blocked) {blocked=null;write(processes.length?'checking':'waiting-for-launch');}
      return true;
    },
    block(reason,processes) {
      if (!WORKBUDDY_MANUAL_CODES.has(reason)) return false;
      const key=snapshotKey(processes);
      if (blocked === key) return false;
      blocked=key;
      write('manual-intervention',{reason,action:'close-and-reopen-workbuddy',processes:processes.map(p=>({pid:p.pid,createdAtMs:p.createdAtMs}))});
      return true;
    },
    connected() {blocked=null;write('ready');},
  };
}

export function readWorkBuddyIntervention(file,guardianPid,processes) {
  try {
    const record=JSON.parse(fs.readFileSync(file,'utf8'));
    if(record.schema!=='beauticode.wb-recovery/v1' || record.guardianPid!==guardianPid ||
      record.state!=='manual-intervention' || !WORKBUDDY_MANUAL_CODES.has(record.reason) ||
      !Array.isArray(record.processes) || !processes.length || snapshotKey(record.processes)!==snapshotKey(processes)) return null;
    return {state:record.state,reason:record.reason,action:'close-and-reopen-workbuddy'};
  } catch {return null;}
}
