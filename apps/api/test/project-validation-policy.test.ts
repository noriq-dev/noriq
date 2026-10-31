import type { Env } from '../src/env';
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';
let agent: {id:string;apiKey:string}, cookie:string, projectId:string, milestoneId:string;
const evidence = (purpose='readiness') => ({purpose,outcome:'passed',scope:'non_code',summary:'Inspected this coordination task and its current recorded intent.',evidence:[{kind:'inspection',reference:'Task description',result:'The coordination action is consistent with current project decisions.'}]});
const call=(name:string,args:Record<string,unknown>={})=>mcpCall(agent.apiKey,name,{projectId,...args});
async function post(path:string,body:unknown) {
 const res=await SELF.fetch(`https://noriq.test/api/projects/${projectId}/${path}`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
 return {status:res.status,body:await res.json() as any};
}
const policy=(mode='strict')=>post('validation-policy',{mode,reason:'Enable evidence gates for this verification project.'});
async function task() {
 const r=await call('create_tasks',{tasks:[{title:'Policy test work',body:'Inspect the recorded project decisions.',milestoneId,tags:['testing']}]});
 expect(r.body.failed).toBe(0);return r.body.created[0].id as string;
}
const assess=(id:string,assessment:unknown=evidence())=>call('record_validation',{subjectType:'task',subjectId:id,assessment});
const fresh=(id:string)=>call('get_freshness',{subjectType:'task',subjectId:id});
beforeAll(async()=>{
 agent=await createAgent('strict-policy-test');cookie=await loginSession('agent-mint@example.com','longenough1');
 projectId=(await mcpCall(agent.apiKey,'create_project',{key:'VPS',name:'Validation policy tests'})).body.id;
 milestoneId=(await call('get_project')).body.milestones[0].id;
});
describe('strict project policy',()=>{
 it('defaults legacy and activation releases claims and locks idempotently',async()=>{
  const id=await task();expect((await fresh(id)).body.assessment.projectPolicy).toBe('legacy');
  expect((await call('claim_task',{taskId:id})).isError).toBeFalsy();
  await env.DB.prepare('UPDATE projects SET file_locking_enabled=1 WHERE id=?').bind(projectId).run();
  expect((await call('acquire_lock',{taskId:id,paths:['policy-test.ts'],branch:'main'})).isError).toBeFalsy();
  const r=await policy();expect(r.status).toBe(200);expect(r.body.releasedTaskIds).toContain(id);
  expect((await policy()).body.releasedTaskIds).toEqual([]);
  expect((await call('get_project')).notices).toContain('Stop implementation');
  expect(await env.DB.prepare('SELECT status,claimed_by FROM tasks WHERE id=?').bind(id).first()).toMatchObject({status:'todo',claimed_by:null});
  expect(await env.DB.prepare('SELECT id FROM file_locks WHERE task_id=? AND released_at IS NULL').bind(id).first()).toBeNull();
  expect((await call('claim_task',{taskId:id})).text).toContain('readiness_required');
  expect((await call('release_task',{taskId:id,toStatus:'done'})).isError).toBe(true);
 });
 it('allows backlog but requires separate evidence and prevents status bypass',async()=>{
  const id=await task();expect((await fresh(id)).body.assessment.required).toBe(true);
  for(const status of ['in_progress','review','done']) expect((await call('update_tasks',{tasks:[{taskId:id,set:{status}}]})).body.failed).toBe(1);
  expect((await assess(id)).isError).toBeFalsy();expect((await call('claim_task',{taskId:id})).isError).toBeFalsy();
  expect((await call('release_task',{taskId:id,toStatus:'done'})).text).toContain('Implementation evidence');
  await assess(id,evidence('implementation'));expect((await call('release_task',{taskId:id,toStatus:'done'})).isError).toBeFalsy();
 });
 it('only humans grant exceptions, including admin-owned agent credentials',async()=>{
  const id=await task(), input={subjectId:id,scope:'readiness',reason:'Emergency coordination exception.',durationSeconds:3600};
  expect((await call('record_readiness_override',input)).text).toContain('Human contributor required');
  expect((await post('readiness-overrides',input)).status).toBe(200);
  expect((await call('claim_task',{taskId:id})).isError).toBeFalsy();
 });
 it('explicit direction revokes ownership until reconciled; ordinary comments do not',async()=>{
  const id=await task();await assess(id);await call('claim_task',{taskId:id});
  const c=await call('post_comment',{taskId:id,body:'The task now targets the revised decision.'});
  expect((await env.DB.prepare('SELECT claimed_by FROM tasks WHERE id=?').bind(id).first<any>())?.claimed_by).toBe(agent.id);
  const input={taskId:id,sourceType:'comment',sourceId:c.body.id,reason:'The task must reflect the revised project decision.'};
  expect((await call('mark_changed_direction',input)).isError).toBeFalsy();await assess(id);
  expect((await call('claim_task',{taskId:id})).text).toContain('direction_changed');
  const f=(await fresh(id)).body;
  expect((await assess(id,{...evidence(),reconciliation:{directionIds:f.assessment.directionMarkers.map((m:any)=>m.id),summary:'Updated intent matches the revised decision in the comment.'}})).isError).toBeFalsy();
  expect((await call('claim_task',{taskId:id})).isError).toBeFalsy();
  expect((await call('mark_changed_direction',input)).body.alreadyMarked).toBe(true);
 });
 it('settled doc writes require assessed versions, metadata stays available',async()=>{
  expect((await call('create_doc',{name:'Unverified doc',body:'The protocol uses JSON.'})).isError).toBe(true);
  const r=await call('create_doc',{name:'Assessed doc',body:'The protocol uses JSON.',assessment:evidence('document')});expect(r.isError).toBeFalsy();const docId=r.body.id;
  expect((await call('update_doc',{docId,body:'The protocol uses CBOR.'})).isError).toBe(true);
  expect((await call('get_doc',{docId})).body.body).toBe('The protocol uses JSON.');
  expect((await call('update_doc',{docId,body:'The protocol uses CBOR.',assessment:evidence('document')})).isError).toBeFalsy();
  expect((await call('get_doc',{docId})).body.freshness.assessment.readiness.state).toBe('passed');
  expect((await call('update_doc',{docId,folder:'Contracts'})).isError).toBeFalsy();
  expect((await call('update_doc',{docId,tags:['alpha'],addTags:['beta'],removeTags:['alpha']})).isError).toBeFalsy();
  expect((await call('get_doc',{docId})).body.tags).toEqual(['beta']);
 }); it('keeps plan requirements when strict is disabled and leaves settled history intact',async()=>{
  const made=await call('create_plan',{title:'Independent plan policy',taskDefaults:{milestoneId,tags:['testing']},phases:[{title:'First',newTasks:[{title:'Plan task'}]}]});
  expect(made.isError).toBeFalsy();const id=made.body.phases[0].taskIds[0];
  await policy('legacy');expect((await fresh(id)).body.assessment.required).toBe(true);
  expect((await call('claim_task',{taskId:id})).isError).toBe(true);
  await policy();
 });
 it('accepts different starting and resulting repository revisions without retrospective readiness',async()=>{
  const id=await task();const coords={repositoryKey:'repo',branch:'main',baseId:'start'};
  await assess(id,{...evidence(),scope:'repository',...coords});
  expect((await call('claim_task',{taskId:id,...coords})).isError).toBeFalsy();
  await assess(id,{...evidence('implementation'),scope:'repository',...coords,baseId:'result'});
  expect((await call('release_task',{taskId:id,toStatus:'done',commitId:'result'})).isError).toBeFalsy();
  await policy('legacy');await policy();
  expect((await env.DB.prepare('SELECT status FROM tasks WHERE id=?').bind(id).first<any>())?.status).toBe('done');
  const history=(await fresh(id)).body.assessment;
  expect(history.readiness.record.baseId).toBe('start');expect(history.implementation.record.baseId).toBe('result');
 });
 it('marks task-linked input answers and rejects stale reconciliation IDs',async()=>{
  const id=await task();await assess(id);await call('claim_task',{taskId:id});
  const signal=await call('request_input',{taskId:id,title:'Choose the current direction',body:'Which coordination decision applies?',blocking:false});
  expect(signal.isError).toBeFalsy();
  const result=await post(`signals/${signal.body.id}/answer`,{response:'Use the revised decision.',directionReason:'The prior decision has been replaced by this answer.'});
  expect(result.status).toBe(200);
  const markers=(await fresh(id)).body.assessment.directionMarkers;expect(markers).toHaveLength(1);
  expect((await assess(id,{...evidence(),reconciliation:{directionIds:['old-id'],summary:'Reconciled the old direction marker only.'}})).isError).toBe(true);
  expect((await fresh(id)).body.assessment.directionMarkers).toHaveLength(1);
  expect((await call('heartbeat')).body.renewed ?? []).not.toContain(id);
  expect((await env.DB.prepare('SELECT claimed_by FROM tasks WHERE id=?').bind(id).first<any>())?.claimed_by).toBeNull();
 });
 it('rolls back doc version and body if evidence persistence fails',async()=>{
  const made=await call('create_doc',{name:'Atomic evidence',body:'The transport uses JSON.',assessment:evidence('document')});const docId=made.body.id;
  const before=await call('get_doc',{docId});
  await env.DB.exec("CREATE TRIGGER reject_test_evidence BEFORE INSERT ON entity_assessments WHEN json_extract(NEW.assessment_json,'$.summary') = 'Injected persistence failure' BEGIN SELECT RAISE(ABORT,'injected evidence failure'); END;");
  try {
   expect((await call('update_doc',{docId,body:'The transport uses CBOR.',assessment:{...evidence('document'),summary:'Injected persistence failure'}})).isError).toBe(true);
  } finally {await env.DB.exec('DROP TRIGGER reject_test_evidence');}
  const after=await call('get_doc',{docId});expect(after.body.body).toBe(before.body.body);expect(after.body.currentVersion).toBe(before.body.currentVersion);expect(after.body.versions).toHaveLength(before.body.versions.length);
 });
 it('keeps strict standalone unverified tasks out of claimable queues and visible in Review',async()=>{
  const id=await task();
  const queue=await call('next_claimable',{limit:100});expect(JSON.stringify(queue.body)).not.toContain(id);
  const review=await call('list_review_inbox',{cause:'readiness_required',limit:100});expect(JSON.stringify(review.body)).toContain(id);
  expect((await call('get_task_context',{taskId:id,intelligenceDetail:'none'})).body.taskFacts.freshness.assessment.required).toBe(true);
 });

 it('allows human contributors, denies viewers and bearer-only agents on policy endpoints',async()=>{
  const user=await createUser('policy-contributor@example.com','Policy Contributor','longenough1');
  const contributorCookie=await loginSession('policy-contributor@example.com','longenough1');
  await env.DB.prepare("INSERT INTO project_grants(project_id,principal_type,principal_id,role) VALUES (?,'user',?,'viewer')").bind(projectId,user.id).run();
  const send=(headers:Record<string,string>)=>SELF.fetch(`https://noriq.test/api/projects/${projectId}/validation-policy`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({mode:'strict',reason:'A contributor can manage validation policy.'})});
  expect((await send({cookie:contributorCookie})).status).toBe(403);
  await env.DB.prepare("UPDATE project_grants SET role='contributor' WHERE project_id=? AND principal_id=?").bind(projectId,user.id).run();
  expect((await send({cookie:contributorCookie})).status).toBe(200);
  expect((await send({Authorization:`Bearer ${agent.apiKey}`})).status).toBe(401);
 });
 it('cannot renew a claim revoked by concurrent policy activation',async()=>{
  await policy('legacy');const id=await task();await call('claim_task',{taskId:id});
  const bindings=env as unknown as Env;
  const room=bindings.PROJECT_ROOM.get(bindings.PROJECT_ROOM.idFromName(projectId));
  await Promise.all([policy(),room.heartbeat(projectId,{kind:'agent',id:agent.id,name:'strict-policy-test'},agent.id)]);
  expect((await room.heartbeat(projectId,{kind:'agent',id:agent.id,name:'strict-policy-test'},agent.id)).renewed).not.toContain((await call('get_task',{taskId:id})).body.task.key);
  expect(await env.DB.prepare('SELECT claimed_by,claim_expires_at FROM tasks WHERE id=?').bind(id).first()).toMatchObject({claimed_by:null,claim_expires_at:null});
 });
 it('keeps plan working drafts unrestricted and preserves failed readiness history',async()=>{
  const plan=await call('create_plan',{title:'Draft policy test',taskDefaults:{milestoneId,tags:['testing']},phases:[{title:'First',newTasks:[{title:'Draft task'}]}]});
  expect((await call('create_plan_doc',{planId:plan.body.id,name:'Open design draft',body:'TODO: discuss the remaining options.'})).isError).toBeFalsy();
  const id=plan.body.phases[0].taskIds[0];await assess(id,{...evidence(),outcome:'failed'});
  expect((await call('claim_task',{taskId:id})).isError).toBe(true);await assess(id);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM entity_assessments WHERE subject_id=?').bind(id).first<any>())?.n).toBe(2);
 });

});
