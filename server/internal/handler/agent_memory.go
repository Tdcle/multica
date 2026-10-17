package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type memoryResponse struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Status        string   `json:"status"`
	Error         *string  `json:"error"`
	AgentID       *string  `json:"agent_id"`
	AgentIDs      []string `json:"agent_ids"`
	NativeAgentID string   `json:"native_agent_id"`
	CreatedAt     string   `json:"created_at"`
}

func memoryToResponse(memory db.AgentMemory, agentIDs []pgtype.UUID) memoryResponse {
	var issue *string
	if memory.LastError.Valid {
		value := memory.LastError.String
		issue = &value
	}
	var bound *string
	ids := make([]string, 0, len(agentIDs))
	for _, id := range agentIDs {
		ids = append(ids, uuidToString(id))
	}
	if len(ids) > 0 {
		bound = &ids[0]
	}
	return memoryResponse{ID: uuidToString(memory.ID), Name: memory.Name, Status: memory.Status, Error: issue, AgentID: bound, AgentIDs: ids, NativeAgentID: memory.NativeAgentID, CreatedAt: memory.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00")}
}

func (h *Handler) memoryManager(w http.ResponseWriter, r *http.Request, memory db.AgentMemory) bool {
	if uuidToString(memory.OwnerID) == requestUserID(r) {
		return true
	}
	_, ok := h.requireWorkspaceRole(w, r, uuidToString(memory.WorkspaceID), "memory not found", "owner", "admin")
	return ok
}

func (h *Handler) loadMemory(w http.ResponseWriter, r *http.Request) (db.AgentMemory, bool) {
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "memoryId"), "memory_id")
	if !ok {
		return db.AgentMemory{}, false
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok = h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return db.AgentMemory{}, false
	}
	memory, err := h.Queries.GetAgentMemory(r.Context(), db.GetAgentMemoryParams{ID: id, WorkspaceID: parseUUID(workspaceID)})
	if err != nil {
		writeError(w, 404, "memory not found")
		return memory, false
	}
	return memory, h.memoryManager(w, r, memory)
}

func (h *Handler) ListAgentMemories(w http.ResponseWriter, r *http.Request) {
	if isMachineCredentialActor(r) {
		writeError(w, 403, "memory management requires a human account")
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	member, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found")
	if !ok {
		return
	}
	if h.Knowledge != nil {
		user, err := h.Queries.GetUser(r.Context(), parseUUID(requestUserID(r)))
		if err != nil {
			writeError(w, 500, "failed to read account")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		err = h.Knowledge.SyncMemoryCatalog(ctx, parseUUID(workspaceID), user, member.Role)
		cancel()
		if err != nil {
			// Keep durable pending memories available during a native outage.
			slog.Warn("sync native memory catalog", "workspace_id", workspaceID, "error", err)
		}
	}
	rows, err := h.Queries.ListAgentMemories(r.Context(), db.ListAgentMemoriesParams{WorkspaceID: parseUUID(workspaceID), IsAdmin: member.Role == "owner" || member.Role == "admin", ReaderID: parseUUID(requestUserID(r))})
	if err != nil {
		writeError(w, 500, "failed to list memories")
		return
	}
	result := []memoryResponse{}
	for _, row := range rows {
		result = append(result, memoryToResponse(row.AgentMemory, row.BoundAgentIds))
	}
	writeJSON(w, 200, result)
}

func (h *Handler) CreateAgentMemory(w http.ResponseWriter, r *http.Request) {
	if isMachineCredentialActor(r) {
		writeError(w, 403, "memory management requires a human account")
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&input) != nil {
		writeError(w, 400, "invalid memory request")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len([]rune(input.Name)) > 120 {
		writeError(w, 400, "memory name must contain 1 to 120 characters")
		return
	}
	memory, err := h.Queries.CreateAgentMemory(r.Context(), db.CreateAgentMemoryParams{WorkspaceID: parseUUID(workspaceID), Name: input.Name, OwnerID: parseUUID(requestUserID(r))})
	if err != nil {
		writeError(w, 500, "failed to create memory")
		return
	}
	writeJSON(w, 201, memoryToResponse(memory, nil))
}

func (h *Handler) GetAgentMemory(w http.ResponseWriter, r *http.Request) {
	if isMachineCredentialActor(r) {
		writeError(w, 403, "memory management requires a human account")
		return
	}
	agent, ok := h.loadAgentForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	row, err := h.Queries.GetAgentMemoryBinding(r.Context(), db.GetAgentMemoryBindingParams{WorkspaceID: agent.WorkspaceID, AgentID: agent.ID})
	var memory *memoryResponse
	if err == nil {
		value := memoryToResponse(row.AgentMemory, row.BoundAgentIds)
		memory = &value
	} else if !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 500, "failed to read memory binding")
		return
	}
	writeJSON(w, 200, map[string]any{"configured": h.Knowledge != nil, "binding": memory})
}

func (h *Handler) BindAgentMemory(w http.ResponseWriter, r *http.Request) {
	if isMachineCredentialActor(r) {
		writeError(w, 403, "memory management requires a human account")
		return
	}
	agent, ok := h.loadAgentForUser(w, r, chi.URLParam(r, "id"))
	if !ok || !h.canManageAgent(w, r, agent) {
		return
	}
	if agent.ArchivedAt.Valid {
		writeError(w, 409, "restore the agent before binding memory")
		return
	}
	var input struct {
		MemoryID json.RawMessage `json:"memory_id"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&input) != nil {
		writeError(w, 400, "invalid binding request")
		return
	}
	if len(input.MemoryID) == 0 {
		writeError(w, 400, "memory_id is required; use null to detach")
		return
	}
	var next pgtype.UUID
	if string(input.MemoryID) != "null" {
		var memoryID string
		if json.Unmarshal(input.MemoryID, &memoryID) != nil {
			writeError(w, 400, "memory_id must be a UUID or null")
			return
		}
		next, ok = parseUUIDOrBadRequest(w, memoryID, "memory_id")
		if !ok {
			return
		}
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "failed to begin binding change")
		return
	}
	defer tx.Rollback(r.Context())
	q := h.Queries.WithTx(tx)
	// Serialize lifecycle changes for the same Multica agent, including first bind.
	if _, err = tx.Exec(r.Context(), "SELECT 1 FROM agent WHERE id=$1 AND workspace_id=$2 FOR UPDATE", agent.ID, agent.WorkspaceID); err != nil {
		writeError(w, 500, "failed to lock agent")
		return
	}
	old, err := q.LockAgentMemoryBinding(r.Context(), db.LockAgentMemoryBindingParams{WorkspaceID: agent.WorkspaceID, AgentID: agent.ID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 500, "failed to read binding")
		return
	}
	if next.Valid {
		memory, e := q.LockAgentMemory(r.Context(), db.LockAgentMemoryParams{ID: next, WorkspaceID: agent.WorkspaceID})
		if e != nil {
			writeError(w, 404, "memory not found")
			return
		}
		if !h.memoryManager(w, r, memory) {
			return
		}
		// Binding delegates this memory to the agent's callers. Workspace admin
		// inventory access alone cannot delegate somebody else's private memory
		// to an agent owned by a different person.
		if memory.OwnerID != parseUUID(requestUserID(r)) && memory.OwnerID != agent.OwnerID {
			writeError(w, 403, "memory owner must authorize this binding")
			return
		}
		if memory.Status != "ready" && memory.Status != "pending" {
			writeError(w, 409, "memory is unavailable")
			return
		}
		if memory.Status == "ready" {
			if h.Knowledge == nil {
				writeError(w, 503, "memory service is unavailable")
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
			available, err := h.Knowledge.NativeMemoryAvailable(ctx, memory)
			cancel()
			if err != nil {
				writeError(w, 503, "could not verify memory availability")
				return
			}
			if !available {
				writeError(w, 409, "memory was removed from the native console; refresh the list")
				return
			}
		}
	}
	if next.Valid && old.MemoryID == next {
		writeJSON(w, 200, map[string]any{"updated": true})
		return
	}
	if err = q.UnbindAgentMemory(r.Context(), db.UnbindAgentMemoryParams{WorkspaceID: agent.WorkspaceID, AgentID: agent.ID}); err != nil {
		writeError(w, 500, "failed to detach memory")
		return
	}
	if next.Valid {
		if err = q.BindAgentMemory(r.Context(), db.BindAgentMemoryParams{WorkspaceID: agent.WorkspaceID, AgentID: agent.ID, MemoryID: next}); err != nil {
			writeError(w, 500, "failed to bind memory")
			return
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "failed to save memory binding")
		return
	}
	writeJSON(w, 200, map[string]any{"updated": true})
}

func (h *Handler) DeleteAgentMemory(w http.ResponseWriter, r *http.Request) {
	if isMachineCredentialActor(r) {
		writeError(w, 403, "memory management requires a human account")
		return
	}
	memory, ok := h.loadMemory(w, r)
	if !ok {
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "failed to begin memory deletion")
		return
	}
	defer tx.Rollback(r.Context())
	q := h.Queries.WithTx(tx)
	// Binding first is the same lock order as completion and agent lifecycle changes.
	if _, err = tx.Exec(r.Context(), "SELECT 1 FROM agent_memory_binding WHERE memory_id=$1 AND workspace_id=$2 FOR UPDATE", memory.ID, memory.WorkspaceID); err != nil {
		writeError(w, 500, "failed to lock memory binding")
		return
	}
	if memory, err = q.LockAgentMemory(r.Context(), db.LockAgentMemoryParams{ID: memory.ID, WorkspaceID: memory.WorkspaceID}); err != nil {
		writeError(w, 404, "memory not found")
		return
	}
	if memory.LeaseUntil.Valid && memory.LeaseUntil.Time.After(time.Now()) {
		writeError(w, 409, "memory provisioning or deletion is running; retry after it finishes")
		return
	}
	busy, err := q.HasActiveMemoryExtractions(r.Context(), memory.ID)
	if err != nil {
		writeError(w, 500, "failed to read extraction state")
		return
	}
	if busy {
		writeError(w, 409, "memory extraction is running; retry after it finishes")
		return
	}
	if err = q.CancelMissingMemoryExtractions(r.Context(), memory.ID); err == nil {
		err = q.UnbindMemory(r.Context(), db.UnbindMemoryParams{WorkspaceID: memory.WorkspaceID, MemoryID: memory.ID})
	}
	if err == nil {
		err = q.MarkAgentMemoryDeleting(r.Context(), db.MarkAgentMemoryDeletingParams{ID: memory.ID, WorkspaceID: memory.WorkspaceID})
	}
	if err != nil {
		writeError(w, 500, "failed to queue memory deletion")
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "failed to save memory deletion")
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (h *Handler) RetryAgentMemory(w http.ResponseWriter, r *http.Request) {
	if isMachineCredentialActor(r) {
		writeError(w, 403, "memory management requires a human account")
		return
	}
	memory, ok := h.loadMemory(w, r)
	if !ok {
		return
	}
	_, err := h.Queries.RetryAgentMemory(r.Context(), db.RetryAgentMemoryParams{ID: memory.ID, WorkspaceID: memory.WorkspaceID})
	if err != nil {
		writeError(w, 409, "memory does not need retry")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
