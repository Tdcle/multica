package knowledge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type TaskContext struct {
	Content  string   `json:"content"`
	Sources  []string `json:"sources"`
	Warnings []string `json:"warnings"`
	Scope    string   `json:"-"`
}

// BuildTaskContext delegates rendering to the original TS injectors. The host
// authorizes every candidate before its text can enter an execution prompt.
func (s *Service) BuildTaskContext(ctx context.Context, binding db.WorkspaceKnowledge, sessionID string) (TaskContext, error) {
	result := TaskContext{}
	if s.Client.ProxyURL == "" {
		return result, fmt.Errorf("memory context service is not configured")
	}
	reader, err := s.WriterIdentity(ctx, binding)
	if err != nil {
		return result, err
	}
	assets := []Asset{}
	for offset := 0; offset < 1000; offset += 100 {
		page, err := s.boundAssets(ctx, binding, offset, 100)
		if err != nil {
			return result, err
		}
		for _, asset := range page.Items {
			if asset.Status == "archived" || asset.Status == "deprecated" || asset.Status == "failed" {
				continue
			}
			// Reuse the same ACL and independent content-store checks as CLI reads.
			var permission struct {
				Allowed bool `json:"allowed"`
			}
			if err := s.Client.Call(ctx, binding.InstanceID, "/v3/meta/acl/check", reader.Key, map[string]any{"asset_id": asset.ID, "user_id": reader.ID, "action": "read"}, &permission); err != nil {
				return result, err
			}
			if !permission.Allowed {
				continue
			}
			if err := s.ValidateContentScope(ctx, binding, asset); err != nil {
				return result, err
			}
			assets = append(assets, asset)
		}
		if len(page.Items) == 0 || offset+len(page.Items) >= page.Total {
			break
		}
		if offset == 900 {
			result.Warnings = append(result.Warnings, "Context catalog covers the first 1000 bindings; paginate knowledge list for more.")
		}
	}
	scopeParts := []string{binding.InstanceID, binding.TeamID, binding.MemoryAgentID, binding.MemoryUserID}
	for _, asset := range assets {
		scopeParts = append(scopeParts, asset.ID+":"+asset.Type+":"+asset.Visibility+":"+asset.OwnerID)
	}
	sort.Strings(scopeParts)
	digest := sha256.Sum256([]byte(strings.Join(scopeParts, "\n")))
	result.Scope = hex.EncodeToString(digest[:])
	warnings := result.Warnings
	type contextAsset struct {
		ID   string `json:"asset_id"`
		Type string `json:"asset_type"`
		Name string `json:"name"`
	}
	catalog := make([]contextAsset, 0, len(assets))
	for _, asset := range assets {
		catalog = append(catalog, contextAsset{asset.ID, asset.Type, asset.Name})
	}
	if err := s.Client.call(ctx, s.Client.ProxyURL, s.Client.APIKey, binding.InstanceID, "/v3/multica/context", reader.Key, map[string]any{"team_id": binding.TeamID, "agent_id": binding.MemoryAgentID, "user_id": reader.ID, "session_id": sessionID, "assets": catalog}, &result); err != nil {
		return TaskContext{}, err
	}
	result.Warnings = append(warnings, result.Warnings...)
	// Reject malformed responses rather than exposing an arbitrary upstream payload.
	if result.Content == "" || len(result.Content) > 128000 || len(result.Sources) == 0 || len(result.Sources) > 3 {
		return TaskContext{}, fmt.Errorf("invalid memory context response")
	}
	for _, source := range result.Sources {
		switch source {
		case "tdai-profile-memory-injector", "skill-injector", "knowledge-tools-injector":
		default:
			return TaskContext{}, fmt.Errorf("unknown memory context source")
		}
	}
	return result, nil
}

func (c TaskContext) Prompt() string {
	// JSON keeps stored content separate from the host's trusted tool instructions.
	encoded, _ := json.Marshal(struct {
		Content  string   `json:"content"`
		Sources  []string `json:"sources"`
		Warnings []string `json:"warnings"`
	}{c.Content, c.Sources, c.Warnings})
	return "```json\n" + string(encoded) + "\n```"
}
