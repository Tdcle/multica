package execenv

import (
	"fmt"
	"os"
	"path/filepath"
)

// ConfigureCLI binds child commands to the CLI running this daemon. The absolute
// entry remains usable even when an explicitly nested login shell changes PATH.
func ConfigureCLI(env map[string]string, executable, inheritedPath string) error {
	if !filepath.IsAbs(executable) {
		return fmt.Errorf("Multica CLI executable must be an absolute path")
	}
	env["MULTICA_CLI_PATH"] = executable
	env["PATH"] = filepath.Dir(executable) + string(os.PathListSeparator) + inheritedPath
	return nil
}
