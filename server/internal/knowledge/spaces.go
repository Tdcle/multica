package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/redact"
)

// MemoryBinding supplies an individual memory's native scope to the engines.
// WorkspaceKnowledge retains only the team's identity and panel boundary.
func MemoryBinding(memory db.AgentMemory) db.WorkspaceKnowledge {
	return db.WorkspaceKnowledge{WorkspaceID: memory.WorkspaceID, InstanceID: memory.InstanceID,
		TeamID: memory.TeamID, Name: memory.Name, MemoryAgentID: memory.NativeAgentID,
		MemoryUserID: memory.NativeUserID, CreatedBy: memory.OwnerID, CreatedAt: memory.CreatedAt}
}

func (s *Service) runMemoryWork(ctx context.Context) {
	memory, err := s.Queries.ClaimAgentMemoryWork(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return
	}
	if err != nil {
		return
	}
	runCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	next := memory.Status
	if memory.Status == "deleting" {
		err = s.removeNativeMemory(runCtx, memory)
		if err == nil {
			_ = s.Queries.DeleteAgentMemory(ctx, db.DeleteAgentMemoryParams{ID: memory.ID, WorkspaceID: memory.WorkspaceID, LeaseToken: memory.LeaseToken})
			return
		}
	} else if memory.Status == "ready" {
		identity, e := s.WriterIdentity(runCtx, MemoryBinding(memory))
		err = e
		if err == nil {
			var native struct {
				Status string `json:"status"`
			}
			err = s.Client.Call(runCtx, memory.InstanceID, "/v3/meta/agent/get", identity.Key, map[string]any{"agent_id": memory.NativeAgentID}, &native)
			var missing *UpstreamError
			if errors.As(err, &missing) && missing.Status == 404 {
				// A deletion in the original panel must also detach its Multica binding.
				err = s.forgetMissingMemory(runCtx, memory)
				if err == nil {
					return
				}
			} else if err == nil && native.Status == "inactive" {
				next = "failed"
				err = fmt.Errorf("native memory was archived; restore it in the panel or retry to create an active memory")
			}
		}
	} else {
		memory, err = s.provisionMemory(runCtx, memory)
		if err == nil {
			next = "ready"
		}
	}
	if ctx.Err() != nil {
		return
	}
	var last pgtype.Text
	delay := time.Minute
	if err != nil {
		last = pgtype.Text{String: redact.Text(err.Error()), Valid: true}
		delay = time.Duration(min(memory.Attempts+1, 10)) * 5 * time.Second
	}
	_ = s.Queries.FinishAgentMemoryWork(ctx, db.FinishAgentMemoryWorkParams{ID: memory.ID, LeaseToken: memory.LeaseToken,
		Status: next, InstanceID: memory.InstanceID, TeamID: memory.TeamID, NativeAgentID: memory.NativeAgentID,
		NativeUserID: memory.NativeUserID, LastError: last, AvailableAt: pgtype.Timestamptz{Time: time.Now().Add(delay), Valid: true}})
}

func (s *Service) provisionMemory(ctx context.Context, memory db.AgentMemory) (db.AgentMemory, error) {
	owner, err := s.Queries.GetUser(ctx, memory.OwnerID)
	if err != nil {
		return memory, err
	}
	team, err := s.Queries.GetWorkspaceKnowledge(ctx, memory.WorkspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		workspace, loadErr := s.Queries.GetWorkspace(ctx, memory.WorkspaceID)
		if loadErr != nil {
			return memory, loadErr
		}
		team, err = s.Bind(ctx, memory.WorkspaceID, owner, "", workspace.Name)
	}
	if err != nil {
		return memory, err
	}
	identity, err := s.IdentityFor(ctx, owner)
	if err != nil {
		return memory, err
	}
	member, err := s.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: owner.ID, WorkspaceID: memory.WorkspaceID})
	if err != nil {
		return memory, err
	}
	if err = s.SyncMember(ctx, team, identity, member.Role); err != nil {
		return memory, err
	}
	memory.InstanceID, memory.TeamID, memory.NativeUserID = team.InstanceID, team.TeamID, identity.ID
	marker := util.UUIDToString(memory.ID)
	// Discover a prior successful native create if its response or SQL ACK was lost.
	for offset := 0; ; offset += 100 {
		var page struct {
			Items []struct {
				ID       string `json:"agent_id"`
				Owner    string `json:"owner_user_id"`
				Metadata string `json:"metadata_json"`
				Status   string `json:"status"`
			}
			Total int `json:"total"`
		}
		if err = s.Client.Call(ctx, team.InstanceID, "/v3/meta/agent/list", identity.Key, map[string]any{"team_id": team.TeamID, "limit": 100, "offset": offset}, &page); err != nil {
			return memory, err
		}
		for _, a := range page.Items {
			var metadata struct {
				MemoryID string `json:"multica_memory_id"`
			}
			_ = json.Unmarshal([]byte(a.Metadata), &metadata)
			if metadata.MemoryID == marker && a.Owner == identity.ID && a.Status != "inactive" {
				memory.NativeAgentID = a.ID
				return memory, nil
			}
		}
		if len(page.Items) == 0 || offset+len(page.Items) >= page.Total {
			break
		}
	}
	metadata, _ := json.Marshal(map[string]string{"multica_memory_id": marker})
	var agent struct {
		ID string `json:"agent_id"`
	}
	if err = s.Client.Call(ctx, team.InstanceID, "/v3/meta/agent/create", identity.Key, map[string]any{
		"team_id": team.TeamID, "owner_user_id": identity.ID, "name": memory.Name, "visibility": "private", "metadata_json": string(metadata)}, &agent); err != nil {
		return memory, err
	}
	if agent.ID == "" {
		return memory, fmt.Errorf("native memory identity missing")
	}
	memory.NativeAgentID = agent.ID
	return memory, nil
}

func (s *Service) removeNativeMemory(ctx context.Context, memory db.AgentMemory) error {
	if memory.NativeAgentID == "" {
		return nil
	}
	identity, err := s.WriterIdentity(ctx, MemoryBinding(memory))
	if err != nil {
		return err
	}
	// Archive clears all native L0-L3 content; deleting the agent removes the
	// remaining metadata and bindings. Both operations are idempotent on retry.
	for _, operation := range []string{"archive", "delete"} {
		body := map[string]any{"agent_id": memory.NativeAgentID}
		if operation == "delete" {
			body = map[string]any{"agent_ids": []string{memory.NativeAgentID}}
		}
		err = s.Client.Call(ctx, memory.InstanceID, "/v3/meta/agent/"+operation, identity.Key, body, nil)
		var upstream *UpstreamError
		if err != nil && !(errors.As(err, &upstream) && upstream.Status == 404) {
			return err
		}
	}
	return nil
}

func (s *Service) forgetMissingMemory(ctx context.Context, memory db.AgentMemory) error {
	if s.TxStarter == nil {
		return fmt.Errorf("memory reconciliation requires transactions")
	}
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	if _, err = tx.Exec(ctx, "SELECT 1 FROM agent_memory_binding WHERE memory_id=$1 FOR UPDATE", memory.ID); err != nil {
		return err
	}
	locked, err := q.LockAgentMemory(ctx, db.LockAgentMemoryParams{ID: memory.ID, WorkspaceID: memory.WorkspaceID})
	if err != nil {
		return err
	}
	if locked.LeaseToken != memory.LeaseToken {
		return nil
	}
	if err = q.UnbindMemory(ctx, db.UnbindMemoryParams{MemoryID: memory.ID, WorkspaceID: memory.WorkspaceID}); err != nil {
		return err
	}
	if err = q.CancelMissingMemoryExtractions(ctx, memory.ID); err != nil {
		return err
	}
	if err = q.DeleteAgentMemory(ctx, db.DeleteAgentMemoryParams{ID: memory.ID, WorkspaceID: memory.WorkspaceID, LeaseToken: memory.LeaseToken}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
