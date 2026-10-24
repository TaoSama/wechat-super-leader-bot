package config_test

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

func TestHelpIgnoresInvalidSkillRoots(t *testing.T) {
	t.Setenv("SKILL_ROOTS", "not-json")
	for _, help := range []string{"--help", "-h"} {
		if cfg, err := config.ParseFlags([]string{help}); cfg != nil || !errors.Is(err, flag.ErrHelp) {
			t.Fatalf("%s must reach standard help with invalid runtime environment: cfg=%+v err=%v", help, cfg, err)
		}
	}
}

func TestManagementIgnoresInvalidRuntimeConfiguration(t *testing.T) {
	t.Setenv("SKILL_ROOTS", "not-json")
	t.Setenv("DAEMON_STATE_DIR", "relative-state")
	t.Setenv(config.DefaultTokenEnv, "")
	for _, action := range []string{"start", "stop", "restart", "status", "uninstall"} {
		t.Run(action, func(t *testing.T) {
			cfg, err := config.ParseFlags([]string{
				"--service", action,
				"--skill-root", "relative-skill",
				"--heartbeat", "0",
				"--desktop-sock", "relative.sock",
				"--token-file", "/fixture-does-not-exist/node.token",
			})
			if err != nil {
				t.Fatalf("management action must not load runtime configuration: %v", err)
			}
			if cfg.ServiceAction != action || len(cfg.SkillRoots) != 0 || cfg.NodeToken != "" {
				t.Fatalf("unexpected management configuration: %+v", cfg)
			}
		})
	}
}

func TestInvalidSkillRootsRemainRejectedInRuntimeModes(t *testing.T) {
	t.Setenv(config.DefaultTokenEnv, "fixture-token")
	roots := make([]string, config.MaxSkillRoots+1)
	for index := range roots {
		roots[index] = fmt.Sprintf("/fixture/skills-%d", index)
	}
	tooManyRoots, err := json.Marshal(roots)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		env  string
		args []string
		want string
	}{
		{name: "malformed-json", env: "not-json", want: "SKILL_ROOTS must be a JSON array"},
		{name: "relative-env-path", env: `["relative"]`, want: "each skill root must be an absolute"},
		{name: "control-character", env: `["/bad\npath"]`, want: "without control characters"},
		{name: "too-many-roots", env: string(tooManyRoots), want: "at most 16 skill roots"},
		{name: "relative-flag-path", env: `[]`, args: []string{"--skill-root", "relative"}, want: "each skill root must be an absolute"},
	}
	modes := []struct {
		name string
		args []string
	}{
		{name: "run"},
		{name: "probe", args: []string{"--probe"}},
		{name: "probe-skills", args: []string{"--probe-skills"}},
		{name: "install", args: []string{"--service", "install"}},
	}
	for _, mode := range modes {
		for _, test := range cases {
			t.Run(mode.name+"/"+test.name, func(t *testing.T) {
				t.Setenv("SKILL_ROOTS", test.env)
				args := append(append([]string(nil), mode.args...), test.args...)
				if _, err := config.ParseFlags(args); err == nil || !strings.Contains(err.Error(), test.want) {
					t.Fatalf("runtime configuration must remain strict: want %q, got %v", test.want, err)
				}
			})
		}
	}
}

func TestSkillRootSourceOrderIsPreserved(t *testing.T) {
	t.Setenv("SKILL_ROOTS", `["/env/one", "/env/two"]`)
	cfg, err := config.ParseFlags([]string{"--probe-skills", "--skill-root", "/flag/one", "--skill-root", "/flag/two"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"/env/one", "/env/two", "/flag/one", "/flag/two"}; !reflect.DeepEqual(cfg.SkillRoots, want) {
		t.Fatalf("skill roots changed source order: got %v, want %v", cfg.SkillRoots, want)
	}
}

func TestModeErrorsPrecedeInvalidSkillRoots(t *testing.T) {
	t.Setenv("SKILL_ROOTS", "not-json")
	for _, test := range []struct {
		name string
		args []string
		want string
	}{
		{name: "invalid-action", args: []string{"--service", "invalid"}, want: "invalid service action"},
		{name: "exclusive-modes", args: []string{"--probe", "--service", "stop"}, want: "choose only one"},
		{name: "positional-argument", args: []string{"--service", "stop", "extra"}, want: "unexpected positional arguments"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := config.ParseFlags(test.args); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("CLI validation must precede runtime environment: want %q, got %v", test.want, err)
			}
		})
	}
}
