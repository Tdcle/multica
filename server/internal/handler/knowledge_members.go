package handler

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (h *Handler) syncMemoryMembers(ctx context.Context, workspaceID pgtype.UUID) {
	if h.Knowledge == nil {
		return
	}
	if _, err := h.Queries.GetWorkspaceKnowledge(ctx, workspaceID); errors.Is(err, pgx.ErrNoRows) {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := h.Knowledge.SyncWorkspaceMembers(ctx, workspaceID); err != nil {
		// Multica revocation is authoritative even if Memory is offline. The
		// membership reconciler retries; old panel tickets are checked per request.
		slog.Warn("sync memory members; background retry pending", "workspace_id", uuidToString(workspaceID), "error", err)
	}
}

// Native account and membership screens are read models of Multica, never an
// alternate directory that includes internal service users or stale members.
func (h *Handler) knowledgePanelDirectory(w http.ResponseWriter, r *http.Request, caller knowledgePanelCaller, p string, body map[string]any) bool {
	family := ""
	switch p {
	case "/api/v1/meta/team-member/list", "/api/v1/meta/team-member/get":
		family = "member"
	case "/api/v1/meta/user/list", "/api/v1/meta/user/get":
		family = "user"
	default:
		return false
	}
	if p == "/api/v1/meta/team-member/list" {
		if err := h.Knowledge.SyncWorkspaceMembers(r.Context(), caller.Binding.WorkspaceID); err != nil {
			h.knowledgeError(w, "sync member directory", err)
			return true
		}
	}
	rows, err := h.Queries.ListKnowledgeMembers(r.Context(), db.ListKnowledgeMembersParams{WorkspaceID: caller.Binding.WorkspaceID, InstanceID: caller.Binding.InstanceID})
	if err != nil {
		writeError(w, 500, "failed to read member directory")
		return true
	}
	items := []any{}
	for _, row := range rows {
		id := row.UpstreamUserID.String
		if requested, ok := body["user_id"].(string); ok && requested != "" && requested != id {
			continue
		}
		if requested, ok := body["user_ids"].([]any); ok && len(requested) > 0 {
			found := false
			for _, value := range requested {
				if value == id {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		if query, ok := body["username"].(string); ok && query != "" && !strings.Contains(strings.ToLower(row.Name), strings.ToLower(query)) {
			continue
		}
		role := "member"
		if row.Role == "owner" || row.Role == "admin" {
			role = "admin"
		}
		item := map[string]any{"user_id": id, "username": row.Name, "display_name": row.Name, "email": row.Email, "status": "active", "role": role, "user_type": "normal", "created_at": row.UserCreatedAt.Time.Format(time.RFC3339)}
		if family == "member" {
			item["team_id"] = caller.Binding.TeamID
			item["joined_at"] = row.JoinedAt.Time.Format(time.RFC3339)
		}
		items = append(items, item)
	}
	var data any
	if strings.HasSuffix(p, "/get") {
		if len(items) == 0 {
			writeError(w, 404, "member not found")
			return true
		}
		data = items[0]
	} else {
		total := len(items)
		offset, limit := 0, 100
		if n, ok := body["offset"].(float64); ok {
			offset = max(0, int(n))
		}
		if n, ok := body["limit"].(float64); ok {
			limit = max(1, min(100, int(n)))
		}
		data = map[string]any{"items": items[min(offset, total):min(offset+limit, total)], "total": total, "limit": limit, "offset": offset}
	}
	writeJSON(w, 200, map[string]any{"code": 0, "message": "ok", "data": data})
	return true
}
