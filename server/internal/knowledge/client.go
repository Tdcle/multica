// Package knowledge integrates the upstream memory engine without changing its
// extraction, knowledge compilation, or retrieval algorithms.
package knowledge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	CoreURL      string
	KnowledgeURL string
	KnowledgeKey string
	PanelURL     string
	ProxyURL     string
	APIKey       string
	AdminKey     string
	HTTP         *http.Client
}

type UpstreamError struct {
	Status int
	Code   int
	Path   string
}

func (e *UpstreamError) Error() string {
	return fmt.Sprintf("agent memory %s returned HTTP %d (code %d)", e.Path, e.Status, e.Code)
}

func NewClient(coreURL, panelURL, proxyURL, apiKey, adminKey string) (*Client, error) {
	for _, endpoint := range []string{coreURL, panelURL, proxyURL} {
		if endpoint == "" {
			continue
		}
		u, err := url.Parse(endpoint)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return nil, fmt.Errorf("invalid agent memory service URL")
		}
	}
	if coreURL == "" || apiKey == "" || adminKey == "" {
		return nil, fmt.Errorf("agent memory core URL, API key, and admin key are required")
	}
	return &Client{
		CoreURL: strings.TrimRight(coreURL, "/"), PanelURL: strings.TrimRight(panelURL, "/"),
		ProxyURL: strings.TrimRight(proxyURL, "/"), APIKey: apiKey, AdminKey: adminKey,
		HTTP: &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}, nil
}

// Call keeps deployment credentials on the backend. Callers must derive tenant
// identity from a persisted workspace binding, never from an agent's arguments.
func (c *Client) Call(ctx context.Context, instanceID, path, userKey string, input, output any) error {
	return c.call(ctx, c.CoreURL, c.APIKey, instanceID, path, userKey, input, output)
}

func (c *Client) PanelCall(ctx context.Context, instanceID, path, userKey string, input, output any) error {
	if c.PanelURL == "" || userKey == "" || !strings.HasPrefix(path, "/api/v1/") {
		return fmt.Errorf("invalid knowledge panel request")
	}
	return c.call(ctx, c.PanelURL, "", instanceID, path, userKey, input, output)
}

func (c *Client) ConfigureKnowledge(endpoint, key string) error {
	if endpoint == "" && key == "" {
		return nil
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || key == "" {
		return fmt.Errorf("invalid knowledge service configuration")
	}
	c.KnowledgeURL, c.KnowledgeKey = strings.TrimRight(endpoint, "/"), key
	return nil
}

func (c *Client) KnowledgeResource(ctx context.Context, instanceID, kind, id string, output any) error {
	if c.KnowledgeURL == "" {
		return fmt.Errorf("knowledge service is not configured")
	}
	if kind != "wiki" && kind != "code-graph" {
		return fmt.Errorf("invalid knowledge resource type")
	}
	idField := "wiki_id"
	if kind == "code-graph" {
		idField = "code_graph_id"
	}
	return c.call(ctx, c.KnowledgeURL, c.KnowledgeKey, instanceID, "/v3/"+kind+"/get", "", map[string]any{idField: id}, output)
}

func (c *Client) call(ctx context.Context, endpoint, apiKey, instanceID, path, userKey string, input, output any) error {
	validPath := strings.HasPrefix(path, "/v3/") || (endpoint == c.PanelURL && strings.HasPrefix(path, "/api/v1/"))
	if instanceID == "" || !validPath || strings.ContainsAny(path, "?#") {
		return fmt.Errorf("invalid agent memory request scope")
	}
	payload, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("encode agent memory request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	req.Header.Set("x-tdai-service-id", instanceID)
	if userKey != "" {
		req.Header.Set("x-tdai-user-key", userKey)
	}
	response, err := c.HTTP.Do(req)
	if err != nil {
		// The URL can contain deployment details; do not put transport errors
		// carrying those details in user-visible extraction status.
		return fmt.Errorf("agent memory request %s failed: %w", path, err)
	}
	defer response.Body.Close()
	reader := io.LimitReader(response.Body, 16<<20)
	var envelope struct {
		Code *int            `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(reader).Decode(&envelope); err != nil || envelope.Code == nil {
		return fmt.Errorf("agent memory %s returned an invalid response", path)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || *envelope.Code != 0 {
		return &UpstreamError{Status: response.StatusCode, Code: *envelope.Code, Path: path}
	}
	if output != nil {
		if len(envelope.Data) == 0 || bytes.Equal(envelope.Data, []byte("null")) {
			return fmt.Errorf("agent memory %s returned no data", path)
		}
		if err := json.Unmarshal(envelope.Data, output); err != nil {
			return fmt.Errorf("decode agent memory %s response: %w", path, err)
		}
	}
	return nil
}

type Team struct {
	ID      string `json:"team_id"`
	Name    string `json:"name"`
	OwnerID string `json:"owner_user_id"`
}

type Scope struct {
	InstanceID string
	TeamID     string
	AgentID    string
	UserID     string
}

func (s Scope) Fields() map[string]any {
	return map[string]any{"team_id": s.TeamID, "agent_id": s.AgentID, "user_id": s.UserID}
}

type Message struct {
	Role       string `json:"role"`
	Content    string `json:"content"`
	ToolName   string `json:"tool_name,omitempty"`
	ToolCallID string `json:"tool_call_id,omitempty"`
	RecordedAt string `json:"recorded_at,omitempty"`
}

type Memory struct {
	AssetID    string  `json:"asset_id,omitempty"`
	AssetType  string  `json:"asset_type,omitempty"`
	Name       string  `json:"name,omitempty"`
	Ref        string  `json:"ref,omitempty"`
	ID         string  `json:"id"`
	Content    string  `json:"content"`
	Background string  `json:"background"`
	TaskID     string  `json:"task_id"`
	Type       string  `json:"type"`
	Score      float64 `json:"score"`
}

func (c *Client) Search(ctx context.Context, scope Scope, query string, limit int) ([]Memory, error) {
	input := scope.Fields()
	input["query"], input["limit"] = query, limit
	// task_id and session_id are source provenance, not retrieval filters:
	// supplying the current task here would hide all historical experience.
	var result struct {
		Items []Memory `json:"items"`
	}
	if err := c.Call(ctx, scope.InstanceID, "/v3/atomic/search", "", input, &result); err != nil {
		return nil, err
	}
	return result.Items, nil
}

func (c *Client) MemoriesForTask(ctx context.Context, scope Scope, taskID string) ([]Memory, error) {
	input := scope.Fields()
	input["task_id"], input["limit"] = taskID, 100
	var result struct {
		Items []Memory `json:"items"`
	}
	if err := c.Call(ctx, scope.InstanceID, "/v3/atomic/query", "", input, &result); err != nil {
		return nil, err
	}
	return result.Items, nil
}
