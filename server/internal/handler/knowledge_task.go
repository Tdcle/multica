package handler

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/knowledge"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Called only after the claim builder has verified the task's workspace.
func (h *Handler) hydrateTaskKnowledge(parent context.Context, task *db.AgentTaskQueue, resp *AgentTaskResponse) {
	if h.Knowledge == nil {
		return
	}
	resp.KnowledgeScope = "unbound"
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()
	memory, err := h.Queries.GetAgentMemoryBinding(ctx, db.GetAgentMemoryBindingParams{WorkspaceID: parseUUID(resp.WorkspaceID), AgentID: task.AgentID})
	if errors.Is(err, pgx.ErrNoRows) {
		return
	}
	if err != nil || memory.AgentMemory.Status != "ready" {
		resp.KnowledgeScope = "unavailable"
		return
	}
	resp.KnowledgeAvailable = true
	built, err := h.Knowledge.BuildTaskContext(ctx, knowledge.MemoryBinding(memory.AgentMemory), uuidToString(task.ID))
	if err != nil {
		slog.Warn("task memory context unavailable", "task_id", uuidToString(task.ID))
		resp.KnowledgeScope = "unavailable"
		built = knowledge.TaskContext{Warnings: []string{"Memory context could not be loaded. Use knowledge list/search to retry; do not assume that an empty context means no memories exist."}}
	} else {
		resp.KnowledgeScope = built.Scope
	}
	resp.KnowledgeContext = built.Prompt()
}
