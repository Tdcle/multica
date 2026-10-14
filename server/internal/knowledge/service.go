package knowledge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type Service struct {
	Client     *Client
	Queries    *db.Queries
	Box        *secretbox.Box
	InstanceID string
	TxStarter  interface {
		Begin(context.Context) (pgx.Tx, error)
	}
}

type Identity struct {
	ID  string
	Key string
}

// IdentityFor persists a generated credential before provisioning the remote
// account. If the remote response is lost, auth/verify recovers that account on
// the next attempt instead of creating a duplicate or losing its only key.
func (s *Service) IdentityFor(ctx context.Context, user db.User) (Identity, error) {
	params := db.GetKnowledgeIdentityParams{InstanceID: s.InstanceID, UserID: user.ID}
	row, err := s.Queries.GetKnowledgeIdentity(ctx, params)
	if errors.Is(err, pgx.ErrNoRows) {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return Identity{}, err
		}
		key := "sk-mem-" + hex.EncodeToString(random[:])
		ciphertext, sealErr := s.Box.Seal([]byte(key))
		if sealErr != nil {
			return Identity{}, sealErr
		}
		if err := s.Queries.PrepareKnowledgeIdentity(ctx, db.PrepareKnowledgeIdentityParams{
			InstanceID: s.InstanceID, UserID: user.ID, UserKeyCiphertext: ciphertext,
		}); err != nil {
			return Identity{}, err
		}
		row, err = s.Queries.GetKnowledgeIdentity(ctx, params)
	}
	if err != nil {
		return Identity{}, err
	}
	key, err := s.Box.Open(row.UserKeyCiphertext)
	if err != nil {
		return Identity{}, fmt.Errorf("cannot decrypt knowledge identity: %w", err)
	}
	identity := Identity{ID: row.UpstreamUserID.String, Key: string(key)}
	if row.UpstreamUserID.Valid && identity.ID != "" {
		return identity, nil
	}
	var verified struct {
		Valid bool `json:"valid"`
		User  struct {
			ID string `json:"user_id"`
		} `json:"user"`
	}
	if err := s.Client.Call(ctx, s.InstanceID, "/v3/meta/auth/verify", "",
		map[string]any{"user_key": identity.Key}, &verified); err != nil {
		return Identity{}, err
	}
	if verified.Valid {
		identity.ID = verified.User.ID
	} else {
		var created struct {
			ID string `json:"user_id"`
		}
		input := map[string]any{
			"username": "multica_" + strings.ReplaceAll(util.UUIDToString(user.ID), "-", ""),
			"user_key": identity.Key, "auth_provider": "multica",
			"external_id": util.UUIDToString(user.ID), "display_name": user.Name,
		}
		// Multica's UUID owns this identity. Optional native email validation
		// must not prevent provisioning local accounts such as dev@localhost.
		if err := s.Client.Call(ctx, s.InstanceID, "/v3/meta/user/create-with-key", s.Client.AdminKey, input, &created); err != nil {
			return Identity{}, err
		}
		identity.ID = created.ID
	}
	if identity.ID == "" {
		return Identity{}, fmt.Errorf("agent memory returned an empty user identity")
	}
	err = s.Queries.CompleteKnowledgeIdentity(ctx, db.CompleteKnowledgeIdentityParams{
		InstanceID: s.InstanceID, UserID: user.ID, UpstreamUserID: pgtype.Text{String: identity.ID, Valid: true},
	})
	return identity, err
}

func (s *Service) Spaces(ctx context.Context, identity Identity) ([]Team, error) {
	bindings, err := s.Queries.ListKnowledgeBindings(ctx, s.InstanceID)
	if err != nil {
		return nil, err
	}
	bound := make(map[string]bool, len(bindings))
	for _, binding := range bindings {
		bound[binding.TeamID] = true
	}
	spaces := []Team{}
	for offset := 0; ; offset += 100 {
		var page struct {
			Items []Team `json:"items"`
			Total int    `json:"total"`
		}
		err := s.Client.Call(ctx, s.InstanceID, "/v3/meta/team/list", identity.Key,
			map[string]any{"user_id": identity.ID, "limit": 100, "offset": offset}, &page)
		if err != nil {
			return nil, err
		}
		for _, team := range page.Items {
			if !bound[team.ID] {
				spaces = append(spaces, team)
			}
		}
		if len(page.Items) == 0 || offset+len(page.Items) >= page.Total {
			return spaces, nil
		}
	}
}

func (s *Service) Bind(ctx context.Context, workspaceID pgtype.UUID, user db.User, teamID, name string) (db.WorkspaceKnowledge, error) {
	if s.TxStarter != nil {
		tx, err := s.TxStarter.Begin(ctx)
		if err != nil {
			return db.WorkspaceKnowledge{}, err
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,19718))", util.UUIDToString(workspaceID)); err != nil {
			return db.WorkspaceKnowledge{}, err
		}
		if existing, err := s.Queries.GetWorkspaceKnowledge(ctx, workspaceID); err == nil {
			return existing, nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return db.WorkspaceKnowledge{}, err
		}
		return s.bindTeam(ctx, workspaceID, user, teamID, name)
	}
	return s.bindTeam(ctx, workspaceID, user, teamID, name)
}

func (s *Service) bindTeam(ctx context.Context, workspaceID pgtype.UUID, user db.User, teamID, name string) (db.WorkspaceKnowledge, error) {
	identity, err := s.IdentityFor(ctx, user)
	if err != nil {
		return db.WorkspaceKnowledge{}, err
	}
	var team Team
	if teamID == "" {
		if strings.TrimSpace(name) == "" {
			return db.WorkspaceKnowledge{}, fmt.Errorf("space name is required")
		}
		err = s.Client.Call(ctx, s.InstanceID, "/v3/meta/team/create", identity.Key,
			map[string]any{"name": name, "owner_user_id": identity.ID}, &team)
	} else {
		err = s.Client.Call(ctx, s.InstanceID, "/v3/meta/team/get", identity.Key,
			map[string]any{"team_id": teamID}, &team)
		if err == nil {
			var member struct {
				Role string `json:"role"`
			}
			err = s.Client.Call(ctx, s.InstanceID, "/v3/meta/team-member/get", identity.Key,
				map[string]any{"team_id": team.ID, "user_id": identity.ID}, &member)
			if err == nil && member.Role != "admin" {
				err = fmt.Errorf("knowledge space admin access is required")
			}
		}
	}
	if err != nil {
		return db.WorkspaceKnowledge{}, err
	}
	if team.ID == "" {
		return db.WorkspaceKnowledge{}, fmt.Errorf("agent memory returned an empty team identity")
	}
	return s.Queries.BindWorkspaceKnowledge(ctx, db.BindWorkspaceKnowledgeParams{
		WorkspaceID: workspaceID, InstanceID: s.InstanceID, TeamID: team.ID, Name: team.Name,
		MemoryAgentID: "", MemoryUserID: identity.ID, CreatedBy: user.ID,
	})
}

func ScopeFor(binding db.WorkspaceKnowledge) Scope {
	return Scope{InstanceID: binding.InstanceID, TeamID: binding.TeamID, AgentID: binding.MemoryAgentID, UserID: binding.MemoryUserID}
}

// SearchFor checks the original Chat Memory asset before reading engine data.
// Human callers retain their native ACLs; agents receive only team-shared data.
func (s *Service) SearchFor(ctx context.Context, binding db.WorkspaceKnowledge, query string, limit int, identity *Identity) ([]Memory, error) {
	assetID := "chat_memory-" + binding.TeamID + "-" + binding.MemoryAgentID
	writer, err := s.WriterIdentity(ctx, binding)
	if err != nil {
		return nil, err
	}
	var asset struct {
		TeamID     string `json:"team_id"`
		Visibility string `json:"visibility"`
		Status     string `json:"status"`
	}
	if err := s.Client.Call(ctx, binding.InstanceID, "/v3/meta/asset/get", writer.Key, map[string]any{"asset_id": assetID}, &asset); err != nil {
		return nil, err
	}
	if asset.TeamID != binding.TeamID || asset.Status == "archived" {
		return []Memory{}, nil
	}
	if identity != nil {
		var permission struct {
			Allowed bool `json:"allowed"`
		}
		if err := s.Client.Call(ctx, binding.InstanceID, "/v3/meta/acl/check", identity.Key,
			map[string]any{"asset_id": assetID, "user_id": identity.ID, "action": "read"}, &permission); err != nil {
			return nil, err
		}
		if !permission.Allowed {
			return []Memory{}, nil
		}
	}
	return s.Client.Search(ctx, ScopeFor(binding), query, limit)
}

// WriterIdentity resolves the managed writer's actual account credential.
// A provisioning account is not automatically an admin of every upstream team.
func (s *Service) WriterIdentity(ctx context.Context, binding db.WorkspaceKnowledge) (Identity, error) {
	row, err := s.Queries.GetKnowledgeWriterIdentity(ctx, db.GetKnowledgeWriterIdentityParams{
		InstanceID: binding.InstanceID, UpstreamUserID: pgtype.Text{String: binding.MemoryUserID, Valid: true},
	})
	if err != nil {
		return Identity{}, fmt.Errorf("knowledge writer identity is unavailable: %w", err)
	}
	key, err := s.Box.Open(row.UserKeyCiphertext)
	if err != nil {
		return Identity{}, err
	}
	return Identity{ID: binding.MemoryUserID, Key: string(key)}, nil
}

func (s *Service) SyncMember(ctx context.Context, binding db.WorkspaceKnowledge, identity Identity, role string) error {
	writer, err := s.WriterIdentity(ctx, binding)
	if err != nil {
		return err
	}
	upstreamRole := "member"
	if role == "owner" || role == "admin" {
		upstreamRole = "admin"
	}
	// This credential also owns the automation assets and administers upstream
	// membership. Keep that service capability when its human loses a Multica
	// admin role; the gateway separately enforces the current human role.
	if identity.ID == binding.MemoryUserID {
		upstreamRole = "admin"
	}
	var existing struct {
		Role   string `json:"role"`
		Status string `json:"status"`
	}
	err = s.Client.Call(ctx, binding.InstanceID, "/v3/meta/team-member/get", writer.Key,
		map[string]any{"team_id": binding.TeamID, "user_id": identity.ID}, &existing)
	if err == nil && existing.Role == upstreamRole && existing.Status == "active" {
		return nil
	}
	if err != nil {
		var upstream *UpstreamError
		if !errors.As(err, &upstream) || upstream.Status != 404 {
			return err
		}
	}
	return s.Client.Call(ctx, binding.InstanceID, "/v3/meta/team-member/add", writer.Key,
		map[string]any{"team_id": binding.TeamID, "user_id": identity.ID, "role": upstreamRole, "status": "active"}, nil)
}
