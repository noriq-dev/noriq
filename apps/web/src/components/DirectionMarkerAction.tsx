import { useState } from 'react';
import { api } from '../api';
import { Button } from './ui';
export function DirectionMarkerAction({projectId,taskId,sourceType,sourceId}:{projectId:string;taskId:string;sourceType:'comment'|'signal';sourceId:string}) {
 const [open,setOpen]=useState(false),[reason,setReason]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 return <div>
  {!open && <Button variant="ghost" onClick={()=>setOpen(true)}>Mark changed direction</Button>}
  {open && <form onSubmit={async e=>{e.preventDefault();setBusy(true);try{await api.markChangedDirection(projectId,{taskId,sourceType,sourceId,reason});setMessage('Direction marked. Stop implementation; reconcile readiness and reclaim before resuming.');setOpen(false);}catch(err){setMessage(err instanceof Error?err.message:String(err));}finally{setBusy(false);}}}>
   <label>What changed? <textarea value={reason} onChange={e=>setReason(e.target.value)} required minLength={10} maxLength={2000}/></label>
   <p>This releases the current agent claim and task locks. Resolving the comment alone does not clear this marker.</p>
   <Button type="submit" disabled={busy}>Mark direction and release claim</Button> <Button type="button" variant="ghost" onClick={()=>setOpen(false)}>Cancel</Button>
  </form>}
  {message && <p role="status">{message}</p>}
 </div>;
}
