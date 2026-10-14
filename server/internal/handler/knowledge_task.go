package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
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
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	workspaceID := parseUUID(resp.WorkspaceID)
	memory, err := h.Queries.GetAgentMemoryBinding(ctx, db.GetAgentMemoryBindingParams{WorkspaceID: workspaceID, AgentID: task.AgentID})
	if errors.Is(err, pgx.ErrNoRows) {
		return
	}
	if err != nil {
		slog.Warn("task memory binding unavailable", "task_id", uuidToString(task.ID))
		return
	}
	if memory.AgentMemory.Status != "ready" {
		return
	}
	binding := knowledge.MemoryBinding(memory.AgentMemory)
	resp.KnowledgeAvailable = true
	query := strings.Join([]string{resp.TriggerCommentContent, resp.ChatMessage, resp.QuickCreatePrompt, resp.AutopilotTitle, resp.AutopilotDescription}, "\n")
	if task.IssueID.Valid {
		issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: task.IssueID, WorkspaceID: workspaceID})
		if err != nil {
			return
		}
		query = issue.Title + "\n" + issue.Description.String + "\n" + query
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return
	}
	if runes := []rune(query); len(runes) > 2048 {
		query = string(runes[:2048])
	}
	retrieval, err := h.Knowledge.Retrieve(ctx, binding, nil, query, "")
	if err != nil {
		var upstream *knowledge.UpstreamError
		if errors.As(err, &upstream) {
			slog.Warn("task knowledge recall unavailable", "task_id", uuidToString(task.ID), "upstream_path", upstream.Path, "upstream_status", upstream.Status)
		} else {
			slog.Warn("task knowledge recall unavailable", "task_id", uuidToString(task.ID))
		}
		return
	}
	// Preserve each engine's ranking while making room for every knowledge type.
	// Raw engine scores cannot be compared across BM25 and graph search.
	memories := []knowledge.Memory{}
	for _, kind := range []string{"chat_memory", "skill", "llm_wiki", "code_graph"} {
		count := 0
		for _, item := range retrieval.Items {
			if item.AssetType == kind && count < 3 {
				memories = append(memories, item)
				count++
			}
		}
	}
	if len(memories) == 0 {
		return
	}
	for i := range memories {
		if runes := []rune(memories[i].Content); len(runes) > 1600 {
			memories[i].Content = string(runes[:1600]) + "…"
		}
		if runes := []rune(memories[i].Background); len(runes) > 400 {
			memories[i].Background = string(runes[:400]) + "…"
		}
	}
	// Keep a bounded prompt. Search tools expose the full results and warnings.
	if len(memories) > 12 {
		memories = memories[:12]
	}
	encoded, err := json.Marshal(memories)
	if err == nil {
		resp.KnowledgeContext = "```json\n" + string(encoded) + "\n```"
	}
}
