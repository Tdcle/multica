package daemon

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

// A provider transcript already contains injected text. Refreshing a prompt
// cannot remove that text after a binding/ACL change, so do not resume it.
func gateResumeToKnowledgeScope(task *Task, taskCtx *execenv.TaskContextForEnv, root string) error {
	if task.KnowledgeScope == "" {
		return nil
	}
	path := filepath.Join(root, ".memory_scope")
	prior, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read memory scope: %w", err)
	}
	if task.PriorSessionID != "" && string(prior) != task.KnowledgeScope {
		task.PriorSessionID = ""
		taskCtx.PriorSessionResumed = false
		task.PriorSessionResumeUnavailable = true
		taskCtx.PriorSessionResumeUnavailable = true
	}
	if err := os.WriteFile(path, []byte(task.KnowledgeScope), 0600); err != nil {
		return fmt.Errorf("record memory scope: %w", err)
	}
	return nil
}
