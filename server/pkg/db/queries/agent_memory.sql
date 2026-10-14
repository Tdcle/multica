-- name: GetAgentMemory :one
SELECT * FROM agent_memory WHERE id=$1 AND workspace_id=$2;

-- name: GetAgentMemoryBinding :one
SELECT sqlc.embed(m), b.agent_id AS bound_agent_id, b.created_at AS binding_created_at
FROM agent_memory_binding b JOIN agent_memory m ON m.id=b.memory_id AND m.workspace_id=b.workspace_id
WHERE b.workspace_id=$1 AND b.agent_id=$2;

-- name: ListAgentMemories :many
SELECT sqlc.embed(m), b.agent_id AS bound_agent_id, a.name AS bound_agent_name
FROM agent_memory m LEFT JOIN agent_memory_binding b ON b.memory_id=m.id AND b.workspace_id=m.workspace_id
LEFT JOIN agent a ON a.id=b.agent_id AND a.workspace_id=m.workspace_id
WHERE m.workspace_id=$1 AND (sqlc.arg(is_admin)::boolean OR m.owner_id=sqlc.arg(reader_id))
ORDER BY m.created_at,m.id;

-- name: CreateAgentMemory :one
INSERT INTO agent_memory (workspace_id,name,owner_id) VALUES ($1,$2,$3) RETURNING *;

-- name: BindAgentMemory :exec
INSERT INTO agent_memory_binding (workspace_id,agent_id,memory_id) VALUES ($1,$2,$3);

-- name: LockAgentMemoryBinding :one
SELECT * FROM agent_memory_binding WHERE workspace_id=$1 AND agent_id=$2 FOR UPDATE;

-- name: LockAgentMemory :one
SELECT * FROM agent_memory WHERE id=$1 AND workspace_id=$2 FOR UPDATE;

-- name: UnbindAgentMemory :exec
DELETE FROM agent_memory_binding WHERE workspace_id=$1 AND agent_id=$2;

-- name: UnbindMemory :exec
DELETE FROM agent_memory_binding WHERE workspace_id=$1 AND memory_id=$2;

-- name: CancelAgentMemoryExtractions :exec
UPDATE knowledge_extraction SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now()
WHERE workspace_id=$1 AND agent_id=$2 AND status IN ('pending','processing','submitted');

-- name: HasActiveMemoryExtractions :one
SELECT EXISTS(SELECT 1 FROM knowledge_extraction WHERE memory_id=$1 AND (status IN ('processing','submitted') OR (status='pending' AND source_payload IS NOT NULL)));

-- name: MarkAgentMemoryDeleting :exec
UPDATE agent_memory SET status='deleting',available_at=now(),last_error=NULL,attempts=0,updated_at=now() WHERE id=$1 AND workspace_id=$2;

-- name: RetryAgentMemory :one
UPDATE agent_memory SET status=CASE WHEN status='deleting' THEN status ELSE 'pending' END,
    attempts=0,last_error=NULL,available_at=now(),updated_at=now()
WHERE id=$1 AND workspace_id=$2 AND status<>'ready' RETURNING *;

-- name: ClaimAgentMemoryWork :one
WITH candidate AS (
    SELECT id FROM agent_memory WHERE status IN ('pending','ready','deleting') AND available_at<=now()
    AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
)
UPDATE agent_memory m SET lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now()
FROM candidate WHERE m.id=candidate.id RETURNING m.*;

-- name: FinishAgentMemoryWork :exec
UPDATE agent_memory SET status=$3,instance_id=$4,team_id=$5,native_agent_id=$6,native_user_id=$7,
    last_error=$8,attempts=attempts+CASE WHEN $8::text IS NULL THEN 0 ELSE 1 END,
    available_at=$9,lease_until=NULL,lease_token=NULL,updated_at=now()
WHERE id=$1 AND lease_token=$2;

-- name: DeleteAgentMemory :exec
DELETE FROM agent_memory WHERE id=$1 AND workspace_id=$2 AND lease_token=$3;

-- name: DeleteMemoriesForWorkspace :exec
DELETE FROM agent_memory WHERE workspace_id=$1;

-- name: DeleteMemoryBindingsForWorkspace :exec
DELETE FROM agent_memory_binding WHERE workspace_id=$1;

-- name: CancelMissingMemoryExtractions :exec
UPDATE knowledge_extraction SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now()
WHERE memory_id=$1 AND status IN ('pending','processing','submitted');
