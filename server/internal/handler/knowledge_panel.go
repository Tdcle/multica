package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/knowledge"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const knowledgePanelHeader = "X-Multica-Knowledge-Session"
const knowledgePanelTTL = time.Hour

// This capability authenticates only the knowledge gateway. It is encrypted
// with the integration key, never accepted by Multica's regular JWT middleware.
type knowledgePanelTicket struct {
	Purpose          string `json:"purpose"`
	UserID           string `json:"user_id"`
	WorkspaceID      string `json:"workspace_id"`
	TeamID           string `json:"team_id"`
	InstanceID       string `json:"instance_id"`
	BindingCreatedAt string `json:"binding_created_at"`
	ExpiresAt        int64  `json:"expires_at"`
}

func (h *Handler) CreateKnowledgePanelSession(w http.ResponseWriter, r *http.Request) {
	if isMachineCredentialActor(r) {
		writeError(w, 403, "this endpoint is only available to human actors")
		return
	}
	if !h.knowledgeConfigured(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	binding, err := h.Queries.GetWorkspaceKnowledge(r.Context(), parseUUID(workspaceID))
	if err != nil {
		writeError(w, 404, "knowledge space not found")
		return
	}
	if h.Knowledge.Client.PanelURL == "" {
		writeError(w, 503, "knowledge panel is not configured")
		return
	}
	expires := time.Now().Add(knowledgePanelTTL)
	ticket := knowledgePanelTicket{
		Purpose: "knowledge_panel", UserID: requestUserID(r), WorkspaceID: workspaceID,
		TeamID: binding.TeamID, InstanceID: binding.InstanceID,
		BindingCreatedAt: binding.CreatedAt.Time.Format(time.RFC3339Nano), ExpiresAt: expires.Unix(),
	}
	plaintext, err := json.Marshal(ticket)
	if err != nil {
		writeError(w, 500, "failed to create panel session")
		return
	}
	sealed, err := h.Knowledge.Box.Seal(plaintext)
	if err != nil {
		writeError(w, 500, "failed to create panel session")
		return
	}
	// The fragment never enters HTTP requests or access logs. The isolated frame
	// keeps this capability in memory and sends it only in its gateway header.
	panelURL := fmt.Sprintf("/api/knowledge-panel/%s/#session=%s", workspaceID, base64.RawURLEncoding.EncodeToString(sealed))
	writeJSON(w, 200, map[string]any{"url": panelURL, "expires_at": expires.Format(time.RFC3339)})
}

type knowledgePanelCaller struct {
	Binding  db.WorkspaceKnowledge
	Identity knowledge.Identity
	Member   db.Member
	User     db.User
}

func (h *Handler) knowledgePanelCaller(r *http.Request, workspaceID string) (knowledgePanelCaller, error) {
	var caller knowledgePanelCaller
	raw := r.Header.Get(knowledgePanelHeader)
	if len(raw) == 0 || len(raw) > 4096 {
		return caller, errors.New("invalid panel session")
	}
	sealed, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return caller, err
	}
	plaintext, err := h.Knowledge.Box.Open(sealed)
	if err != nil {
		return caller, err
	}
	var ticket knowledgePanelTicket
	if err := json.Unmarshal(plaintext, &ticket); err != nil {
		return caller, err
	}
	if ticket.Purpose != "knowledge_panel" || ticket.WorkspaceID != workspaceID || ticket.ExpiresAt <= time.Now().Unix() {
		return caller, errors.New("invalid panel session")
	}
	userID, ok := parsePanelUUID(ticket.UserID)
	if !ok {
		return caller, errors.New("invalid account")
	}
	wsID, ok := parsePanelUUID(workspaceID)
	if !ok {
		return caller, errors.New("invalid workspace")
	}
	caller.Member, err = h.Queries.GetMemberByUserAndWorkspace(r.Context(), db.GetMemberByUserAndWorkspaceParams{UserID: userID, WorkspaceID: wsID})
	if err != nil {
		return caller, errors.New("workspace access revoked")
	}
	caller.Binding, err = h.Queries.GetWorkspaceKnowledge(r.Context(), wsID)
	if err != nil {
		return caller, err
	}
	if caller.Binding.TeamID != ticket.TeamID || caller.Binding.InstanceID != ticket.InstanceID || caller.Binding.CreatedAt.Time.Format(time.RFC3339Nano) != ticket.BindingCreatedAt {
		return caller, errors.New("knowledge binding changed")
	}
	caller.User, err = h.Queries.GetUser(r.Context(), userID)
	if err != nil {
		return caller, err
	}
	caller.Identity, err = h.Knowledge.IdentityFor(r.Context(), caller.User)
	if err != nil {
		return caller, err
	}
	if err = h.Knowledge.SyncMember(r.Context(), caller.Binding, caller.Identity, caller.Member.Role); err != nil {
		return caller, err
	}
	return caller, nil
}

// Capability fields are untrusted until parsed, even after decryption.
func parsePanelUUID(value string) (pgtype.UUID, bool) {
	id, err := util.ParseUUID(value)
	return id, err == nil
}

// ServeKnowledgePanel exposes only the original Panel bundle and validated
// Panel API requests. It never acts as a general-purpose upstream proxy.
func (h *Handler) ServeKnowledgePanel(w http.ResponseWriter, r *http.Request) {
	if !h.knowledgeConfigured(w) {
		return
	}
	workspaceID := chi.URLParam(r, "workspaceID")
	if _, ok := parsePanelUUID(workspaceID); !ok {
		writeError(w, 400, "invalid workspace")
		return
	}
	tail := chi.URLParam(r, "*")
	if tail == "" {
		tail = "index.html"
	}
	if path.Clean(tail) != tail || strings.ContainsAny(tail, "%\\\x00") {
		writeError(w, 400, "invalid panel path")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	// An opaque sandbox origin is intentional: the upstream app cannot read
	// Multica's local storage or reach its parent DOM. Its capability is its auth.
	w.Header().Set("Access-Control-Allow-Origin", "null")
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Headers", knowledgePanelHeader+",Content-Type,X-Tdai-Service-Id,X-Tdai-User-Key")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors *; object-src 'none'; base-uri 'self'; form-action 'self'")
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}
	if tail == "bootstrap" || strings.HasPrefix(tail, "api/v1/") {
		caller, err := h.knowledgePanelCaller(r, workspaceID)
		if err != nil {
			writeError(w, 401, "knowledge panel session is no longer valid")
			return
		}
		if tail == "bootstrap" {
			h.knowledgePanelBootstrap(w, r, caller)
			return
		}
		h.proxyKnowledgePanelAPI(w, r, caller, "/"+tail)
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, 405, "method not allowed")
		return
	}
	if tail == "bootstrap.js" {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		_, _ = io.WriteString(w, knowledgePanelBootstrapJS)
		return
	}
	if tail != "index.html" && !strings.HasPrefix(tail, "assets/") && tail != "logo.png" && tail != "logo.svg" && tail != "favicon.ico" {
		writeError(w, 404, "panel resource not found")
		return
	}
	response, err := h.panelRequest(r, http.MethodGet, "/"+tail, nil, nil)
	if err != nil {
		writeError(w, 502, "knowledge panel is unavailable")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		writeError(w, response.StatusCode, "panel resource unavailable")
		return
	}
	w.Header().Set("Content-Type", response.Header.Get("Content-Type"))
	prefix := "/api/knowledge-panel/" + workspaceID + "/"
	if tail != "index.html" {
		if strings.HasSuffix(tail, ".js") {
			bundle, err := io.ReadAll(io.LimitReader(response.Body, 32<<20))
			if err != nil {
				writeError(w, 502, "invalid panel bundle")
				return
			}
			// The native app also uses the public logo path inside its JS.
			bundle = bytes.ReplaceAll(bundle, []byte(`"/logo.png"`), []byte(`"`+prefix+`logo.png"`))
			_, _ = w.Write(bundle)
			return
		}
		_, _ = io.Copy(w, io.LimitReader(response.Body, 32<<20))
		return
	}
	document, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		writeError(w, 502, "invalid panel document")
		return
	}
	html := string(document)
	html = strings.ReplaceAll(html, `src="/`, `src="`+prefix)
	html = strings.ReplaceAll(html, `href="/`, `href="`+prefix)
	// Keep the original app intact, but delay its module until identity bootstrap
	// has initialized the frame's isolated in-memory storage and scoped fetch.
	modules := panelModuleRE.FindAllStringSubmatch(html, -1)
	startup := []string{}
	for _, match := range modules {
		startup = append(startup, match[1])
	}
	if len(startup) == 0 {
		writeError(w, 502, "invalid panel entry point")
		return
	}
	html = panelModuleRE.ReplaceAllString(html, "")
	encoded, _ := json.Marshal(startup)
	html = strings.Replace(html, "</head>", `<script>window.__MULTICA_PANEL_MODULES__=`+string(encoded)+`;</script><script type="module" src="`+prefix+`bootstrap.js"></script></head>`, 1)
	_, _ = io.WriteString(w, html)
}

var panelModuleRE = regexp.MustCompile(`<script\b[^>]*type="module"[^>]*src="([^"]+)"[^>]*>\s*</script>`)

func (h *Handler) panelRequest(r *http.Request, method, p string, body []byte, headers http.Header) (*http.Response, error) {
	req, err := http.NewRequestWithContext(r.Context(), method, h.Knowledge.Client.PanelURL+p, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if headers != nil {
		req.Header = headers
	}
	return h.Knowledge.Client.HTTP.Do(req)
}

func (h *Handler) knowledgePanelBootstrap(w http.ResponseWriter, r *http.Request, caller knowledgePanelCaller) {
	if r.Method != http.MethodGet {
		writeError(w, 405, "method not allowed")
		return
	}
	var verified struct {
		Valid bool            `json:"valid"`
		User  json.RawMessage `json:"user"`
	}
	err := h.Knowledge.Client.Call(r.Context(), caller.Binding.InstanceID, "/v3/meta/auth/verify", "", map[string]any{"user_key": caller.Identity.Key}, &verified)
	if err != nil || !verified.Valid {
		writeError(w, 401, "knowledge account access denied")
		return
	}
	var profile map[string]any
	if err := json.Unmarshal(verified.User, &profile); err != nil {
		writeError(w, 502, "invalid knowledge account profile")
		return
	}
	profile["display_name"] = caller.User.Name
	// No original account key is delivered to the browser.
	writeJSON(w, 200, map[string]any{"session": map[string]any{"instanceId": caller.Binding.InstanceID, "instanceName": caller.Binding.Name, "userKey": "multica-panel", "user": profile}, "team_id": caller.Binding.TeamID, "workspace_id": uuidToString(caller.Binding.WorkspaceID), "can_manage_space": caller.Member.Role == "owner" || caller.Member.Role == "admin"})
}

func (h *Handler) proxyKnowledgePanelAPI(w http.ResponseWriter, r *http.Request, caller knowledgePanelCaller, p string) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		writeError(w, 405, "method not allowed")
		return
	}
	body := map[string]any{}
	if r.Method == http.MethodPost {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&body); (err != nil && !errors.Is(err, io.EOF)) || body == nil {
			writeError(w, 400, "invalid panel request")
			return
		}
	}
	if err := h.scopeKnowledgePanelRequest(r, caller, p, body); err != nil {
		writeError(w, 403, "resource is outside this knowledge space")
		return
	}
	if p == "/api/v1/meta/team/list" {
		var team map[string]any
		if err := h.Knowledge.Client.Call(r.Context(), caller.Binding.InstanceID, "/v3/meta/team/get", caller.Identity.Key, map[string]any{"team_id": caller.Binding.TeamID}, &team); err != nil {
			h.knowledgeError(w, "get panel team", err)
			return
		}
		items := []any{team}
		if offset, ok := body["offset"].(float64); ok && offset > 0 {
			items = []any{}
		}
		writeJSON(w, 200, map[string]any{"code": 0, "message": "ok", "data": map[string]any{"items": items, "total": 1, "limit": 100, "offset": body["offset"]}})
		return
	}
	if p == "/api/v1/meta/auth/verify" {
		body["user_key"] = caller.Identity.Key
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		writeError(w, 400, "invalid panel request")
		return
	}
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	headers.Set("X-Tdai-Service-Id", caller.Binding.InstanceID)
	headers.Set("X-Tdai-User-Key", caller.Identity.Key)
	response, err := h.panelRequest(r, r.Method, p, encoded, headers)
	if err != nil {
		writeError(w, 502, "knowledge panel request failed")
		return
	}
	defer response.Body.Close()
	result, err := io.ReadAll(io.LimitReader(response.Body, 16<<20))
	if err != nil {
		writeError(w, 502, "invalid panel response")
		return
	}
	if p == "/api/v1/meta/auth/verify" && response.StatusCode == 200 {
		var envelope map[string]any
		if err := json.Unmarshal(result, &envelope); err != nil {
			writeError(w, 502, "invalid knowledge account profile")
			return
		}
		if data, ok := envelope["data"].(map[string]any); ok {
			if profile, ok := data["user"].(map[string]any); ok {
				profile["display_name"] = caller.User.Name
			}
		}
		result, err = json.Marshal(envelope)
		if err != nil {
			writeError(w, 502, "invalid knowledge account profile")
			return
		}
	}
	if p == "/api/v1/meta/team/list" && response.StatusCode == 200 {
		var env map[string]any
		if err := json.Unmarshal(result, &env); err != nil {
			writeError(w, 502, "invalid panel response")
			return
		}
		if data, ok := env["data"].(map[string]any); ok {
			filtered := []any{}
			if items, ok := data["items"].([]any); ok {
				for _, item := range items {
					if team, ok := item.(map[string]any); ok && team["team_id"] == caller.Binding.TeamID {
						filtered = append(filtered, item)
					}
				}
			}
			data["items"], data["total"] = filtered, len(filtered)
		}
		result, _ = json.Marshal(env)
	}
	if p == "/api/v1/meta/user-key/list" && response.StatusCode == 200 {
		var envelope map[string]any
		if err := json.Unmarshal(result, &envelope); err != nil {
			writeError(w, 502, "invalid panel response")
			return
		}
		if data, ok := envelope["data"].(map[string]any); ok {
			filtered := []any{}
			if items, ok := data["items"].([]any); ok {
				for _, item := range items {
					if key, ok := item.(map[string]any); ok && key["is_default"] != true {
						filtered = append(filtered, item)
					}
				}
			}
			data["items"] = filtered
			if total, ok := data["total"].(float64); ok {
				data["total"] = max(total-1, 0)
			}
		}
		result, _ = json.Marshal(envelope)
	}
	w.Header().Set("Content-Type", response.Header.Get("Content-Type"))
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(result)
}

func (h *Handler) scopeKnowledgePanelRequest(r *http.Request, caller knowledgePanelCaller, p string, body map[string]any) error {
	allowed := false
	for _, prefix := range []string{"/api/v1/meta/", "/api/v1/knowledge/", "/api/v1/skill/", "/api/v1/chat-memory/", "/api/v1/agent-overview/", "/api/v1/agent/", "/api/v1/task/", "/api/v1/analytics/"} {
		if strings.HasPrefix(p, prefix) {
			allowed = true
			break
		}
	}
	if !allowed || p == "/api/v1/knowledge/status-callback" {
		return errors.New("unsupported panel API")
	}
	binding := caller.Binding
	if caller.Member.Role != "owner" && caller.Member.Role != "admin" {
		if strings.HasPrefix(p, "/api/v1/meta/team/") && p != "/api/v1/meta/team/get" && p != "/api/v1/meta/team/list" {
			return errors.New("workspace admin access required")
		}
		if strings.HasPrefix(p, "/api/v1/meta/team-member/") && p != "/api/v1/meta/team-member/get" && p != "/api/v1/meta/team-member/list" {
			return errors.New("workspace admin access required")
		}
	}
	if p == "/api/v1/meta/acl/revoke" {
		var acl struct {
			AssetID string `json:"asset_id"`
		}
		if err := h.Knowledge.Client.Call(r.Context(), binding.InstanceID, "/v3/meta/acl/get", caller.Identity.Key, map[string]any{"id": body["id"]}, &acl); err != nil {
			return err
		}
		body["asset_id"] = acl.AssetID
	}
	references := 0
	var check func(map[string]any, int) error
	check = func(values map[string]any, depth int) error {
		if depth > 32 {
			return errors.New("request nesting exceeds limit")
		}
		for key, value := range values {
			if key == "team_id" {
				if value != nil {
					if id, ok := value.(string); !ok || (id != "" && id != binding.TeamID) {
						return errors.New("wrong team")
					}
				}
			}
			if key == "space_id" || key == "instance_id" {
				if value != nil {
					if id, ok := value.(string); !ok || (id != "" && id != binding.InstanceID) {
						return errors.New("wrong instance")
					}
				}
			}
			if key == "team_ids" {
				if ids, ok := value.([]any); ok {
					for _, id := range ids {
						references++
						if references > 200 {
							return errors.New("too many resources")
						}
						if id != binding.TeamID {
							return errors.New("wrong team")
						}
					}
				} else {
					return errors.New("invalid teams")
				}
			}
			kind := ""
			switch key {
			case "asset_id", "asset_ids", "wiki_id", "wiki_ids", "code_graph_id", "code_graph_ids", "skill_id", "skill_ids", "source_asset_id", "resource_id", "knowledge_id", "block_id", "block_ids":
				kind = "asset"
			case "agent_id", "agent_ids", "owner_agent_id", "source_agent_id", "target_agent_id", "template_agent_id":
				kind = "agent"
			case "subject_id":
				if values["subject_type"] == "agent" {
					kind = "agent"
				}
			case "task_id", "task_ids":
				// Engine task IDs are freeform source provenance. Only native
				// task management routes address metadata task entities.
				if strings.HasPrefix(p, "/api/v1/meta/task/") || strings.HasPrefix(p, "/api/v1/meta/task-agent/") || strings.HasPrefix(p, "/api/v1/task/") {
					kind = "task"
				}
			}
			if kind != "" {
				ids := []string{}
				switch v := value.(type) {
				case string:
					if v != "" {
						ids = append(ids, v)
					}
				case []any:
					for _, item := range v {
						id, ok := item.(string)
						if !ok {
							return errors.New("invalid resource ID")
						}
						ids = append(ids, id)
					}
				case nil:
				default:
					return errors.New("invalid resource ID")
				}
				if len(ids) > 200 {
					return errors.New("too many resources")
				}
				for _, id := range ids {

					var entity struct {
						TeamID string `json:"team_id"`
						Type   string `json:"asset_type"`
					}
					err := h.Knowledge.Client.Call(r.Context(), binding.InstanceID, "/v3/meta/"+kind+"/get", caller.Identity.Key, map[string]any{kind + "_id": id}, &entity)
					var missing *knowledge.UpstreamError
					if p == "/api/v1/meta/asset/create" && errors.As(err, &missing) && missing.Status == 404 {
						continue
					}
					if err != nil && (key == "code_graph_id" || key == "code_graph_ids") {
						var upstream *knowledge.UpstreamError
						if errors.As(err, &upstream) && upstream.Status == 404 {
							var pending struct {
								TeamID  string `json:"team_id"`
								OwnerID string `json:"owner_user_id"`
							}
							if lookupErr := h.Knowledge.Client.KnowledgeResource(r.Context(), binding.InstanceID, "code-graph", id, &pending); lookupErr == nil && pending.TeamID == binding.TeamID && pending.OwnerID == caller.Identity.ID {
								entity.TeamID, err = pending.TeamID, nil
							}
						}
					}
					if err != nil || entity.TeamID != binding.TeamID {
						return errors.New("wrong resource scope")
					}
					if kind == "asset" {
						if err := h.Knowledge.ValidateContentScope(r.Context(), binding, knowledge.Asset{ID: id, Type: entity.Type}); err != nil {
							return err
						}
					}
				}
			}
			if nested, ok := value.(map[string]any); ok {
				if err := check(nested, depth+1); err != nil {
					return err
				}
			}
			if array, ok := value.([]any); ok {
				for _, item := range array {
					if nested, ok := item.(map[string]any); ok {
						if err := check(nested, depth+1); err != nil {
							return err
						}
					}
				}
			}
		}
		return nil
	}
	if err := check(body, 0); err != nil {
		return err
	}
	if strings.HasSuffix(p, "/list") || strings.HasSuffix(p, "/list-accessible") || strings.HasSuffix(p, "/listing") || strings.HasSuffix(p, "/search") || strings.HasSuffix(p, "/create") || strings.HasPrefix(p, "/api/v1/chat-memory/") || strings.HasSuffix(p, "/team-assets") || strings.HasSuffix(p, "/my-assets") || p == "/api/v1/task/list-with-agents" || strings.HasPrefix(p, "/api/v1/analytics/") {
		body["team_id"] = binding.TeamID
	}
	if strings.HasPrefix(p, "/api/v1/meta/user-key/") && p != "/api/v1/meta/user-key/list" && p != "/api/v1/meta/user-key/create" {
		keyID, _ := body["key_id"].(string)
		var key struct {
			Default bool `json:"is_default"`
		}
		if err := h.Knowledge.Client.Call(r.Context(), binding.InstanceID, "/v3/meta/user-key/get", caller.Identity.Key, map[string]any{"key_id": keyID}, &key); err != nil || key.Default {
			return errors.New("managed integration key cannot be changed")
		}
	}
	if strings.HasPrefix(p, "/api/v1/meta/user-key/") || strings.HasPrefix(p, "/api/v1/meta/config/user/") || strings.HasPrefix(p, "/api/v1/meta/user-session-default/") {
		body["user_id"] = caller.Identity.ID
	}
	return nil
}

const knowledgePanelBootstrapJS = `
const prefix = new URL('.', import.meta.url).pathname;
let ticket = new URLSearchParams(location.hash.slice(1)).get('session');
if (!ticket) throw new Error('Knowledge panel session is required');
history.replaceState(null, '', prefix + '#/memory');
const memory = new Map();
const storage = {getItem: key => memory.get(String(key)) ?? null, setItem: (key,value) => memory.set(String(key), String(value)), removeItem: key => memory.delete(String(key)), clear: () => memory.clear(), key: index => [...memory.keys()][index] ?? null, get length() { return memory.size; }};
Object.defineProperty(window, 'localStorage', {value:storage});
Object.defineProperty(window, 'sessionStorage', {value:storage});
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
 const resource = new URL(input instanceof Request ? input.url : String(input), location.href);
 if (resource.pathname.startsWith('/api/v1/')) resource.pathname = prefix + resource.pathname.slice(1);
 if (resource.pathname.startsWith(prefix)) {
  const headers = new Headers(input instanceof Request ? input.headers : init.headers);
  headers.set('X-Multica-Knowledge-Session', ticket);
  const options = {...init, headers, credentials:'omit'};
  return originalFetch(input instanceof Request ? new Request(resource, input) : resource, options);
 }
 return originalFetch(input, init);
};
const response = await fetch(prefix + 'bootstrap');
if (!response.ok) {document.getElementById('root').textContent = 'Knowledge panel session expired. Reload the knowledge tab.'; throw new Error('Knowledge identity bootstrap failed');}
const context = await response.json();
window.__MULTICA_PANEL_CONTEXT__ = {can_manage_space: context.can_manage_space === true};
localStorage.setItem('tdai-panel.session', JSON.stringify(context.session));
localStorage.setItem('tdai-memory.activeTeam.v1', context.team_id);
for (const entry of window.__MULTICA_PANEL_MODULES__) await import(entry);
`
