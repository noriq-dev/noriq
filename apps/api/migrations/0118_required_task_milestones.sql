-- Give legacy projects a Backlog before assigning their unplaced tasks.
INSERT INTO milestones (id, project_id, title, "order")
SELECT 'ms_' || lower(hex(randomblob(16))), p.id, 'Backlog', 0
FROM projects p
WHERE NOT EXISTS (SELECT 1 FROM milestones m WHERE m.project_id = p.id);

UPDATE tasks
SET milestone_id = (
  SELECT m.id FROM milestones m WHERE m.project_id = tasks.project_id
  ORDER BY CASE WHEN m.title = 'Backlog' THEN 0 ELSE 1 END, m."order", m.id LIMIT 1
)
WHERE milestone_id IS NULL;

CREATE TRIGGER task_milestone_required_insert
BEFORE INSERT ON tasks
WHEN NEW.milestone_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'every task needs a milestone');
END;

CREATE TRIGGER task_milestone_required_update
BEFORE UPDATE OF milestone_id ON tasks
WHEN NEW.milestone_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'every task needs a milestone');
END;
