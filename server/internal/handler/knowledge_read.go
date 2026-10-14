package handler

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/knowledge"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (h *Handler) knowledgeReadContext(w http.ResponseWriter, r *http.Request) (*db.WorkspaceKnowledge, *knowledge.Identity, bool) {
	if !h.knowledgeConfigured(w) {
		return nil, nil, false
	}
	workspaceID := h.resolveWorkspaceID(r)
	member, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found")
	if !ok {
		return nil, nil, false
	}
	binding, err := h.Queries.GetWorkspaceKnowledge(r.Context(), parseUUID(workspaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, true
	}
	if err != nil {
		h.knowledgeError(w, "read binding", err)
		return nil, nil, false
	}
	if isMachineCredentialActor(r) {
		actor, agentID := h.resolveActor(r, requestUserID(r), workspaceID)
		if actor != "agent" {
			writeError(w, 403, "agent identity required")
			return nil, nil, false
		}
		memory, err := h.Queries.GetAgentMemoryBinding(r.Context(), db.GetAgentMemoryBindingParams{WorkspaceID: binding.WorkspaceID, AgentID: parseUUID(agentID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, true
		}
		if err != nil {
			h.knowledgeError(w, "read agent memory", err)
			return nil, nil, false
		}
		if memory.AgentMemory.Status != "ready" {
			return nil, nil, true
		}
		scope := knowledge.MemoryBinding(memory.AgentMemory)
		return &scope, nil, true
	}
	if id := r.URL.Query().Get("agent_id"); id != "" {
		agent, ok := h.loadAgentForUser(w, r, id)
		if !ok {
			return nil, nil, false
		}
		memory, err := h.Queries.GetAgentMemoryBinding(r.Context(), db.GetAgentMemoryBindingParams{WorkspaceID: binding.WorkspaceID, AgentID: agent.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, true
		}
		if err != nil {
			h.knowledgeError(w, "read agent memory", err)
			return nil, nil, false
		}
		if memory.AgentMemory.Status != "ready" {
			return nil, nil, true
		}
		binding = knowledge.MemoryBinding(memory.AgentMemory)
	}
	user, err := h.Queries.GetUser(r.Context(), parseUUID(requestUserID(r)))
	if err != nil {
		h.knowledgeError(w, "read account", err)
		return nil, nil, false
	}
	identity, err := h.Knowledge.IdentityFor(r.Context(), user)
	if err == nil {
		err = h.Knowledge.SyncMember(r.Context(), binding, identity, member.Role)
	}
	if err != nil {
		h.knowledgeError(w, "prepare reader", err)
		return nil, nil, false
	}
	return &binding, &identity, true
}

func knowledgePagination(w http.ResponseWriter, r *http.Request) (int, int, bool) {
	offset, limit := 0, 100
	if value := r.URL.Query().Get("offset"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 0 {
			writeError(w, 400, "invalid offset")
			return 0, 0, false
		}
		offset = parsed
	}
	if value := r.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 100 {
			writeError(w, 400, "limit must contain 1 to 100")
			return 0, 0, false
		}
		limit = parsed
	}
	return offset, limit, true
}

func (h *Handler) ListKnowledgeAssets(w http.ResponseWriter, r *http.Request) {
	offset, limit, ok := knowledgePagination(w, r)
	if !ok {
		return
	}
	binding, identity, ok := h.knowledgeReadContext(w, r)
	if !ok {
		return
	}
	if binding == nil {
		writeJSON(w, 200, knowledge.AssetPage{Items: []knowledge.Asset{}, Limit: limit, Offset: offset})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	page, err := h.Knowledge.Assets(ctx, *binding, identity, offset, limit)
	if err != nil {
		h.knowledgeError(w, "list assets", err)
		return
	}
	writeJSON(w, 200, page)
}

func (h *Handler) RetrieveKnowledge(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" || len([]rune(query)) > 2048 {
		writeError(w, 400, "query must contain 1 to 2048 characters")
		return
	}
	kind := r.URL.Query().Get("type")
	if kind != "" && kind != "chat_memory" && kind != "skill" && kind != "wiki" && kind != "code_graph" {
		writeError(w, 400, "invalid knowledge type")
		return
	}
	binding, identity, ok := h.knowledgeReadContext(w, r)
	if !ok {
		return
	}
	if binding == nil {
		writeJSON(w, 200, knowledge.Retrieval{Items: []knowledge.Memory{}, Warnings: []knowledge.RetrievalWarning{}})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	result, err := h.Knowledge.Retrieve(ctx, *binding, identity, query, kind)
	if err != nil {
		h.knowledgeError(w, "retrieve", err)
		return
	}
	writeJSON(w, 200, result)
}

func (h *Handler) ReadKnowledgeAsset(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" || len(id) > 512 {
		writeError(w, 400, "invalid asset ID")
		return
	}
	ref, query, layer := r.URL.Query().Get("ref"), strings.TrimSpace(r.URL.Query().Get("q")), r.URL.Query().Get("layer")
	if len([]rune(query)) > 2048 || len(ref) > 2048 {
		writeError(w, 400, "read query exceeds limit")
		return
	}
	if layer != "" && layer != "L0" && layer != "L1" && layer != "L2" && layer != "L3" {
		writeError(w, 400, "invalid memory layer")
		return
	}
	offset, limit, ok := knowledgePagination(w, r)
	if !ok {
		return
	}
	binding, identity, ok := h.knowledgeReadContext(w, r)
	if !ok {
		return
	}
	if binding == nil {
		writeError(w, 404, "knowledge space not found")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	result, err := h.Knowledge.Read(ctx, *binding, identity, id, ref, query, layer, offset, limit)
	if err != nil {
		h.knowledgeError(w, "read asset", err)
		return
	}
	writeJSON(w, 200, result)
}
