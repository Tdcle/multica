-- name: GetWorkspaceKnowledge :one
SELECT * FROM workspace_knowledge WHERE workspace_id = $1;

-- name: GetKnowledgeIdentity :one
SELECT * FROM knowledge_identity WHERE instance_id = $1 AND user_id = $2;

-- name: PrepareKnowledgeIdentity :exec
INSERT INTO knowledge_identity (instance_id, user_id, user_key_ciphertext)
VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;

-- name: CompleteKnowledgeIdentity :exec
UPDATE knowledge_identity SET upstream_user_id = $3, updated_at = now()
WHERE instance_id = $1 AND user_id = $2;

-- name: ListKnowledgeBindings :many
SELECT * FROM workspace_knowledge WHERE instance_id = $1;

-- name: BindWorkspaceKnowledge :one
INSERT INTO workspace_knowledge (workspace_id, team_id, instance_id, name,
    memory_agent_id, memory_user_id, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: UnbindWorkspaceKnowledge :exec
DELETE FROM workspace_knowledge WHERE workspace_id = $1;

-- name: ListWorkspaceKnowledgeExtractions :many
SELECT * FROM knowledge_extraction WHERE workspace_id = $1
ORDER BY created_at DESC, id DESC LIMIT $2;

-- name: GetKnowledgeExtractionForWorkspace :one
SELECT * FROM knowledge_extraction WHERE id = $1 AND workspace_id = $2;

-- name: ClaimKnowledgeExtraction :one
WITH candidate AS (
    SELECT job.id FROM knowledge_extraction job
    JOIN agent_memory m ON m.id=job.memory_id AND m.status='ready'
    WHERE ((job.status IN ('pending', 'submitted') AND job.available_at <= now())
       OR (job.status = 'processing' AND job.lease_until < now()))
    ORDER BY job.created_at, job.id
    FOR UPDATE OF job SKIP LOCKED FOR SHARE OF m SKIP LOCKED LIMIT 1
)
UPDATE knowledge_extraction AS job
SET status = 'processing',
    lease_until = now() + interval '10 minutes', lease_token = gen_random_uuid(), updated_at = now()
FROM candidate WHERE job.id = candidate.id RETURNING job.*;

-- name: SaveKnowledgeExtractionPayload :one
UPDATE knowledge_extraction SET source_payload = $3, updated_at = now()
WHERE id = $1 AND lease_token = $2 AND status = 'processing' RETURNING *;

-- name: FinishKnowledgeExtraction :one
UPDATE knowledge_extraction SET status = $3, upstream_result = $4,
    last_error = $5, available_at = $6, attempts = attempts + CASE WHEN $5::text IS NULL THEN 0 ELSE 1 END,
    lease_until = NULL, lease_token = NULL, updated_at = now()
WHERE id = $1 AND lease_token = $2 AND status = 'processing' RETURNING *;

-- name: RetryKnowledgeExtraction :one
UPDATE knowledge_extraction SET status = 'pending', available_at = now(),
    last_error = NULL, attempts = 0, updated_at = now(),
    upstream_result = coalesce(upstream_result, '{}'::jsonb) ||
      jsonb_build_object('retry_failed_skills', true, 'retry_id', gen_random_uuid()::text)
WHERE knowledge_extraction.id = $1 AND knowledge_extraction.workspace_id = $2 AND knowledge_extraction.status = 'failed' AND EXISTS (SELECT 1 FROM agent_memory_binding b WHERE b.memory_id=knowledge_extraction.memory_id AND b.agent_id=knowledge_extraction.agent_id AND b.created_at=knowledge_extraction.binding_created_at) RETURNING *;

-- name: DeleteKnowledgeForWorkspace :exec
DELETE FROM knowledge_extraction WHERE workspace_id = $1;

-- name: DeleteKnowledgeForIssue :exec
DELETE FROM knowledge_extraction WHERE workspace_id = $1 AND issue_id = $2;

-- name: ListKnowledgeSourceTasks :many
SELECT task.* FROM agent_task_queue task
JOIN issue ON issue.id = task.issue_id
WHERE task.issue_id = $1 AND task.created_at <= $2 AND issue.workspace_id = $3 AND task.agent_id = $4
ORDER BY task.created_at, task.id;

-- name: ListKnowledgeSourceComments :many
SELECT id, author_type, author_id, content, created_at FROM comment
WHERE issue_id = $1 AND created_at <= $2 AND workspace_id = $3
ORDER BY created_at, id;

-- name: SaveKnowledgeExtractionReceipt :exec
UPDATE knowledge_extraction SET upstream_result = $3, updated_at = now()
WHERE id = $1 AND lease_token = $2 AND status = 'processing';

-- name: GetKnowledgeWriterIdentity :one
SELECT * FROM knowledge_identity
WHERE instance_id = $1 AND upstream_user_id = $2 LIMIT 1;
