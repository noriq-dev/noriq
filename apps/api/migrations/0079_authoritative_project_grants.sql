-- PLNR-338: retire projects.group_id as an authorization source.
--
-- 0078 backfilled these rows when it introduced project_grants. Repeat the reconciliation
-- idempotently at the retirement boundary so an instance cannot cross the code rollout with a
-- group-linked project created during a partial/rolling migration but no explicit grant.
INSERT INTO project_grants (project_id, principal_type, principal_id, role, source)
  SELECT id, 'group', group_id, 'contributor', 'legacy_group'
    FROM projects
   WHERE group_id IS NOT NULL
ON CONFLICT (project_id, principal_type, principal_id) DO NOTHING;

-- From this migration forward, ownership plus project_grants are authoritative. group_id remains
-- useful organizational metadata and group-link writes keep its tagged grant in sync.
