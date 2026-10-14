package knowledge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (s *Service) syncDisplayName(ctx context.Context, user db.User, identity Identity, previous pgtype.Text) error {
	if previous.Valid && previous.String == user.Name {
		return nil
	}
	if err := s.Client.Call(ctx, s.InstanceID, "/v3/meta/user/bind-external", s.Client.AdminKey, map[string]any{
		"user_id": identity.ID, "external_id": util.UUIDToString(user.ID), "auth_provider": "multica", "display_name": user.Name,
	}, nil); err != nil {
		return err
	}
	return s.Queries.SaveKnowledgeDisplayName(ctx, db.SaveKnowledgeDisplayNameParams{InstanceID: s.InstanceID, UserID: user.ID, DisplayName: pgtype.Text{String: user.Name, Valid: true}})
}

// TeamIdentity administers the native team independently of any human's role.
// Persist the key before remote provisioning so retries recover the same user.
func (s *Service) TeamIdentity(ctx context.Context, binding db.WorkspaceKnowledge) (Identity, error) {
	row, err := s.Queries.GetWorkspaceKnowledge(ctx, binding.WorkspaceID)
	if err != nil {
		return Identity{}, err
	}
	if len(row.ServiceKeyCiphertext) == 0 {
		var random [24]byte
		if _, err = rand.Read(random[:]); err != nil {
			return Identity{}, err
		}
		sealed, sealErr := s.Box.Seal([]byte("sk-mem-service-" + hex.EncodeToString(random[:])))
		if sealErr != nil {
			return Identity{}, sealErr
		}
		row, err = s.Queries.PrepareKnowledgeServiceIdentity(ctx, db.PrepareKnowledgeServiceIdentityParams{WorkspaceID: binding.WorkspaceID, ServiceKeyCiphertext: sealed})
		if err != nil {
			return Identity{}, err
		}
	}
	key, err := s.Box.Open(row.ServiceKeyCiphertext)
	if err != nil {
		return Identity{}, err
	}
	identity := Identity{ID: row.ServiceUserID.String, Key: string(key)}
	if identity.ID == "" {
		var verified struct {
			Valid bool `json:"valid"`
			User  struct {
				ID string `json:"user_id"`
			} `json:"user"`
		}
		if err = s.Client.Call(ctx, binding.InstanceID, "/v3/meta/auth/verify", "", map[string]any{"user_key": identity.Key}, &verified); err != nil {
			return Identity{}, err
		}
		identity.ID = verified.User.ID
		if !verified.Valid {
			var created struct {
				ID string `json:"user_id"`
			}
			workspaceID := util.UUIDToString(binding.WorkspaceID)
			principalID := workspaceID + "_" + strconv.FormatInt(row.CreatedAt.Time.UnixNano(), 36)
			err = s.Client.Call(ctx, binding.InstanceID, "/v3/meta/user/create-with-key", s.Client.AdminKey, map[string]any{
				"username": "multica_service_" + strings.ReplaceAll(principalID, "-", ""), "user_key": identity.Key,
				"auth_provider": "multica_service", "external_id": principalID, "display_name": "Multica Memory service",
			}, &created)
			if err != nil {
				return Identity{}, err
			}
			identity.ID = created.ID
		}
		if identity.ID == "" {
			return Identity{}, fmt.Errorf("empty memory service identity")
		}
		if err = s.Queries.CompleteKnowledgeServiceIdentity(ctx, db.CompleteKnowledgeServiceIdentityParams{WorkspaceID: binding.WorkspaceID, ServiceUserID: pgtype.Text{String: identity.ID, Valid: true}}); err != nil {
			return Identity{}, err
		}
	}
	var team struct {
		Owner string `json:"owner_user_id"`
	}
	if err = s.Client.Call(ctx, binding.InstanceID, "/v3/meta/team/get", identity.Key, map[string]any{"team_id": binding.TeamID}, &team); err != nil {
		return Identity{}, err
	}
	if team.Owner != identity.ID {
		err = s.Client.Call(ctx, binding.InstanceID, "/v3/meta/team/managed-owner", s.Client.AdminKey, map[string]any{"team_id": binding.TeamID, "user_id": identity.ID}, nil)
	}
	return identity, err
}

// SyncWorkspaceMembers derives desired state afresh from Multica. Repeating a
// complete comparison also recovers missed notifications and native outages;
// removals do not depend on a departed user's credential continuing to work.
func (s *Service) SyncWorkspaceMembers(ctx context.Context, workspaceID pgtype.UUID) error {
	binding, err := s.Queries.GetWorkspaceKnowledge(ctx, workspaceID)
	if err != nil {
		return err
	}
	service, err := s.TeamIdentity(ctx, binding)
	if err != nil {
		return err
	}
	members, err := s.Queries.ListMembers(ctx, workspaceID)
	if err != nil {
		return err
	}
	desired := map[string]bool{service.ID: true}
	for _, member := range members {
		user, err := s.Queries.GetUser(ctx, member.UserID)
		if err != nil {
			return err
		}
		identity, err := s.IdentityFor(ctx, user)
		if err != nil {
			return err
		}
		desired[identity.ID] = true
		if err = s.SyncMember(ctx, binding, identity, member.Role); err != nil {
			return err
		}
	}
	var removed []string
	for offset := 0; ; offset += 100 {
		var page struct {
			Items []struct {
				ID string `json:"user_id"`
			} `json:"items"`
			Total int `json:"total"`
		}
		if err = s.Client.Call(ctx, binding.InstanceID, "/v3/meta/team-member/list", service.Key, map[string]any{"team_id": binding.TeamID, "limit": 100, "offset": offset}, &page); err != nil {
			return err
		}
		for _, member := range page.Items {
			if !desired[member.ID] {
				removed = append(removed, member.ID)
			}
		}
		if len(page.Items) == 0 || offset+len(page.Items) >= page.Total {
			break
		}
	}
	for _, id := range removed {
		if err = s.Client.Call(ctx, binding.InstanceID, "/v3/meta/team-member/remove", service.Key, map[string]any{"team_id": binding.TeamID, "user_id": id}, nil); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) runMembershipSync(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		bindings, err := s.Queries.ListKnowledgeBindings(ctx, s.InstanceID)
		if err == nil {
			for _, binding := range bindings {
				runCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
				err = s.SyncWorkspaceMembers(runCtx, binding.WorkspaceID)
				cancel()
				if err != nil && !errors.Is(err, context.Canceled) {
					slog.Warn("sync memory membership", "workspace_id", util.UUIDToString(binding.WorkspaceID), "error", err)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
