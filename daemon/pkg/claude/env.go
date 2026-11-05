package claude

import (
	"os"
	"strings"
)

// inheritedEnv is the exact set of daemon variables a resumed turn may see.
// Controller credentials, node tokens and unrelated secrets are never passed.
var inheritedEnv = []string{
	"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
	"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
}

// inheritedEnvPrefixes cover Claude Code settings and Anthropic API authentication.
// Cloud-provider credentials are deliberately not forwarded.
var inheritedEnvPrefixes = []string{"ANTHROPIC_", "CLAUDE_CODE_"}

const configDirEnv = "CLAUDE_CONFIG_DIR"

// runEnv builds the child environment. CLAUDE_CONFIG_DIR always comes from the
// configured projects root, never from the daemon's own environment.
func runEnv(source []string, configDir string) []string {
	allowed := make(map[string]bool, len(inheritedEnv))
	for _, key := range inheritedEnv {
		allowed[key] = true
	}
	var env []string
	for _, entry := range source {
		key, _, found := strings.Cut(entry, "=")
		if !found || key == configDirEnv || key == "CLAUDE_CODE_PROJECT_DIR_NAME" {
			continue
		}
		permitted := allowed[key]
		for _, prefix := range inheritedEnvPrefixes {
			permitted = permitted || strings.HasPrefix(key, prefix)
		}
		if permitted {
			env = append(env, entry)
		}
	}
	if configDir != "" {
		env = append(env, configDirEnv+"="+configDir)
	}
	return env
}

func daemonEnv() []string { return os.Environ() }
