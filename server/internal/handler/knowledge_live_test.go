//go:build agentintegration

package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon"
	"github.com/multica-ai/multica/server/internal/knowledge"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	"github.com/multica-ai/multica/server/pkg/agent"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestKnowledgeLiveDoneToAgentClaim(t *testing.T) {
	if os.Getenv("MULTICA_RUN_REAL_AGENT_SMOKE") != "1" {
		t.Skip("real inference requires explicit opt-in")
	}
	if os.Getenv("MULTICA_KNOWLEDGE_CODEX_MODEL") == "" || os.Getenv("MULTICA_KNOWLEDGE_CLI_PATH") == "" {
		t.Fatal("live test requires MULTICA_KNOWLEDGE_CODEX_MODEL and MULTICA_KNOWLEDGE_CLI_PATH")
	}
	if testHandler == nil {
		t.Fatal("live test requires a database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Minute)
	defer cancel()
	client, err := knowledge.NewClient(os.Getenv("MULTICA_AGENT_MEMORY_CORE_URL"), os.Getenv("MULTICA_AGENT_MEMORY_PANEL_URL"), os.Getenv("MULTICA_AGENT_MEMORY_PROXY_URL"), os.Getenv("MULTICA_AGENT_MEMORY_API_KEY"), os.Getenv("MULTICA_AGENT_MEMORY_ADMIN_KEY"))
	if err != nil {
		t.Fatal(err)
	}
	key, err := secretbox.LoadKey("MULTICA_AGENT_MEMORY_SECRET_KEY")
	if err != nil {
		t.Fatal(err)
	}
	box, err := secretbox.New(key)
	if err != nil {
		t.Fatal(err)
	}
	instanceID := os.Getenv("MULTICA_AGENT_MEMORY_INSTANCE_ID")
	if instanceID == "" {
		instanceID = "default"
	}
	svc := &knowledge.Service{Client: client, Queries: testHandler.Queries, Box: box, InstanceID: instanceID, TxStarter: testPool}
	previous := testHandler.Knowledge
	testHandler.Knowledge = svc
	t.Cleanup(func() { testHandler.Knowledge = previous })
	user, err := testHandler.Queries.GetUser(ctx, parseUUID(testUserID))
	if err != nil {
		t.Fatal(err)
	}
	binding, err := svc.Bind(ctx, parseUUID(testWorkspaceID), user, "", fmt.Sprintf("Claim recall %d", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = testHandler.Queries.DeleteKnowledgeForWorkspace(context.Background(), binding.WorkspaceID)
		_ = testHandler.Queries.UnbindWorkspaceKnowledge(context.Background(), binding.WorkspaceID)
	})
	go svc.Run(ctx)
	sourceDescription := "Engineering decision: knowledge requests must derive team_id, agent_id and user_id from the persisted workspace binding. Never accept these IDs from task arguments. This prevents agents from accessing another workspace's knowledge. This records the decision and rationale, not a claim that all permission tests passed."
	sourceID := dbfx.Issue(t, "Knowledge scope architecture", testutil.Cols{"description": sourceDescription})
	sourceRuntimeID := dbfx.Runtime(t, "Knowledge producer runtime")
	sourceAgentID := dbfx.Agent(t, "Knowledge producer agent", sourceRuntimeID)
	waitMemory := func(agentID string) db.GetAgentMemoryBindingRow {
		t.Helper()
		for {
			m, e := svc.Queries.GetAgentMemoryBinding(ctx, db.GetAgentMemoryBindingParams{WorkspaceID: parseUUID(testWorkspaceID), AgentID: parseUUID(agentID)})
			if e == nil && m.AgentMemory.Status == "ready" {
				return m
			}
			select {
			case <-ctx.Done():
				t.Fatalf("memory not ready: %v", e)
			case <-time.After(time.Second):
			}
		}
	}
	producerMemory := waitMemory(sourceAgentID)
	binding = knowledge.MemoryBinding(producerMemory.AgentMemory)
	sourceTaskID := dbfx.Task(t, sourceAgentID, testutil.Cols{"issue_id": sourceID, "runtime_id": sourceRuntimeID})
	var producer struct {
		Task *AgentTaskResponse `json:"task"`
	}
	claimProducer := withURLParam(newDaemonTokenRequest(http.MethodPost, "/api/daemon/runtimes/"+sourceRuntimeID+"/tasks/claim", nil, testWorkspaceID, "claim-reclaim-review"), "runtimeId", sourceRuntimeID)
	testutil.Call(t, testHandler.ClaimTaskByRuntime, claimProducer).Want(200).JSON(&producer)
	if producer.Task == nil || producer.Task.ID != sourceTaskID {
		t.Fatal("producer task was not claimed")
	}
	startProducer := withURLParam(newDaemonTokenRequest(http.MethodPost, "/api/daemon/tasks/"+sourceTaskID+"/start", nil, testWorkspaceID, "claim-reclaim-review"), "taskId", sourceTaskID)
	testutil.Call(t, testHandler.StartTask, startProducer).Want(200)
	produced := executeKnowledgeProducerCodex(t, ctx, *producer.Task, sourceDescription)
	finishProducer := withURLParam(newDaemonTokenRequest(http.MethodPost, "/api/daemon/tasks/"+sourceTaskID+"/complete", map[string]any{"output": produced.Output, "session_id": produced.SessionID}, testWorkspaceID, "claim-reclaim-review"), "taskId", sourceTaskID)
	testutil.Call(t, testHandler.CompleteTask, finishProducer).Want(200)
	if count := dbfx.Count(t, "SELECT count(*) FROM knowledge_extraction WHERE issue_id=$1", parseUUID(sourceID)); count != 0 {
		t.Fatal("agent completion extracted memory before the issue entered Done")
	}
	req := withURLParam(newRequest(http.MethodPatch, "/api/issues/"+sourceID, map[string]any{"status": "done"}), "id", sourceID)
	testutil.Call(t, testHandler.UpdateIssue, req).Want(http.StatusOK)
	var sourceJob db.KnowledgeExtraction
	for {
		jobs, err := svc.Queries.ListWorkspaceKnowledgeExtractions(ctx, db.ListWorkspaceKnowledgeExtractionsParams{WorkspaceID: binding.WorkspaceID, Limit: 100})
		if err != nil {
			t.Fatal(err)
		}
		ready := false
		for _, job := range jobs {
			if uuidToString(job.IssueID) == sourceID {
				sourceJob = job
				ready = job.Status == "ready"
				if job.Status == "failed" {
					t.Fatalf("extraction failed: %s", job.LastError.String)
				}
			}
		}
		if ready {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("extraction did not become ready: %v", ctx.Err())
		case <-time.After(3 * time.Second):
		}
	}
	runtimeID := dbfx.Runtime(t, "Knowledge recall runtime")
	agentID := dbfx.Agent(t, "Knowledge recall agent", runtimeID)
	if agentID == sourceAgentID {
		t.Fatal("producer and reader must be different agents")
	}
	readerMemory := waitMemory(agentID)
	issueID := dbfx.Issue(t, "Apply workspace binding scope isolation to new knowledge requests")
	taskID := dbfx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": runtimeID})
	claim := func() AgentTaskResponse {
		t.Helper()
		req := withURLParam(newDaemonTokenRequest(http.MethodPost, "/api/daemon/runtimes/"+runtimeID+"/tasks/claim", nil, testWorkspaceID, "claim-reclaim-review"), "runtimeId", runtimeID)
		var response struct {
			Task *AgentTaskResponse `json:"task"`
		}
		testutil.Call(t, testHandler.ClaimTaskByRuntime, req).Want(http.StatusOK).JSON(&response)
		if response.Task == nil {
			t.Fatal("task was not claimed")
		}
		return *response.Task
	}
	isolated := claim()
	if strings.Contains(isolated.KnowledgeContext, "multica-"+uuidToString(sourceJob.ID)) {
		t.Fatal("another agent received private memory")
	}
	foreignAsset := "chat_memory-" + binding.TeamID + "-" + binding.MemoryAgentID
	isolatedReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, os.Getenv("NEXT_PUBLIC_API_URL")+"/api/knowledge/assets/"+foreignAsset+"?agent_id="+sourceAgentID, nil)
	isolatedReq.Header.Set("Authorization", "Bearer "+isolated.AuthToken)
	isolatedResp, e := http.DefaultClient.Do(isolatedReq)
	if e != nil {
		t.Fatal(e)
	}
	isolatedResp.Body.Close()
	if isolatedResp.StatusCode != 404 && isolatedResp.StatusCode != 403 {
		t.Fatalf("agent crossed private memory boundary: %d", isolatedResp.StatusCode)
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed' WHERE id=$1", taskID)
	// Explicitly move the independent memory to another agent, then consume it.
	for _, id := range []string{sourceAgentID, agentID} {
		testutil.Call(t, testHandler.BindAgentMemory, withURLParam(newRequest(http.MethodPut, "/api/agents/"+id+"/memory", map[string]any{"memory_id": nil}), "id", id)).Want(200)
	}
	testutil.Call(t, testHandler.BindAgentMemory, withURLParam(newRequest(http.MethodPut, "/api/agents/"+agentID+"/memory", map[string]any{"memory_id": uuidToString(producerMemory.AgentMemory.ID)}), "id", agentID)).Want(200)
	if readerMemory.AgentMemory.ID == producerMemory.AgentMemory.ID {
		t.Fatal("agents started with the same memory")
	}
	taskID = dbfx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": runtimeID})
	claimed := claim()
	if claimed.ID != taskID || !claimed.KnowledgeAvailable || !strings.Contains(claimed.KnowledgeContext, "multica-"+uuidToString(sourceJob.ID)) {
		t.Fatalf("claim omitted historical source memory: task=%s knowledge=%s", claimed.ID, claimed.KnowledgeContext)
	}
	// Prove the daemon renders the same claimed context in the turn prompt.
	prompt := daemon.BuildPrompt(daemon.Task{IssueID: issueID, KnowledgeAvailable: claimed.KnowledgeAvailable, KnowledgeContext: claimed.KnowledgeContext}, "codex")
	if !strings.Contains(prompt, claimed.KnowledgeContext) || !strings.Contains(prompt, "multica knowledge search") {
		t.Fatal("daemon prompt omitted claim-time knowledge")
	}
	identity, err := svc.IdentityFor(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	assetID := "chat_memory-" + binding.TeamID + "-" + binding.MemoryAgentID
	apiURL := os.Getenv("NEXT_PUBLIC_API_URL")
	if apiURL == "" {
		t.Fatal("live HTTP test requires NEXT_PUBLIC_API_URL")
	}
	foreignWorkspace := dbfx.Workspace(t, "Knowledge token scope", "knowledge-token-"+uuidToString(parseUUID(taskID)))
	request := func(path string) (int, []byte) {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+claimed.AuthToken)
		req.Header.Set("X-Workspace-ID", foreignWorkspace)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, body
	}
	status, body := request("/api/knowledge/assets?workspace_id=" + foreignWorkspace)
	if status != 200 || !strings.Contains(string(body), assetID) {
		t.Fatalf("task token did not retain its bound workspace: HTTP %d %s", status, body)
	}
	status, body = request("/api/knowledge/retrieve?type=chat_memory&q=" + url.QueryEscape("workspace scope isolation"))
	var retrieved knowledge.Retrieval
	if status != 200 || json.Unmarshal(body, &retrieved) != nil || len(retrieved.Items) == 0 {
		t.Fatalf("task on-demand retrieval failed: HTTP %d %s", status, body)
	}
	// The real task credential cannot mint a human panel capability.
	reqPanel, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL+"/api/knowledge/panel-session", nil)
	if err != nil {
		t.Fatal(err)
	}
	reqPanel.Header.Set("Authorization", "Bearer "+claimed.AuthToken)
	panelResponse, err := http.DefaultClient.Do(reqPanel)
	if err != nil {
		t.Fatal(err)
	}
	panelResponse.Body.Close()
	if panelResponse.StatusCode != 403 {
		t.Fatalf("task credential minted human panel capability: %d", panelResponse.StatusCode)
	}
	executeKnowledgeReaderCodex(t, ctx, claimed, prompt, apiURL, assetID)
	if err := client.Call(ctx, binding.InstanceID, "/v3/meta/asset/update", identity.Key, map[string]any{"asset_id": assetID, "visibility": "private"}, nil); err != nil {
		t.Fatal(err)
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed' WHERE id=$1", taskID)
	privateTaskID := dbfx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": runtimeID})
	privateClaim := claim()
	if privateClaim.ID != privateTaskID || !strings.Contains(privateClaim.KnowledgeContext, assetID) {
		t.Fatalf("bound private memory was omitted from agent claim: %s", privateClaim.KnowledgeContext)
	}
	memories, err := svc.SearchFor(ctx, binding, "workspace scope", 10, &identity)
	if err != nil || len(memories) == 0 {
		t.Fatalf("native owner ACL was not preserved: memories=%d err=%v", len(memories), err)
	}
	memories, err = svc.SearchFor(ctx, binding, "workspace scope", 10, nil)
	if err != nil || len(memories) == 0 {
		t.Fatalf("agent failed to retrieve its bound private history: memories=%d err=%v", len(memories), err)
	}
}

func executeKnowledgeProducerCodex(t *testing.T, parent context.Context, task AgentTaskResponse, description string) agent.Result {
	t.Helper()
	codexPath, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	backend, err := agent.New("codex", agent.Config{ExecutablePath: codexPath, BuiltinRuntime: true, TaskID: task.ID})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	prompt := "Produce an engineering decision from this brief: " + description + "\nExplain the three persisted identifiers and why client-supplied scope is unsafe. Include the result marker orchard-scope-8427. This marker belongs to your execution result, not the issue description. Do not claim any implementation or permission test has passed. Do not use tools or modify resources."
	session, err := backend.Execute(ctx, prompt, agent.ExecOptions{Cwd: t.TempDir(), Model: os.Getenv("MULTICA_KNOWLEDGE_CODEX_MODEL"), Timeout: 2 * time.Minute, ExtraArgs: []string{"-c", `approval_policy="never"`, "-c", "features.skip_host_skill_discovery=true", "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "apps", "--disable", "plugins", "--disable", "multi_agent", "--disable", "browser_use", "--disable", "computer_use"}})
	if err != nil {
		t.Fatal(err)
	}
	for range session.Messages {
	}
	result := <-session.Result
	if result.Status != "completed" || !strings.Contains(result.Output, "orchard-scope-8427") {
		t.Fatalf("producer execution failed: status=%s error=%s", result.Status, result.Error)
	}
	t.Logf("real producer agent completed in %dms; marker exists only in its execution result", result.DurationMs)
	return result
}

func executeKnowledgeReaderCodex(t *testing.T, parent context.Context, task AgentTaskResponse, prompt, apiURL, assetID string) {
	t.Helper()
	// This helper is called only inside the explicitly opted-in live test.
	cliPath := os.Getenv("MULTICA_KNOWLEDGE_CLI_PATH")
	if cliPath == "" || !filepath.IsAbs(cliPath) {
		t.Fatal("live execution requires a built CLI at MULTICA_KNOWLEDGE_CLI_PATH")
	}
	if _, err := os.Stat(cliPath); err != nil {
		t.Fatal(err)
	}
	codexPath, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	backend, err := agent.New("codex", agent.Config{ExecutablePath: codexPath, BuiltinRuntime: true, TaskID: task.ID, Env: map[string]string{"MULTICA_TOKEN": task.AuthToken, "MULTICA_SERVER_URL": apiURL, "MULTICA_WORKSPACE_ID": task.WorkspaceID, "MULTICA_AGENT_ID": task.AgentID, "MULTICA_TASK_ID": task.ID, "PATH": filepath.Dir(cliPath) + string(os.PathListSeparator) + os.Getenv("PATH")}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(parent, 3*time.Minute)
	defer cancel()
	model := os.Getenv("MULTICA_KNOWLEDGE_CODEX_MODEL")
	if model == "" {
		t.Fatal("set MULTICA_KNOWLEDGE_CODEX_MODEL to a model in the local Codex account catalog")
	}
	instruction := prompt + "\n\nThis is a read-only acceptance task. Execute `multica knowledge search \"workspace scope isolation\"` and `multica knowledge read " + assetID + " --layer L0`. From those actual results, report the historical decision marker and explain which identifiers must come from the persisted workspace binding. Do not modify any resource, post comments or change issue status."
	session, err := backend.Execute(ctx, instruction, agent.ExecOptions{Cwd: t.TempDir(), Model: model, Timeout: 3 * time.Minute, ExtraArgs: []string{"-c", `sandbox_mode="workspace-write"`, "-c", `sandbox_workspace_write.network_access=true`, "-c", `approval_policy="never"`, "-c", "features.skip_host_skill_discovery=true", "--disable", "apps", "--disable", "plugins", "--disable", "multi_agent", "--disable", "browser_use", "--disable", "computer_use"}})
	if err != nil {
		t.Fatal(err)
	}
	usedSearch, usedRead := false, false
	searchReturned, readReturned := false, false
	searchCalls, readCalls := map[string]bool{}, map[string]bool{}
	for message := range session.Messages {
		if message.Type == agent.MessageToolUse {
			input, _ := json.Marshal(message.Input)
			searchCalls[message.CallID] = strings.Contains(string(input), "knowledge search")
			readCalls[message.CallID] = strings.Contains(string(input), "knowledge read")
			usedSearch = usedSearch || searchCalls[message.CallID]
			usedRead = usedRead || readCalls[message.CallID]
		}
		if message.Type == agent.MessageToolResult {
			if searchCalls[message.CallID] && strings.Contains(message.Output, assetID) && strings.Contains(message.Output, `"items"`) {
				searchReturned = true
			}
			if readCalls[message.CallID] && strings.Contains(message.Output, "orchard-scope-8427") {
				readReturned = true
			}
		}
	}
	result := <-session.Result
	if result.Status != "completed" {
		t.Fatalf("real Codex task failed: status=%s error=%s", result.Status, result.Error)
	}
	if !usedSearch || !usedRead || !searchReturned || !readReturned || !strings.Contains(result.Output, "orchard-scope-8427") {
		t.Fatalf("real Codex did not receive scoped tool results and recall the historical marker: search=%v read=%v search_result=%v read_result=%v output=%s", usedSearch, usedRead, searchReturned, readReturned, result.Output)
	}
	for _, scope := range []string{"team_id", "agent_id", "user_id"} {
		if !strings.Contains(result.Output, scope) {
			t.Fatalf("real Codex omitted recalled scope %s: %s", scope, result.Output)
		}
	}
	t.Logf("real Codex provider used workspace knowledge search/read and recalled prior task evidence in %dms", result.DurationMs)
}
