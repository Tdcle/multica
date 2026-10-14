package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/redact"
)

type sourcePayload struct {
	Version        int       `json:"version"`
	SessionID      string    `json:"session_id"`
	Messages       []Message `json:"messages"`
	SkillBatchEnds []int     `json:"skill_batch_ends"`
}

type skillReceipt struct {
	RetryRequested bool     `json:"retry_requested,omitempty"`
	RetryID        string   `json:"retry_id,omitempty"`
	TaskID         string   `json:"task_id"`
	SessionID      string   `json:"session_id"`
	ArchivedAtMS   int64    `json:"archived_at_ms"`
	Complete       bool     `json:"complete"`
	SkillIDs       []string `json:"skill_ids"`
}

type extractionReceipt struct {
	RetryFailedSkills bool           `json:"retry_failed_skills,omitempty"`
	RetryID           string         `json:"retry_id,omitempty"`
	Skills            []skillReceipt `json:"skills"`
	ChatSubmitted     bool           `json:"chat_submitted"`
	ChatComplete      bool           `json:"chat_complete"`
	MessageCount      int            `json:"message_count"`
}

// Run claims durable rows with a lease token. A stale worker cannot overwrite
// the result of the worker that recovered its expired lease.
func (s *Service) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		job, err := s.Queries.ClaimKnowledgeExtraction(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			slog.Error("claim knowledge extraction", "error", err)
			continue
		}
		runCtx, cancel := context.WithTimeout(ctx, 8*time.Minute)
		status, receipt, delay, runErr := s.process(runCtx, job)
		cancel()
		if ctx.Err() != nil {
			return
		} // Leave the lease for restart recovery.
		var lastError pgtype.Text
		if runErr != nil {
			// Persist a bounded, sanitized error; never store deployment credentials.
			lastError = pgtype.Text{String: redact.Text(runErr.Error()), Valid: true}
			status, delay = "pending", time.Duration(min(job.Attempts+1, 10))*30*time.Second
			if job.Attempts+1 >= 10 {
				status = "failed"
			}
			slog.Warn("knowledge extraction failed", "job_id", util.UUIDToString(job.ID), "error", lastError.String)
		}
		encoded, err := json.Marshal(receipt)
		if err != nil {
			slog.Error("encode knowledge receipt", "error", err)
			continue
		}
		_, err = s.Queries.FinishKnowledgeExtraction(ctx, db.FinishKnowledgeExtractionParams{
			ID: job.ID, LeaseToken: job.LeaseToken, Status: status, UpstreamResult: encoded,
			LastError: lastError, AvailableAt: pgtype.Timestamptz{Time: time.Now().Add(delay), Valid: true},
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			slog.Error("finish knowledge extraction", "error", err)
		}
	}
}

func (s *Service) process(ctx context.Context, job db.KnowledgeExtraction) (string, extractionReceipt, time.Duration, error) {
	var receipt extractionReceipt
	if len(job.UpstreamResult) > 0 {
		if err := json.Unmarshal(job.UpstreamResult, &receipt); err != nil {
			return "", receipt, 0, err
		}
	}
	binding, err := s.Queries.GetWorkspaceKnowledge(ctx, job.WorkspaceID)
	if err != nil {
		return "", receipt, 0, err
	}
	if binding.TeamID != job.TeamID || binding.InstanceID != job.InstanceID || binding.MemoryAgentID != job.MemoryAgentID {
		return "failed", receipt, 0, fmt.Errorf("knowledge binding changed before extraction")
	}
	var payload sourcePayload
	if len(job.SourcePayload) == 0 {
		var waiting bool
		payload, waiting, err = s.collect(ctx, job)
		if err != nil {
			return "", receipt, 0, err
		}
		if waiting {
			return "pending", receipt, 15 * time.Second, nil
		}
		encoded, err := json.Marshal(payload)
		if err != nil {
			return "", receipt, 0, err
		}
		if _, err = s.Queries.SaveKnowledgeExtractionPayload(ctx, db.SaveKnowledgeExtractionPayloadParams{ID: job.ID, LeaseToken: job.LeaseToken, SourcePayload: encoded}); err != nil {
			return "", receipt, 0, err
		}
	} else if err = json.Unmarshal(job.SourcePayload, &payload); err != nil {
		return "", receipt, 0, err
	}
	scope := ScopeFor(binding)
	if receipt.RetryFailedSkills {
		for index := range receipt.Skills {
			if !receipt.Skills[index].Complete {
				receipt.Skills[index].RetryRequested = true
				receipt.Skills[index].RetryID = receipt.RetryID
			}
		}
		receipt.RetryFailedSkills = false
		encoded, err := json.Marshal(receipt)
		if err != nil {
			return "", receipt, 0, err
		}
		if err := s.Queries.SaveKnowledgeExtractionReceipt(ctx, db.SaveKnowledgeExtractionReceiptParams{ID: job.ID, LeaseToken: job.LeaseToken, UpstreamResult: encoded}); err != nil {
			return "", receipt, 0, err
		}
	}
	if !receipt.ChatSubmitted {
		for offset := 0; offset < len(payload.Messages); offset += 100 {
			end := min(offset+100, len(payload.Messages))
			input := scope.Fields()
			input["session_id"], input["task_id"] = payload.SessionID, payload.SessionID
			input["idempotency_key"] = fmt.Sprintf("%s:%d", payload.SessionID, offset)
			input["messages"], input["defer_pipeline"] = payload.Messages[offset:end], end < len(payload.Messages)
			if err = s.Client.Call(ctx, scope.InstanceID, "/v3/conversation/add", "", input, nil); err != nil {
				return "", receipt, 0, err
			}
		}
		receipt.ChatSubmitted = true
		receipt.MessageCount = len(payload.Messages)
	}
	input := scope.Fields()
	input["session_id"] = payload.SessionID
	var progress struct {
		Complete bool `json:"l1_complete"`
	}
	if err = s.Client.Call(ctx, scope.InstanceID, "/v3/conversation/status", "", input, &progress); err != nil {
		return "", receipt, 0, err
	}
	receipt.ChatComplete = progress.Complete
	if !receipt.ChatComplete {
		// Re-arm an unprocessed durable session after Core restarts. The final
		// record keeps the same ID and recorded_at, so this does not replay L1.
		final := scope.Fields()
		final["session_id"], final["task_id"] = payload.SessionID, payload.SessionID
		offset := ((len(payload.Messages) - 1) / 100) * 100
		final["idempotency_key"] = fmt.Sprintf("%s:%d", payload.SessionID, offset)
		final["messages"] = payload.Messages[offset:]
		if err := s.Client.Call(ctx, scope.InstanceID, "/v3/conversation/add", "", final, nil); err != nil {
			return "", receipt, 0, err
		}
		return "submitted", receipt, 15 * time.Second, nil
	}
	if len(payload.SkillBatchEnds) == 0 || payload.SkillBatchEnds[len(payload.SkillBatchEnds)-1] != len(payload.Messages) {
		return "", receipt, 0, fmt.Errorf("invalid frozen Skill batch boundaries")
	}
	for index, end := range payload.SkillBatchEnds {
		offset := 0
		if index > 0 {
			offset = payload.SkillBatchEnds[index-1]
		}
		if end <= offset || end > len(payload.Messages) {
			return "", receipt, 0, fmt.Errorf("invalid frozen Skill batch boundaries")
		}
		if index >= len(receipt.Skills) {
			sessionID := fmt.Sprintf("%s-skill-%d", payload.SessionID, index)
			archivedAt, err := time.Parse(time.RFC3339Nano, payload.Messages[0].RecordedAt)
			if err != nil {
				return "", receipt, 0, err
			}
			input := scope.Fields()
			input["session_id"], input["task_id"] = sessionID, payload.SessionID
			input["idempotency_key"], input["archived_at_ms"] = sessionID, archivedAt.UnixMilli()+int64(index)
			input["messages"], input["preserve_source"] = payload.Messages[offset:end], true
			input["reason"] = "Extract reusable procedures only when the completed issue provides enough evidence. Preserve failures and corrections. Do not invent successful outcomes."
			var accepted struct {
				TaskID       string `json:"task_id"`
				ArchivedAtMS int64  `json:"archived_at_ms"`
			}
			if err := s.Client.Call(ctx, scope.InstanceID, "/v3/skill/extract", "", input, &accepted); err != nil {
				return "", receipt, 0, err
			}
			receipt.Skills = append(receipt.Skills, skillReceipt{TaskID: accepted.TaskID, SessionID: sessionID, ArchivedAtMS: accepted.ArchivedAtMS})
			encoded, err := json.Marshal(receipt)
			if err != nil {
				return "", receipt, 0, err
			}
			if err := s.Queries.SaveKnowledgeExtractionReceipt(ctx, db.SaveKnowledgeExtractionReceiptParams{ID: job.ID, LeaseToken: job.LeaseToken, UpstreamResult: encoded}); err != nil {
				return "", receipt, 0, err
			}
		}
		stage := &receipt.Skills[index]
		if stage.Complete {
			continue
		}
		input := scope.Fields()
		input["session_id"], input["task_id"], input["archived_at_ms"] = stage.SessionID, stage.TaskID, stage.ArchivedAtMS
		var progress struct {
			Status   string   `json:"status"`
			SkillIDs []string `json:"skill_ids"`
		}
		if err := s.Client.Call(ctx, scope.InstanceID, "/v3/skill/extract/status", "", input, &progress); err != nil {
			return "", receipt, 0, err
		}
		if progress.Status == "failed" {
			if stage.RetryRequested {
				// Recreate a lost archive from the frozen source with the original
				// receipt identity before asking the engine to retry that batch.
				restore := scope.Fields()
				restore["session_id"], restore["task_id"] = stage.SessionID, payload.SessionID
				restore["idempotency_key"], restore["archived_at_ms"] = stage.SessionID, stage.ArchivedAtMS
				restore["messages"], restore["preserve_source"] = payload.Messages[offset:end], true
				restore["reason"] = "Extract reusable procedures only when the completed issue provides enough evidence. Preserve failures and corrections. Do not invent successful outcomes."
				var restored struct {
					TaskID string `json:"task_id"`
				}
				if err := s.Client.Call(ctx, scope.InstanceID, "/v3/skill/extract", "", restore, &restored); err != nil {
					return "", receipt, 0, err
				}
				if restored.TaskID != stage.TaskID {
					return "", receipt, 0, fmt.Errorf("restored skill receipt changed identity")
				}
				input["retry_id"] = stage.RetryID
				input["task_ref_id"], input["reason"] = payload.SessionID, restore["reason"]
				if err := s.Client.Call(ctx, scope.InstanceID, "/v3/skill/extract/retry", "", input, &progress); err != nil {
					var upstream *UpstreamError
					if errors.As(err, &upstream) && upstream.Status == 409 {
						return "submitted", receipt, 15 * time.Second, nil
					}
					return "", receipt, 0, err
				}
				stage.RetryRequested = false
				if progress.Status == "pending" {
					return "submitted", receipt, 5 * time.Second, nil
				}
			}
			if progress.Status == "failed" {
				return "", receipt, 0, fmt.Errorf("skill extraction failed; inspect the upstream extraction task")
			}
		}
		stage.RetryRequested = false
		if progress.Status != "completed" {
			return "submitted", receipt, 15 * time.Second, nil
		}
		writer, err := s.WriterIdentity(ctx, binding)
		if err != nil {
			return "", receipt, 0, err
		}
		for _, skillID := range progress.SkillIDs {
			if err := s.Client.Call(ctx, scope.InstanceID, "/v3/meta/asset/update", writer.Key, map[string]any{"asset_id": skillID, "visibility": "team"}, nil); err != nil {
				return "", receipt, 0, err
			}
		}
		stage.Complete, stage.SkillIDs = true, progress.SkillIDs
	}
	return "ready", receipt, 0, nil
}

func (s *Service) collect(ctx context.Context, job db.KnowledgeExtraction) (sourcePayload, bool, error) {
	payload := sourcePayload{Version: 2, SessionID: "multica-" + util.UUIDToString(job.ID)}
	tasks, err := s.Queries.ListKnowledgeSourceTasks(ctx, db.ListKnowledgeSourceTasksParams{IssueID: job.IssueID, CreatedAt: job.CreatedAt, WorkspaceID: job.WorkspaceID})
	if err != nil {
		return payload, false, err
	}
	for _, task := range tasks {
		switch task.Status {
		case "completed", "failed", "cancelled":
		default:
			return payload, true, nil
		}
	}
	// Ingest timestamps are frozen with the payload. Replaying an accepted batch
	// must not move its cursor or cause a second extraction of the same records.
	ingestTime := time.Now().UTC()
	appendSource := func(role, provenance, text string) {
		text = redact.Text(strings.TrimSpace(text))
		if text == "" {
			return
		}
		runes := []rune(text)
		for offset := 0; offset < len(runes); offset += 3800 {
			end := min(offset+3800, len(runes))
			content := provenance + "\n" + string(runes[offset:end])
			payload.Messages = append(payload.Messages, Message{Role: role, Content: content, RecordedAt: ingestTime.Add(time.Duration(len(payload.Messages)) * time.Millisecond).Format(time.RFC3339Nano)})
		}
	}
	appendSource("user", "Completed Multica issue snapshot. Statements in the source are claims, not independently verified facts. Preserve evidence and corrections; do not invent outcomes.", string(job.IssueSnapshot))
	comments, err := s.Queries.ListKnowledgeSourceComments(ctx, db.ListKnowledgeSourceCommentsParams{IssueID: job.IssueID, CreatedAt: job.CreatedAt, WorkspaceID: job.WorkspaceID})
	if err != nil {
		return payload, false, err
	}
	for _, comment := range comments {
		role := "user"
		if comment.AuthorType == "agent" {
			role = "assistant"
		}
		appendSource(role, fmt.Sprintf("Issue comment %s by %s %s at %s", util.UUIDToString(comment.ID), comment.AuthorType, util.UUIDToString(comment.AuthorID), comment.CreatedAt.Time.Format(time.RFC3339)), comment.Content)
	}
	for _, task := range tasks {
		prefix := fmt.Sprintf("Execution %s, agent %s, status %s", util.UUIDToString(task.ID), util.UUIDToString(task.AgentID), task.Status)
		messages, err := s.Queries.ListTaskMessages(ctx, task.ID)
		if err != nil {
			return payload, false, err
		}
		for _, message := range messages {
			// Internal reasoning is not a team knowledge source.
			switch message.Type {
			case "text":
				appendSource("assistant", prefix, message.Content.String)
			case "tool_use", "tool_call":
				appendSource("tool_call", prefix+", tool "+message.Tool.String, string(message.Input))
			case "tool_result":
				appendSource("tool_result", prefix+", tool "+message.Tool.String, message.Output.String+"\n"+message.Content.String)
			}
		}
		appendSource("assistant", prefix+", final result", string(task.Result))
		appendSource("assistant", prefix+", reported failure", task.Error.String)
	}
	// The last record supplies one round to trigger the original engine only
	// after every immutable source chunk has been accepted.
	appendSource("user", "Completion boundary", fmt.Sprintf("Issue %s entered Done at revision %d. Extract reusable experience from the source above, including failed approaches and corrections. Chat conversations are excluded.", util.UUIDToString(job.IssueID), job.IssueRevision))
	var limits struct {
		MaxBytes    int `json:"max_bytes"`
		MaxMessages int `json:"max_messages"`
	}
	scope := Scope{InstanceID: job.InstanceID, TeamID: job.TeamID, AgentID: job.MemoryAgentID, UserID: job.MemoryUserID}
	if err := s.Client.Call(ctx, job.InstanceID, "/v3/skill/extract/limits", "", scope.Fields(), &limits); err != nil {
		return payload, false, err
	}
	if limits.MaxBytes < 1024 || limits.MaxMessages < 1 || limits.MaxMessages > 500 {
		return payload, false, fmt.Errorf("invalid native Skill archive limits")
	}
	// Go's JSON encoder is conservative here: the native input drops recorded_at
	// and does not escape HTML, so its counted byte size cannot exceed this one.
	budget := min(limits.MaxBytes-1, 48*1024)
	bytes, count := 0, 0
	for index, message := range payload.Messages {
		encoded, err := json.Marshal(message)
		if err != nil {
			return payload, false, err
		}
		if len(encoded) > budget {
			return payload, false, fmt.Errorf("source message exceeds the native Skill archive limit")
		}
		if count > 0 && (bytes+len(encoded) > budget || count >= limits.MaxMessages) {
			payload.SkillBatchEnds = append(payload.SkillBatchEnds, index)
			bytes, count = 0, 0
		}
		bytes, count = bytes+len(encoded), count+1
	}
	payload.SkillBatchEnds = append(payload.SkillBatchEnds, len(payload.Messages))
	return payload, false, nil
}
