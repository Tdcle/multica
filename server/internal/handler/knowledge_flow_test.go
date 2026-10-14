package handler

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestKnowledgeDoneLifecycle(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	seedTestCatalog(t)
	custom := createTestCustomStatus(t, "knowledge_verified", issuestatus.Done)
	dbfx.InsertNoID(t, "workspace_knowledge", testutil.Cols{
		"workspace_id": testWorkspaceID, "instance_id": "knowledge-e2e",
		"team_id": "knowledge-e2e-team", "name": "Knowledge lifecycle",
		"memory_agent_id": "knowledge-e2e-agent", "memory_user_id": "knowledge-e2e-user",
		"created_by": testUserID,
	}, "workspace_id = $1", parseUUID(testWorkspaceID))
	issueID := dbfx.Issue(t, "Knowledge completion lifecycle")
	foreignWorkspaceID := dbfx.Insert(t, "workspace", testutil.Cols{"name": "Knowledge foreign source", "slug": "knowledge-source-" + issueID, "issue_prefix": "KFS"})
	dbfx.Comment(t, issueID, "Workspace-owned source")
	// Older data can carry inconsistent issue/workspace references. Exporters
	// must enforce both tenant columns before freezing such a record.
	dbfx.Comment(t, issueID, "Foreign source must not be exported", testutil.Cols{"workspace_id": foreignWorkspaceID})
	runtimeID := dbfx.Runtime(t, "Knowledge source runtime")
	agentID := dbfx.Agent(t, "Knowledge source agent", runtimeID)
	dbfx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": runtimeID, "status": "completed"})
	dbfx.Cleanup(t, "DELETE FROM knowledge_extraction WHERE issue_id = $1", parseUUID(issueID))
	patch := func(status string) {
		t.Helper()
		req := testutil.WithURLParams(newRequest(http.MethodPatch, "/api/issues/"+issueID,
			map[string]any{"status": status}), "id", issueID)
		testutil.Call(t, testHandler.UpdateIssue, req).Want(http.StatusOK)
	}
	count := func(want int) {
		t.Helper()
		got := dbfx.Count(t, "SELECT count(*) FROM knowledge_extraction WHERE issue_id = $1", parseUUID(issueID))
		if got != want {
			t.Fatalf("completion transitions produced %d extraction jobs, want %d", got, want)
		}
	}
	patch("in_progress")
	patch("in_review")
	count(0)
	patch(custom.Key)
	count(1)
	patch(custom.Key)
	patch("done")
	count(1)
	jobs, err := testHandler.Queries.ListWorkspaceKnowledgeExtractions(ctx, db.ListWorkspaceKnowledgeExtractionsParams{
		WorkspaceID: parseUUID(testWorkspaceID), Limit: 10,
	})
	if err != nil || len(jobs) != 1 || jobs[0].TeamID != "knowledge-e2e-team" || jobs[0].Status != "pending" {
		t.Fatalf("expected one durable, workspace-scoped pending extraction: jobs=%v err=%v", jobs, err)
	}
	comments, err := testHandler.Queries.ListKnowledgeSourceComments(ctx, db.ListKnowledgeSourceCommentsParams{IssueID: parseUUID(issueID), WorkspaceID: parseUUID(testWorkspaceID), CreatedAt: jobs[0].CreatedAt})
	if err != nil || len(comments) != 1 || comments[0].Content != "Workspace-owned source" {
		t.Fatalf("source comment tenant boundary failed: %v %v", comments, err)
	}
	tasks, err := testHandler.Queries.ListKnowledgeSourceTasks(ctx, db.ListKnowledgeSourceTasksParams{IssueID: parseUUID(issueID), WorkspaceID: parseUUID(testWorkspaceID), CreatedAt: jobs[0].CreatedAt})
	if err != nil || len(tasks) != 1 {
		t.Fatalf("owned execution source missing: %v", err)
	}
	foreignTasks, err := testHandler.Queries.ListKnowledgeSourceTasks(ctx, db.ListKnowledgeSourceTasksParams{IssueID: parseUUID(issueID), WorkspaceID: parseUUID(foreignWorkspaceID), CreatedAt: jobs[0].CreatedAt})
	if err != nil || len(foreignTasks) != 0 {
		t.Fatalf("execution sources crossed workspaces: %v", err)
	}
	patch("todo")
	patch("done")
	count(2)

	// A terminal write rolled back with its enclosing transaction must leave
	// no extraction event for the worker to publish later.
	patch("todo")
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	_, err = testHandler.Queries.WithTx(tx).UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{
		ID: parseUUID(issueID), WorkspaceID: parseUUID(testWorkspaceID), Status: "done",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	count(2)

	if err := testHandler.Queries.UnbindWorkspaceKnowledge(ctx, parseUUID(testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
	patch("done")
	count(2)
}

func TestKnowledgeExtractionLeaseRecovery(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	dbfx.InsertNoID(t, "workspace_knowledge", testutil.Cols{"workspace_id": testWorkspaceID, "instance_id": "lease-e2e", "team_id": "lease-e2e-team", "name": "Lease recovery", "memory_agent_id": "lease-e2e-agent", "memory_user_id": "lease-e2e-user", "created_by": testUserID}, "workspace_id = $1", parseUUID(testWorkspaceID))
	issueID := dbfx.Issue(t, "Knowledge lease recovery")
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	q := testHandler.Queries.WithTx(tx)
	if _, err := q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{ID: parseUUID(issueID), WorkspaceID: parseUUID(testWorkspaceID), Status: "done"}); err != nil {
		t.Fatal(err)
	}
	jobs, err := q.ListWorkspaceKnowledgeExtractions(ctx, db.ListWorkspaceKnowledgeExtractionsParams{WorkspaceID: parseUUID(testWorkspaceID), Limit: 100})
	if err != nil || len(jobs) != 1 {
		t.Fatalf("expected one transactional outbox row: %v %v", jobs, err)
	}
	// Keep this uncommitted test row first in the global queue. Other workers
	// cannot see it, and rollback protects every row from test mutations.
	if _, err := tx.Exec(ctx, "UPDATE knowledge_extraction SET created_at=now()-interval '100 years' WHERE id=$1", jobs[0].ID); err != nil {
		t.Fatal(err)
	}
	first, err := q.ClaimKnowledgeExtraction(ctx)
	if err != nil || first.ID != jobs[0].ID {
		t.Fatalf("test row was not claimed: %v", err)
	}
	payload := []byte(`{"version":1,"session_id":"lease-recovery","messages":[{"role":"user","content":"Frozen source"}]}`)
	saved, err := q.SaveKnowledgeExtractionPayload(ctx, db.SaveKnowledgeExtractionPayloadParams{ID: first.ID, LeaseToken: first.LeaseToken, SourcePayload: payload})
	if err != nil {
		t.Fatal(err)
	}
	payload = saved.SourcePayload
	if _, err := tx.Exec(ctx, "UPDATE knowledge_extraction SET lease_until=now()-interval '1 second' WHERE id=$1", first.ID); err != nil {
		t.Fatal(err)
	}
	recovered, err := q.ClaimKnowledgeExtraction(ctx)
	if err != nil || recovered.LeaseToken == first.LeaseToken {
		t.Fatalf("expired lease was not replaced: %v", err)
	}
	if string(recovered.SourcePayload) != string(payload) {
		t.Fatal("recovery changed the frozen source")
	}
	finish := func(token pgtype.UUID, status string, lastError pgtype.Text) error {
		_, err := q.FinishKnowledgeExtraction(ctx, db.FinishKnowledgeExtractionParams{ID: first.ID, LeaseToken: token, Status: status, UpstreamResult: []byte(`{"chat_submitted":true}`), LastError: lastError, AvailableAt: pgtype.Timestamptz{Time: time.Now().Add(-time.Second), Valid: true}})
		return err
	}
	if err := finish(first.LeaseToken, "ready", pgtype.Text{}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("stale worker overwrote recovered row: %v", err)
	}
	for i := 0; i < 15; i++ {
		if recovered.Attempts != 0 {
			t.Fatalf("waiting consumed retry budget after %d polls: %d", i, recovered.Attempts)
		}
		if err := finish(recovered.LeaseToken, "pending", pgtype.Text{}); err != nil {
			t.Fatal(err)
		}
		recovered, err = q.ClaimKnowledgeExtraction(ctx)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := finish(recovered.LeaseToken, "failed", pgtype.Text{String: "Transient upstream failure", Valid: true}); err != nil {
		t.Fatal(err)
	}
	retried, err := q.RetryKnowledgeExtraction(ctx, db.RetryKnowledgeExtractionParams{ID: first.ID, WorkspaceID: parseUUID(testWorkspaceID)})
	if err != nil || retried.Attempts != 0 || retried.LastError.Valid || string(retried.SourcePayload) != string(payload) {
		t.Fatalf("manual retry did not reset failure budget and preserve source: %v %v", retried, err)
	}
}
