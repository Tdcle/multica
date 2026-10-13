-- Persist the event in the same transaction as the status transition. This
-- covers API, batch, CLI, and integration writes without a lossy event bus.
CREATE OR REPLACE FUNCTION enqueue_issue_knowledge() RETURNS trigger AS $$
DECLARE
    previous_category text;
    next_category text;
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;
    SELECT category INTO previous_category FROM issue_status
        WHERE workspace_id = OLD.workspace_id AND key = OLD.status;
    SELECT category INTO next_category FROM issue_status
        WHERE workspace_id = NEW.workspace_id AND key = NEW.status;
    IF COALESCE(next_category, NEW.status) = 'done'
        AND COALESCE(previous_category, OLD.status) <> 'done' THEN
        INSERT INTO knowledge_extraction (
            workspace_id, issue_id, issue_revision, instance_id, team_id,
            memory_agent_id, memory_user_id, issue_snapshot
        )
        SELECT NEW.workspace_id, NEW.id, NEW.revision, k.instance_id, k.team_id,
            k.memory_agent_id, k.memory_user_id,
            jsonb_build_object('id', NEW.id, 'number', NEW.number,
                'title', NEW.title, 'description', NEW.description,
                'project_id', NEW.project_id, 'assignee_type', NEW.assignee_type,
                'assignee_id', NEW.assignee_id, 'revision', NEW.revision)
        FROM workspace_knowledge k WHERE k.workspace_id = NEW.workspace_id
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER issue_knowledge_completion
AFTER UPDATE OF status ON issue
FOR EACH ROW EXECUTE FUNCTION enqueue_issue_knowledge();
