package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type Asset struct {
	ID          string `json:"asset_id"`
	TeamID      string `json:"team_id"`
	Type        string `json:"asset_type"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Status      string `json:"status"`
	Visibility  string `json:"visibility"`
	OwnerID     string `json:"owner_user_id"`
}

type AssetPage struct {
	Items  []Asset `json:"items"`
	Total  int     `json:"total"`
	Limit  int     `json:"limit"`
	Offset int     `json:"offset"`
}

type RetrievalWarning struct {
	AssetID string `json:"asset_id,omitempty"`
	Type    string `json:"type"`
	Reason  string `json:"reason"`
}

type Retrieval struct {
	Items    []Memory           `json:"items"`
	Warnings []RetrievalWarning `json:"warnings"`
}

func (s *Service) reader(ctx context.Context, binding db.WorkspaceKnowledge, identity *Identity) (Identity, error) {
	if identity != nil {
		return *identity, nil
	}
	return s.WriterIdentity(ctx, binding)
}

// Metadata and content are independent stores. A metadata alias must not
// redirect a scoped reader to another team's persisted content.
func (s *Service) ValidateContentScope(ctx context.Context, binding db.WorkspaceKnowledge, asset Asset) error {
	if asset.Type == "chat_memory" {
		if !strings.HasPrefix(asset.ID, "chat_memory-"+binding.TeamID+"-") {
			return &UpstreamError{Status: 403, Code: 403, Path: "asset/scope"}
		}
	}
	kind := ""
	if asset.Type == "llm_wiki" {
		kind = "wiki"
	} else if asset.Type == "code_graph" {
		kind = "code-graph"
	}
	if kind == "" {
		return nil
	}
	var content struct {
		TeamID string `json:"team_id"`
	}
	if err := s.Client.KnowledgeResource(ctx, binding.InstanceID, kind, asset.ID, &content); err != nil {
		return err
	}
	if content.TeamID != binding.TeamID {
		return &UpstreamError{Status: 403, Code: 403, Path: "asset/scope"}
	}
	return nil
}

// Asset metadata is projected into this public shape: provider configuration
// and deployment credentials never become an agent-visible tool result.
func (s *Service) Assets(ctx context.Context, binding db.WorkspaceKnowledge, identity *Identity, offset, limit int) (AssetPage, error) {
	if identity == nil {
		return s.boundAssets(ctx, binding, offset, limit)
	}

	reader, err := s.reader(ctx, binding, identity)
	if err != nil {
		return AssetPage{}, err
	}
	input := map[string]any{"team_id": binding.TeamID, "user_id": reader.ID, "action": "read", "offset": offset, "limit": limit}
	page := AssetPage{Items: []Asset{}}
	err = s.Client.Call(ctx, binding.InstanceID, "/v3/meta/asset/list-accessible", reader.Key, input, &page)
	for _, asset := range page.Items {
		if asset.TeamID != binding.TeamID {
			return AssetPage{}, fmt.Errorf("invalid asset scope returned by metadata")
		}
	}
	return page, err
}

func (s *Service) readableAsset(ctx context.Context, binding db.WorkspaceKnowledge, identity *Identity, id string) (Asset, Identity, error) {
	reader, err := s.reader(ctx, binding, identity)
	if err != nil {
		return Asset{}, reader, err
	}
	if identity == nil {
		allowed, e := s.isBoundAsset(ctx, binding, reader, id)
		if e != nil {
			return Asset{}, reader, e
		}
		if !allowed {
			return Asset{}, reader, &UpstreamError{Status: 403, Code: 403, Path: "asset/binding"}
		}
	}
	var asset Asset
	if err = s.Client.Call(ctx, binding.InstanceID, "/v3/meta/asset/get", reader.Key, map[string]any{"asset_id": id}, &asset); err != nil {
		return asset, reader, err
	}
	if asset.TeamID != binding.TeamID || asset.Status == "archived" {
		return Asset{}, reader, &UpstreamError{Status: 403, Code: 403, Path: "asset/read"}
	}
	var permission struct {
		Allowed bool `json:"allowed"`
	}
	err = s.Client.Call(ctx, binding.InstanceID, "/v3/meta/acl/check", reader.Key, map[string]any{"asset_id": id, "user_id": reader.ID, "action": "read"}, &permission)
	if err != nil {
		return asset, reader, err
	}
	if !permission.Allowed {
		return Asset{}, reader, &UpstreamError{Status: 403, Code: 403, Path: "asset/read"}
	}
	if err := s.ValidateContentScope(ctx, binding, asset); err != nil {
		return asset, reader, err
	}
	return asset, reader, nil
}

// Read exposes fixed read-only native operations. Tenant IDs, credentials and
// endpoint paths come from the binding and resolved metadata, never tool input.
func (s *Service) Read(ctx context.Context, binding db.WorkspaceKnowledge, identity *Identity, id, ref, query, layer string, offset, limit int) (json.RawMessage, error) {
	asset, reader, err := s.readableAsset(ctx, binding, identity, id)
	if err != nil {
		return nil, err
	}
	input := map[string]any{}
	path := ""
	switch asset.Type {
	case "skill":
		input = map[string]any{"team_id": binding.TeamID, "skill_id": id, "include_content": true, "include_manifest": true}
		var result json.RawMessage
		err = s.Client.Call(ctx, binding.InstanceID, "/v3/skill/get", reader.Key, input, &result)
		return result, err
	case "llm_wiki":
		input["wiki_id"] = id
		path = "/api/v1/knowledge/wiki/page/ls"
		if ref != "" {
			path = "/api/v1/knowledge/wiki/page/read"
			input["refs"] = []string{ref}
		}
	case "code_graph":
		input["code_graph_id"] = id
		path = "/api/v1/knowledge/code-graph/get"
		if query != "" {
			path = "/api/v1/knowledge/code-graph/explore"
			input["query"] = query
			input["maxFiles"] = 10
		}
	case "chat_memory":
		if layer == "" {
			layer = "L1"
		}
		if layer != "L0" && layer != "L1" && layer != "L2" && layer != "L3" {
			return nil, fmt.Errorf("invalid memory layer")
		}
		input = map[string]any{"block_id": id, "layer": layer, "limit": limit, "offset": offset}
		path = "/api/v1/chat-memory/layer"
	default:
		return nil, &UpstreamError{Status: 400, Code: 400, Path: "asset/read"}
	}
	var result json.RawMessage
	err = s.Client.PanelCall(ctx, binding.InstanceID, path, reader.Key, input, &result)
	return result, err
}

// Retrieval preserves each engine's native ranking. Results are grouped by
// engine because BM25 and graph scores are not comparable across engines.
func (s *Service) Retrieve(ctx context.Context, binding db.WorkspaceKnowledge, identity *Identity, query, kind string) (Retrieval, error) {
	result := Retrieval{Items: []Memory{}, Warnings: []RetrievalWarning{}}
	page, err := s.Assets(ctx, binding, identity, 0, 100)
	if err != nil {
		return result, err
	}
	reader, err := s.reader(ctx, binding, identity)
	if err != nil {
		return result, err
	}
	allowed := map[string]Asset{}
	// The managed memory block predates future Wiki/Skill assets. A large
	// catalog must not push historical task recall out of its first page.
	if kind == "" || kind == "chat_memory" {
		managedID := "chat_memory-" + binding.TeamID + "-" + binding.MemoryAgentID
		found := false
		for index, asset := range page.Items {
			if asset.ID == managedID {
				found = true
				remaining := append([]Asset{}, page.Items[:index]...)
				remaining = append(remaining, page.Items[index+1:]...)
				page.Items = append([]Asset{asset}, remaining...)
				break
			}
		}
		if !found {
			if managed, _, lookupErr := s.readableAsset(ctx, binding, identity, managedID); lookupErr == nil {
				page.Items = append([]Asset{managed}, page.Items...)
			}
		}
	}
	for _, asset := range page.Items {
		allowed[asset.ID] = asset
	}
	if page.Total > len(page.Items) {
		result.Warnings = append(result.Warnings, RetrievalWarning{Type: "catalog", Reason: "More assets are available through paginated knowledge list; this retrieval covers the first 100."})
	}
	type operation struct {
		kind, id string
		run      func() ([]Memory, error)
	}
	ops := []operation{}
	if kind == "" || kind == "chat_memory" {
		// Search every accessible native block, not only Multica's managed writer.
		for _, asset := range page.Items {
			if asset.Type != "chat_memory" {
				continue
			}
			a := asset
			ops = append(ops, operation{kind: a.Type, id: a.ID, run: func() ([]Memory, error) {
				prefix := "chat_memory-" + binding.TeamID + "-"
				if !strings.HasPrefix(a.ID, prefix) {
					return nil, nil
				}
				agentID := strings.TrimPrefix(a.ID, prefix)
				if agentID == "" || a.OwnerID == "" {
					return nil, fmt.Errorf("invalid native memory scope")
				}
				items, err := s.Client.Search(ctx, Scope{InstanceID: binding.InstanceID, TeamID: binding.TeamID, AgentID: agentID, UserID: a.OwnerID}, query, 5)
				for i := range items {
					items[i].AssetID = a.ID
					items[i].AssetType = a.Type
					items[i].Name = a.Name
				}
				return items, err
			}})
		}
	}
	if kind == "" || kind == "skill" {
		candidateIDs := []string{}
		for _, asset := range page.Items {
			if asset.Type == "skill" {
				candidateIDs = append(candidateIDs, asset.ID)
			}
		}
		ops = append(ops, operation{kind: "skill", run: func() ([]Memory, error) {
			if len(candidateIDs) == 0 {
				return nil, nil
			}
			var response struct {
				Items []struct {
					ID      string  `json:"skill_id"`
					Name    string  `json:"name"`
					Snippet string  `json:"snippet"`
					Score   float64 `json:"score"`
				} `json:"items"`
			}
			err := s.Client.Call(ctx, binding.InstanceID, "/v3/skill/search", reader.Key, map[string]any{"team_id": binding.TeamID, "query": query, "scope": "team", "top_k": 50, "allowed_skill_ids": candidateIDs}, &response)
			hits := []Memory{}
			for _, item := range response.Items {
				asset, ok := allowed[item.ID]
				if ok && asset.Type == "skill" {
					hits = append(hits, Memory{ID: item.ID, AssetID: item.ID, AssetType: "skill", Name: item.Name, Content: item.Snippet, Type: "skill", Score: item.Score})
				}
			}
			return hits, err
		}})
	}
	for _, asset := range page.Items {
		if asset.Type != "llm_wiki" && asset.Type != "code_graph" {
			continue
		}
		if kind != "" && asset.Type != kind && !(kind == "wiki" && asset.Type == "llm_wiki") {
			continue
		}
		a := asset
		ops = append(ops, operation{kind: a.Type, id: a.ID, run: func() ([]Memory, error) {
			if err := s.ValidateContentScope(ctx, binding, a); err != nil {
				return nil, err
			}
			if a.Type == "llm_wiki" {
				var response struct {
					Results []struct {
						Path    string  `json:"path"`
						Title   string  `json:"title"`
						Snippet string  `json:"snippet"`
						Score   float64 `json:"score"`
					} `json:"results"`
				}
				err := s.Client.PanelCall(ctx, binding.InstanceID, "/api/v1/knowledge/wiki/search", reader.Key, map[string]any{"wiki_id": a.ID, "query": query, "limit": 5}, &response)
				hits := []Memory{}
				for _, item := range response.Results {
					hits = append(hits, Memory{ID: item.Path, AssetID: a.ID, AssetType: "llm_wiki", Name: item.Title, Ref: item.Path, Type: "wiki", Content: item.Snippet, Score: item.Score})
				}
				return hits, err
			}
			var response struct {
				Text    string `json:"text"`
				IsError bool   `json:"isError"`
			}
			err := s.Client.PanelCall(ctx, binding.InstanceID, "/api/v1/knowledge/code-graph/search", reader.Key, map[string]any{"code_graph_id": a.ID, "query": query, "limit": 5}, &response)
			if err != nil {
				return nil, err
			}
			if response.IsError {
				return nil, fmt.Errorf("native CodeGraph query failed")
			}
			text := strings.TrimSpace(response.Text)
			if text == "" || strings.HasPrefix(text, "No results found for ") {
				return nil, nil
			}
			return []Memory{{ID: a.ID, AssetID: a.ID, AssetType: "code_graph", Name: a.Name, Type: "code_graph", Content: response.Text}}, nil
		}})
	}
	// Four read requests at a time keep large spaces bounded without blocking
	// unrelated task claims. Context cancellation covers queued operations too.
	parts := make([][]Memory, len(ops))
	warnings := make([]*RetrievalWarning, len(ops))
	var wg sync.WaitGroup
	slots := make(chan struct{}, 4)
	for i, op := range ops {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			case <-ctx.Done():
				warnings[i] = &RetrievalWarning{AssetID: op.id, Type: op.kind, Reason: "Retrieval deadline reached"}
				return
			}
			hits, err := op.run()
			if err != nil {
				reason := "Knowledge service could not complete retrieval"
				var upstream *UpstreamError
				if errors.As(err, &upstream) {
					reason = fmt.Sprintf("Native service returned HTTP %d", upstream.Status)
				}
				warnings[i] = &RetrievalWarning{AssetID: op.id, Type: op.kind, Reason: reason}
				return
			}
			parts[i] = hits
		}()
	}
	wg.Wait()
	for i := range parts {
		result.Items = append(result.Items, parts[i]...)
		if warnings[i] != nil {
			result.Warnings = append(result.Warnings, *warnings[i])
		}
	}
	return result, nil
}

func (s *Service) boundAssets(ctx context.Context, binding db.WorkspaceKnowledge, offset, limit int) (AssetPage, error) {
	reader, err := s.WriterIdentity(ctx, binding)
	if err != nil {
		return AssetPage{}, err
	}
	var page AssetPage
	err = s.Client.Call(ctx, binding.InstanceID, "/v3/meta/agent-fixed-asset/list-with-detail", reader.Key,
		map[string]any{"agent_id": binding.MemoryAgentID, "offset": offset, "limit": limit, "apply_visibility_filter": true}, &page)
	if err != nil {
		return page, err
	}
	page.Offset, page.Limit = offset, limit
	if page.Items == nil {
		page.Items = []Asset{}
	}
	for index, item := range page.Items {
		if err = s.Client.Call(ctx, binding.InstanceID, "/v3/meta/asset/get", reader.Key, map[string]any{"asset_id": item.ID}, &page.Items[index]); err != nil {
			return AssetPage{}, err
		}
		if page.Items[index].TeamID != binding.TeamID {
			return AssetPage{}, fmt.Errorf("asset outside memory team")
		}
	}
	return page, nil
}

func (s *Service) isBoundAsset(ctx context.Context, binding db.WorkspaceKnowledge, reader Identity, id string) (bool, error) {
	for offset := 0; ; offset += 100 {
		var page AssetPage
		err := s.Client.Call(ctx, binding.InstanceID, "/v3/meta/agent-fixed-asset/list-with-detail", reader.Key,
			map[string]any{"agent_id": binding.MemoryAgentID, "offset": offset, "limit": 100, "apply_visibility_filter": true}, &page)
		if err != nil {
			return false, err
		}
		for _, asset := range page.Items {
			if asset.ID == id {
				return true, nil
			}
		}
		if len(page.Items) == 0 || offset+len(page.Items) >= page.Total {
			return false, nil
		}
	}
}
