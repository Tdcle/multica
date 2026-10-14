//go:build agentintegration

package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/knowledge"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestKnowledgeLiveFailedSkillRetry(t *testing.T) {
	if os.Getenv("MULTICA_RUN_REAL_AGENT_SMOKE") != "1" {
		t.Skip("real inference requires explicit opt-in")
	}
	root := os.Getenv("MULTICA_AGENT_MEMORY_CORE_STORAGE_DIR")
	if root == "" || !filepath.IsAbs(root) {
		t.Fatal("fault injection requires the owned local Core storage directory")
	}
	if testHandler == nil {
		t.Fatal("live recovery test requires a database")
	}
	large := os.Getenv("MULTICA_AGENT_MEMORY_LARGE_SOURCE_TEST") == "1"
	timeout := 7 * time.Minute
	if large {
		// The original L1 runner processes ten records per inference call.
		timeout = 35 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
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
	user, err := svc.Queries.GetUser(ctx, parseUUID(testUserID))
	if err != nil {
		t.Fatal(err)
	}
	binding, err := svc.Bind(ctx, parseUUID(testWorkspaceID), user, "", fmt.Sprintf("Recovery %d", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = svc.Queries.DeleteKnowledgeForWorkspace(context.Background(), binding.WorkspaceID)
		_ = svc.Queries.UnbindWorkspaceKnowledge(context.Background(), binding.WorkspaceID)
	})
	go svc.Run(ctx)
	runtimeID := dbfx.Runtime(t, "Recovery memory runtime")
	agentID := dbfx.Agent(t, "Recovery memory agent", runtimeID)
	for {
		memory, e := svc.Queries.GetAgentMemoryBinding(ctx, db.GetAgentMemoryBindingParams{WorkspaceID: binding.WorkspaceID, AgentID: parseUUID(agentID)})
		if e == nil && memory.AgentMemory.Status == "ready" {
			binding = knowledge.MemoryBinding(memory.AgentMemory)
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("recovery memory not provisioned")
		case <-time.After(time.Second):
		}
	}
	issueID := dbfx.Issue(t, "Restore an interrupted knowledge delivery", testutil.Cols{"assignee_type": "agent", "assignee_id": agentID, "description": "Operator procedure: keep completed memory deliveries; rebuild a missing Skill archive from the frozen completed-task source; retry the same archive and task identity once per authorized request; verify final completion before sharing. Never collect a newer issue snapshot during recovery. Decision marker: recovery-orchard-9465. This describes a procedure, not a claim about an unverified successful operation."})
	if large {
		for index := 0; index < 501; index++ {
			dbfx.Comment(t, issueID, fmt.Sprintf("Checkpoint %d: preserve the immutable recovery source; report completion only after its durable receipt.", index))
		}
	}
	testutil.Call(t, testHandler.UpdateIssue, withURLParam(newRequest(http.MethodPatch, "/api/issues/"+issueID, map[string]any{"status": "done"}), "id", issueID)).Want(200)
	type stage struct {
		TaskID       string   `json:"task_id"`
		SessionID    string   `json:"session_id"`
		ArchivedAtMS int64    `json:"archived_at_ms"`
		Complete     bool     `json:"complete"`
		SkillIDs     []string `json:"skill_ids"`
	}
	type receipt struct {
		ChatComplete bool    `json:"chat_complete"`
		Skills       []stage `json:"skills"`
		RetryID      string  `json:"retry_id"`
	}
	var job db.KnowledgeExtraction
	var delivery receipt
	for {
		jobs, err := svc.Queries.ListWorkspaceKnowledgeExtractions(ctx, db.ListWorkspaceKnowledgeExtractionsParams{WorkspaceID: binding.WorkspaceID, Limit: 100})
		if err != nil {
			t.Fatal(err)
		}
		for _, candidate := range jobs {
			if uuidToString(candidate.IssueID) == issueID {
				job = candidate
				_ = json.Unmarshal(candidate.UpstreamResult, &delivery)
			}
		}
		if job.Status == "failed" {
			t.Fatalf("initial extraction failed: %s", job.LastError.String)
		}
		if job.Status == "submitted" && delivery.ChatComplete && len(delivery.Skills) > 0 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("no submitted Skill checkpoint before timeout")
		case <-time.After(100 * time.Millisecond):
		}
	}
	// Hold only this outbox row, so the real Core worker can finish while the
	// application cannot acknowledge completion. This models lost media before ACK.
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var lockedStatus string
	if err := tx.QueryRow(ctx, "SELECT status FROM knowledge_extraction WHERE id=$1 AND workspace_id=$2 FOR UPDATE", job.ID, binding.WorkspaceID).Scan(&lockedStatus); err != nil {
		t.Fatal(err)
	}
	if lockedStatus != "submitted" {
		t.Fatalf("checkpoint moved before injection: %s", lockedStatus)
	}
	current := delivery.Skills[0]
	if current.Complete {
		t.Fatal("Skill was already acknowledged before checkpoint")
	}
	if state := os.Getenv("MULTICA_AGENT_MEMORY_RESTART_TEST_STATE_DIR"); state != "" {
		// Kill only the launcher-owned Core group after durable submission, then
		// restart the real process. The SQL row remains locked before its ACK.
		code := `
const {readFile}=await import('node:fs/promises');
const {execFileSync,spawnSync}=await import('node:child_process');
const {resolve}=await import('node:path');
const dir=process.env.MULTICA_AGENT_MEMORY_RESTART_TEST_STATE_DIR;
const config=JSON.parse(await readFile(dir+'/config.json','utf8'));
if(config.urls.core!==process.env.MULTICA_AGENT_MEMORY_CORE_URL || resolve(config.core.data)!==resolve(process.env.MULTICA_AGENT_MEMORY_CORE_STORAGE_DIR)) throw Error('Restart test must target its managed Core URL and data directory');
const record=JSON.parse(await readFile(dir+'/core.pid.json','utf8'));
const actual=execFileSync('ps',['-p',String(record.child),'-o','lstart=','-o','args='],{encoding:'utf8'}).trim();
if(!record.childFingerprint || actual!==record.childFingerprint) throw Error('Core PID ownership mismatch');
process.kill(-record.child,'SIGKILL');
await new Promise(r=>setTimeout(r,1000));
const result=spawnSync(process.execPath,['../../../scripts/agent-memory.mjs','restart','core'],{env:{...process.env,MULTICA_AGENT_MEMORY_STATE_DIR:dir},encoding:'utf8',timeout:60000});
if(result.status!==0) throw Error(result.stderr || 'Managed Core restart failed');
const after=JSON.parse(await readFile(dir+'/core.pid.json','utf8'));
if(after.child===record.child || after.childFingerprint===record.childFingerprint) throw Error('Core was not replaced');
console.log('Owned Core killed after durable submission; replacement process is healthy');
`
		command := exec.CommandContext(ctx, "node", "--input-type=module", "-e", code)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("managed Core crash/restart: %v: %s", err, output)
		}
		t.Log(string(output))
	}
	archive := filepath.Join(root, "skill_buffer", binding.MemoryUserID, binding.TeamID, binding.MemoryAgentID, current.SessionID, fmt.Sprintf("data-%d.jsonl", current.ArchivedAtMS))
	resultFile := archive + ".result.json"
	scope := knowledge.ScopeFor(binding).Fields()
	scope["session_id"], scope["task_id"], scope["archived_at_ms"] = current.SessionID, current.TaskID, current.ArchivedAtMS
	if os.Getenv("MULTICA_AGENT_MEMORY_RESTART_TEST_STATE_DIR") != "" {
		// Polling is what the application's normal worker does after restart;
		// this test holds its SQL row only to inspect the receipt before ACK.
		var progress json.RawMessage
		if err := client.Call(ctx, binding.InstanceID, "/v3/skill/extract/status", "", scope, &progress); err != nil {
			t.Fatal(err)
		}
	}
	var completedBytes []byte
	var completed struct {
		Status   string   `json:"status"`
		SkillIDs []string `json:"skill_ids"`
	}
	for {
		completedBytes, err = os.ReadFile(resultFile)
		if err == nil && json.Unmarshal(completedBytes, &completed) == nil && completed.Status == "completed" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("Core did not finish before checkpoint timeout")
		case <-time.After(100 * time.Millisecond):
		}
	}
	scope["retry_id"] = uuidToString(job.ID)
	var kept struct {
		Status   string   `json:"status"`
		SkillIDs []string `json:"skill_ids"`
	}
	for {
		err = client.Call(ctx, binding.InstanceID, "/v3/skill/extract/retry", "", scope, &kept)
		if err == nil {
			break
		}
		var upstream *knowledge.UpstreamError
		if !errors.As(err, &upstream) || upstream.Status != http.StatusConflict {
			t.Fatal(err)
		}
		if ctx.Err() != nil {
			t.Fatal(err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if kept.Status != "completed" || !reflect.DeepEqual(kept.SkillIDs, completed.SkillIDs) {
		t.Fatal("completed native batch was replayed or changed")
	}
	unchanged, err := os.ReadFile(resultFile)
	if err != nil || string(unchanged) != string(completedBytes) {
		t.Fatal("completed receipt was modified by retry")
	}
	originalArchive, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(archive); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resultFile, []byte(`{"status":"failed","skill_ids":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "UPDATE knowledge_extraction SET status='failed', attempts=10, last_error='Injected lost Skill archive' WHERE id=$1 AND workspace_id=$2", job.ID, binding.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	retry := func() {
		t.Helper()
		req := withURLParam(newRequest(http.MethodPost, "/api/knowledge/extractions/"+uuidToString(job.ID)+"/retry", nil), "id", uuidToString(job.ID))
		testutil.Call(t, testHandler.RetryKnowledgeExtraction, req).Want(http.StatusNoContent)
	}
	retry()
	retry()
	reset, err := svc.Queries.GetKnowledgeExtractionForWorkspace(ctx, db.GetKnowledgeExtractionForWorkspaceParams{ID: job.ID, WorkspaceID: binding.WorkspaceID})
	if err != nil {
		t.Fatal(err)
	}
	var requested receipt
	if err := json.Unmarshal(reset.UpstreamResult, &requested); err != nil {
		t.Fatal(err)
	}
	if requested.RetryID == "" || !requested.ChatComplete || string(reset.SourcePayload) != string(job.SourcePayload) {
		t.Fatal("retry did not preserve source and completed Chat delivery")
	}
	for {
		recovered, err := svc.Queries.GetKnowledgeExtractionForWorkspace(ctx, db.GetKnowledgeExtractionForWorkspaceParams{ID: job.ID, WorkspaceID: binding.WorkspaceID})
		if err != nil {
			t.Fatal(err)
		}
		if recovered.Status == "failed" {
			t.Fatalf("recovery failed: %s", recovered.LastError.String)
		}
		if recovered.Status == "ready" {
			if string(recovered.SourcePayload) != string(job.SourcePayload) {
				t.Fatal("recovery changed frozen source")
			}
			if large {
				var source struct {
					Messages       []knowledge.Message `json:"messages"`
					SkillBatchEnds []int               `json:"skill_batch_ends"`
				}
				var finalDelivery receipt
				if err := json.Unmarshal(recovered.SourcePayload, &source); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(recovered.UpstreamResult, &finalDelivery); err != nil {
					t.Fatal(err)
				}
				if len(source.Messages) != 503 || len(finalDelivery.Skills) != len(source.SkillBatchEnds) || len(finalDelivery.Skills) < 2 {
					t.Fatalf("large delivery incomplete: messages=%d batches=%+v", len(source.Messages), finalDelivery.Skills)
				}
				for index, batch := range finalDelivery.Skills {
					if !batch.Complete {
						t.Fatalf("native batch %d is not completed", index)
					}
					file := filepath.Join(root, "skill_buffer", binding.MemoryUserID, binding.TeamID, binding.MemoryAgentID, batch.SessionID, fmt.Sprintf("data-%d.jsonl", batch.ArchivedAtMS))
					data, err := os.ReadFile(file)
					if err != nil {
						t.Fatal(err)
					}
					offset := 0
					if index > 0 {
						offset = source.SkillBatchEnds[index-1]
					}
					end := source.SkillBatchEnds[index]
					expected := end - offset
					var archive struct {
						Messages []knowledge.Message `json:"messages"`
					}
					if json.Unmarshal(data, &archive) != nil || len(archive.Messages) != expected {
						t.Fatalf("native archive %d did not preserve all %d source records", index, expected)
					}
					for position, message := range archive.Messages {
						original := source.Messages[offset+position]
						if message.Role != original.Role || message.Content != original.Content || message.ToolName != original.ToolName || message.ToolCallID != original.ToolCallID {
							t.Fatalf("native archive %d changed source record %d", index, offset+position)
						}
					}
				}
				scope := knowledge.ScopeFor(binding).Fields()
				scope["session_id"] = "multica-" + uuidToString(recovered.ID)
				var chat struct {
					Count    int  `json:"message_count"`
					Complete bool `json:"l1_complete"`
				}
				if err := client.Call(ctx, binding.InstanceID, "/v3/conversation/status", "", scope, &chat); err != nil || chat.Count != 503 || !chat.Complete {
					t.Fatalf("large Chat delivery incomplete: %+v %v", chat, err)
				}
				t.Logf("503 frozen records preserved across six Chat chunks and %d completed native Skill archives", len(finalDelivery.Skills))
			}
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("retry did not become ready")
		case <-time.After(time.Second):
		}
	}
	restoredArchive, err := os.ReadFile(archive)
	if err != nil || string(restoredArchive) != string(originalArchive) {
		t.Fatal("missing archive was not restored exactly")
	}
	scope["retry_id"] = requested.RetryID
	var final struct {
		Status  string `json:"status"`
		RetryID string `json:"retry_id"`
	}
	if err := client.Call(ctx, binding.InstanceID, "/v3/skill/extract/status", "", scope, &final); err != nil {
		t.Fatal(err)
	}
	if final.Status != "completed" || final.RetryID != requested.RetryID {
		t.Fatalf("native retry identity was not retained: %+v", final)
	}
	t.Log("lost archive recovered from frozen source; repeated retry kept one native attempt; completed batch preserved")
}
