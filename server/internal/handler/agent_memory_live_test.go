//go:build agentintegration

package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/knowledge"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestMemoryServiceOfflineRecovery(t *testing.T) {
	if os.Getenv("MULTICA_RUN_REAL_AGENT_SMOKE") != "1" {
		t.Skip("requires local native services")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	target, err := url.Parse(os.Getenv("MULTICA_AGENT_MEMORY_CORE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	var available atomic.Bool
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !available.Load() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"code":503,"data":null}`))
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	defer gateway.Close()
	client, err := knowledge.NewClient(gateway.URL, os.Getenv("MULTICA_AGENT_MEMORY_PANEL_URL"), os.Getenv("MULTICA_AGENT_MEMORY_PROXY_URL"), os.Getenv("MULTICA_AGENT_MEMORY_API_KEY"), os.Getenv("MULTICA_AGENT_MEMORY_ADMIN_KEY"))
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
	instance := os.Getenv("MULTICA_AGENT_MEMORY_INSTANCE_ID")
	if instance == "" {
		instance = "default"
	}
	svc := &knowledge.Service{Client: client, Queries: testHandler.Queries, Box: box, InstanceID: instance, TxStarter: testPool}
	runtimeID := dbfx.Runtime(t, "Offline memory runtime")
	agentID := dbfx.Agent(t, "Agent created during memory outage", runtimeID)
	// Run with this checkout's API stopped so only the test worker claims rows.
	query := func() db.GetAgentMemoryBindingRow {
		t.Helper()
		m, e := svc.Queries.GetAgentMemoryBinding(ctx, db.GetAgentMemoryBindingParams{WorkspaceID: parseUUID(testWorkspaceID), AgentID: parseUUID(agentID)})
		if e != nil {
			t.Fatal(e)
		}
		return m
	}
	memory := query()
	if memory.AgentMemory.Status != "pending" {
		t.Fatal("agent creation must leave durable pending memory")
	}
	go svc.Run(ctx)
	for {
		memory = query()
		if memory.AgentMemory.LastError.Valid {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("outage did not persist retry state")
		case <-time.After(200 * time.Millisecond):
		}
	}
	if memory.AgentMemory.Status != "pending" || memory.AgentMemory.NativeAgentID != "" {
		t.Fatal("outage must not prevent agent creation or fake ready memory")
	}
	if _, err := svc.Queries.GetAgent(ctx, parseUUID(agentID)); err != nil {
		t.Fatal("agent disappeared during outage")
	}
	available.Store(true)
	for {
		memory = query()
		if memory.AgentMemory.Status == "ready" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("memory did not recover automatically")
		case <-time.After(200 * time.Millisecond):
		}
	}
	if memory.AgentMemory.NativeAgentID == "" || memory.AgentMemory.LastError.Valid {
		t.Fatal("recovery did not bind native memory and clear the error")
	}
	// Deleting the native container independently must detach only its binding.
	identity, err := svc.WriterIdentity(ctx, knowledge.MemoryBinding(memory.AgentMemory))
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"archive", "delete"} {
		input := map[string]any{"agent_id": memory.AgentMemory.NativeAgentID}
		if operation == "delete" {
			input = map[string]any{"agent_ids": []string{memory.AgentMemory.NativeAgentID}}
		}
		if err = client.Call(ctx, instance, "/v3/meta/agent/"+operation, identity.Key, input, nil); err != nil {
			t.Fatal(err)
		}
	}
	dbfx.Exec(t, "UPDATE agent_memory SET available_at=now() WHERE id=$1", memory.AgentMemory.ID)
	for {
		_, err = svc.Queries.GetAgentMemoryBinding(ctx, db.GetAgentMemoryBindingParams{WorkspaceID: parseUUID(testWorkspaceID), AgentID: parseUUID(agentID)})
		if err != nil {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("native deletion was not reconciled")
		case <-time.After(200 * time.Millisecond):
		}
	}
	if _, err := svc.Queries.GetAgent(ctx, parseUUID(agentID)); err != nil {
		t.Fatal("native deletion removed the Multica agent")
	}
	t.Log("agent survived outage; pending memory recovered automatically; native deletion detached memory independently")
}
