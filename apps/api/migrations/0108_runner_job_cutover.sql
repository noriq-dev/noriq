-- PLNR-502: hard-cut execution to RunnerJob protocol v2.
--
-- Legacy Run/mission rows remain queryable, but no live legacy authority may survive
-- deployment of the cutover. Settle the finite set of in-flight rows before the API and
-- WebSocket write paths begin refusing legacy frames.

UPDATE claims
   SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE released_at IS NULL
   AND EXISTS (
     SELECT 1 FROM runs r
      WHERE r.status IN ('queued','dispatched','running','blocked')
        AND r.anchor_type = 'task' AND r.anchor_id = claims.task_id
        AND r.agent_id = claims.agent_id
   );

UPDATE file_locks
   SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE released_at IS NULL
   AND EXISTS (
     SELECT 1 FROM runs r
      WHERE r.status IN ('queued','dispatched','running','blocked')
        AND r.anchor_type = 'task' AND r.anchor_id = file_locks.task_id
        AND r.agent_id = file_locks.agent_id
   );

UPDATE tasks
   SET status = 'todo', claimed_by = NULL, claim_expires_at = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status = 'in_progress'
   AND EXISTS (
     SELECT 1 FROM runs r
      WHERE r.status IN ('queued','dispatched','running','blocked')
        AND r.anchor_type = 'task' AND r.anchor_id = tasks.id
        AND r.agent_id = tasks.claimed_by
   );

UPDATE orchestrations
   SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status IN ('pending','running','parked')
   AND id IN (
     SELECT en.orchestration_id FROM execution_nodes en JOIN runs r ON r.id = en.run_id
      WHERE r.status IN ('queued','dispatched','running','blocked')
   );

UPDATE execution_nodes
   SET status = 'cancelled', outcome_reason = 'cancelled by RunnerJob protocol cutover',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status IN ('pending','running','parked')
   AND run_id IN (SELECT id FROM runs WHERE status IN ('queued','dispatched','running','blocked'));

UPDATE plan_dispatches
   SET status = 'cancelled', stall_reason = 'cancelled by RunnerJob protocol cutover',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status IN ('active','stalled');

UPDATE runs
   SET status = 'cancelled', phase = NULL, reconciliation_pending = 0, reconciliation_deadline = NULL,
       exit = json_object(
         'outcome', 'cancelled', 'code', NULL, 'signal', NULL,
         'reason', 'cancelled by RunnerJob protocol cutover',
         'finishedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status IN ('queued','dispatched','running','blocked');
