import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button } from './ui';

export function ValidationPolicySettings({projectId,canContribute}:{projectId:string;canContribute:boolean}) {
  const [mode,setMode]=useState<'legacy'|'strict'|null>(null);
  const [reason,setReason]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{let live=true; api.validationPolicy(projectId).then(p=>{if(live)setMode(p.mode);}).catch(e=>{if(live)setMessage(String(e));});return()=>{live=false;};},[projectId]);
  return <section aria-label="Validation policy" style={{padding:20,border:'1px solid var(--w-07)',borderRadius:14}}>
    <h3>Validation policy</h3>
    <p>Current policy: {mode ?? 'loading'}. Strict mode requires readiness before work and separate implementation evidence before completion. Unverified backlog creation remains available.</p>
    <p>Enabling strict mode releases all agent claims and task locks. Holders must stop implementation, reassess and reclaim. Disabling it preserves independently required plan evidence.</p>
    {canContribute && mode && <form onSubmit={async e=>{e.preventDefault();setBusy(true);setMessage('');try {
      const result=await api.setValidationPolicy(projectId,mode==='strict'?'legacy':'strict',reason);
      setMode(result.mode);setReason('');setMessage(`Policy saved. Released ${result.releasedTaskIds.length} claims${result.releasedTaskIds.length ? ': '+result.releasedTaskIds.join(', ') : ''}.`);
    }catch(err){setMessage(err instanceof Error?err.message:String(err));}finally{setBusy(false);}}}>
      <label>Reason for changing policy <textarea required minLength={10} maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)} /></label>
      <Button type="submit" disabled={busy}>{mode==='strict'?'Use legacy policy':'Enable strict policy'}</Button>
    </form>}
    {message && <p role="status">{message}</p>}
    <small>Evidence is actor-reported. Noriq checks recorded context and workflow compliance; it does not establish whether a cited test proves its claim.</small>
  </section>;
}
