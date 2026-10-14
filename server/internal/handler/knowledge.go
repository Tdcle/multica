package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/knowledge"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type KnowledgeBindingResponse struct {
	WorkspaceID    string `json:"workspace_id"`
	TeamID         string `json:"team_id"`
	InstanceID     string `json:"instance_id"`
	Name           string `json:"name"`
	MemoryAgentID  string `json:"memory_agent_id"`
	PanelAvailable bool   `json:"panel_available"`
}

func (h *Handler) knowledgeBindingResponse(binding db.WorkspaceKnowledge) KnowledgeBindingResponse {
	return KnowledgeBindingResponse{
		WorkspaceID: uuidToString(binding.WorkspaceID), TeamID: binding.TeamID,
		InstanceID: binding.InstanceID, Name: binding.Name, MemoryAgentID: binding.MemoryAgentID,
		PanelAvailable: h.Knowledge != nil && h.Knowledge.Client.PanelURL != "",
	}
}

func (h *Handler) knowledgeConfigured(w http.ResponseWriter) bool {
	if h.Knowledge == nil {
		writeError(w, http.StatusServiceUnavailable, "knowledge service is not configured")
		return false
	}
	return true
}

func (h *Handler) GetWorkspaceKnowledge(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	var binding *KnowledgeBindingResponse
	stored, err := h.Queries.GetWorkspaceKnowledge(r.Context(), parseUUID(workspaceID))
	if err == nil {
		value := h.knowledgeBindingResponse(stored)
		binding = &value
	} else if !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "failed to read knowledge binding")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"configured": h.Knowledge != nil, "binding": binding})
}

func (h *Handler) ListKnowledgeSpaces(w http.ResponseWriter, r *http.Request) {
	if !h.knowledgeConfigured(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin"); !ok {
		return
	}
	user, err := h.Queries.GetUser(r.Context(), parseUUID(requestUserID(r)))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read account")
		return
	}
	identity, err := h.Knowledge.IdentityFor(r.Context(), user)
	if err != nil {
		h.knowledgeError(w, "prepare identity", err)
		return
	}
	spaces, err := h.Knowledge.Spaces(r.Context(), identity)
	if err != nil {
		h.knowledgeError(w, "list spaces", err)
		return
	}
	writeJSON(w, http.StatusOK, spaces)
}

func (h *Handler) BindWorkspaceKnowledge(w http.ResponseWriter, r *http.Request) {
	if !h.knowledgeConfigured(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin"); !ok {
		return
	}
	var input struct {
		TeamID string `json:"team_id"`
		Name   string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid binding request")
		return
	}
	input.TeamID, input.Name = strings.TrimSpace(input.TeamID), strings.TrimSpace(input.Name)
	if input.TeamID == "" && (input.Name == "" || len([]rune(input.Name)) > 120) {
		writeError(w, http.StatusBadRequest, "space name must contain 1 to 120 characters")
		return
	}
	if _, err := h.Queries.GetWorkspaceKnowledge(r.Context(), parseUUID(workspaceID)); err == nil {
		writeError(w, http.StatusConflict, "workspace already has a knowledge space")
		return
	} else if !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "failed to read knowledge binding")
		return
	}
	user, err := h.Queries.GetUser(r.Context(), parseUUID(requestUserID(r)))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read account")
		return
	}
	binding, err := h.Knowledge.Bind(r.Context(), parseUUID(workspaceID), user, input.TeamID, input.Name)
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "knowledge space is already bound")
			return
		}
		h.knowledgeError(w, "bind space", err)
		return
	}
	writeJSON(w, http.StatusCreated, h.knowledgeBindingResponse(binding))
}

func (h *Handler) UnbindWorkspaceKnowledge(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin"); !ok {
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to unbind knowledge space")
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(hashtextextended($1,19718))", workspaceID); err != nil {
		writeError(w, 500, "failed to lock knowledge space")
		return
	}
	var hasMemories bool
	if err = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM agent_memory WHERE workspace_id=$1)", parseUUID(workspaceID)).Scan(&hasMemories); err != nil {
		writeError(w, 500, "failed to check memories")
		return
	}
	if hasMemories {
		writeError(w, 409, "remove independent memories before detaching their native team")
		return
	}

	q := h.Queries.WithTx(tx)
	if err := q.DeleteKnowledgeForWorkspace(r.Context(), parseUUID(workspaceID)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove knowledge jobs")
		return
	}
	if err := q.UnbindWorkspaceKnowledge(r.Context(), parseUUID(workspaceID)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to unbind knowledge space")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to unbind knowledge space")
		return
	}
	// The upstream space is an independently owned resource and remains usable
	// after detaching it from a workspace.
	w.WriteHeader(http.StatusNoContent)
}

type KnowledgeExtractionResponse struct {
	ID            string  `json:"id"`
	IssueID       string  `json:"issue_id"`
	IssueTitle    string  `json:"issue_title"`
	IssueRevision int64   `json:"issue_revision"`
	Status        string  `json:"status"`
	Attempts      int32   `json:"attempts"`
	Error         *string `json:"error"`
	CreatedAt     string  `json:"created_at"`
	UpdatedAt     string  `json:"updated_at"`
}

func (h *Handler) ListKnowledgeExtractions(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	jobs, err := h.Queries.ListWorkspaceKnowledgeExtractions(r.Context(), db.ListWorkspaceKnowledgeExtractionsParams{
		WorkspaceID: parseUUID(workspaceID), Limit: 100,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list knowledge extractions")
		return
	}
	result := make([]KnowledgeExtractionResponse, 0, len(jobs))
	for _, job := range jobs {
		var snapshot struct {
			Title string `json:"title"`
		}
		if err := json.Unmarshal(job.IssueSnapshot, &snapshot); err != nil {
			slog.Warn("invalid knowledge issue snapshot", "job_id", uuidToString(job.ID))
		}
		result = append(result, KnowledgeExtractionResponse{
			ID: uuidToString(job.ID), IssueID: uuidToString(job.IssueID), IssueRevision: job.IssueRevision,
			IssueTitle: snapshot.Title, Status: job.Status, Attempts: job.Attempts, Error: textToPtr(job.LastError),
			CreatedAt: job.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"), UpdatedAt: job.UpdatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		})
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) RetryKnowledgeExtraction(w http.ResponseWriter, r *http.Request) {
	if !h.knowledgeConfigured(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin"); !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "id")
	if !ok {
		return
	}
	_, err := h.Queries.RetryKnowledgeExtraction(r.Context(), db.RetryKnowledgeExtractionParams{ID: id, WorkspaceID: parseUUID(workspaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		current, lookupErr := h.Queries.GetKnowledgeExtractionForWorkspace(r.Context(), db.GetKnowledgeExtractionForWorkspaceParams{ID: id, WorkspaceID: parseUUID(workspaceID)})
		if lookupErr == nil && (current.Status == "pending" || current.Status == "processing" || current.Status == "submitted" || current.Status == "ready") {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeError(w, http.StatusNotFound, "failed extraction not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to retry extraction")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) SearchKnowledge(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" || len([]rune(query)) > 2048 {
		writeError(w, 400, "query must contain 1 to 2048 characters")
		return
	}
	binding, identity, ok := h.knowledgeReadContext(w, r)
	if !ok {
		return
	}
	if binding == nil {
		writeJSON(w, 200, []knowledge.Memory{})
		return
	}
	result, err := h.Knowledge.Retrieve(r.Context(), *binding, identity, query, "chat_memory")
	if err != nil {
		h.knowledgeError(w, "search memory", err)
		return
	}
	writeJSON(w, 200, result.Items)
}

func (h *Handler) knowledgeError(w http.ResponseWriter, operation string, err error) {
	slog.Warn("knowledge operation failed", "operation", operation, "error", err)
	var upstream *knowledge.UpstreamError
	if errors.As(err, &upstream) && upstream.Status == http.StatusForbidden {
		writeError(w, http.StatusForbidden, "knowledge space access denied")
		return
	}
	if errors.As(err, &upstream) && upstream.Status == http.StatusNotFound {
		writeError(w, http.StatusNotFound, "knowledge space not found")
		return
	}
	if errors.As(err, &upstream) && upstream.Status == http.StatusBadRequest {
		writeError(w, http.StatusBadRequest, "knowledge service rejected the request")
		return
	}
	writeError(w, http.StatusBadGateway, "knowledge service could not complete the request")
}
