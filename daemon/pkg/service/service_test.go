package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

type recordedCall struct {
	name string
	args []string
}

type fakeRunner struct {
	calls   []recordedCall
	handler func(name string, args ...string) ([]byte, error)
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	copied := append([]string(nil), args...)
	f.calls = append(f.calls, recordedCall{name: name, args: copied})
	if f.handler != nil {
		return f.handler(name, copied...)
	}
	return nil, nil
}

func sampleConfig(t *testing.T, stateDir string) *config.Config {
	t.Helper()
	return &config.Config{
		NodeID:            "node-alpha",
		ControllerURL:     "wss://leader.taoai.site/v1/daemon",
		NodeToken:         "super-secret-node-token-do-not-leak",
		SocketPath:        filepath.Join(stateDir, "codex.sock"),
		DesktopSocketPath: filepath.Join(stateDir, "desktop.sock"),
		CodexHome:         filepath.Join(stateDir, "codex data"),
		HeartbeatInterval: 20 * time.Second,
		StateDir:          stateDir,
		SkillRoots: []string{
			filepath.Join(stateDir, "skills one"),
			filepath.Join(stateDir, "skills&two"),
		},
	}
}

func TestGeneratePlistXMLEscapingAndTokenIsolation(t *testing.T) {
	tmp := t.TempDir()
	stateDir := filepath.Join(tmp, "state & dir <1>")
	cfg := sampleConfig(t, stateDir)
	cfg.NodeID = "mac \"air\" & <node> $1 %s"
	tokenFile := ResolveTokenFilePath(stateDir)
	binPath := filepath.Join(tmp, "bin with space", "super-leader-daemon")

	plist, err := GeneratePlistXML(binPath, cfg, tokenFile)
	if err != nil {
		t.Fatalf("GeneratePlistXML failed: %v", err)
	}
	if strings.Contains(plist, cfg.NodeToken) {
		t.Fatalf("plist must never contain raw NodeToken")
	}
	for _, want := range []string{
		darwinManagedMarker,
		"<string>" + DarwinPlistLabel + "</string>",
		"<string>--token-file</string>",
		"<string>--desktop-sock</string>",
		"<string>--codex-home</string>",
		"state &amp; dir &lt;1&gt;/codex data",
		"state &amp; dir &lt;1&gt;/desktop.sock",
		"<string>--heartbeat</string>",
		"<string>20</string>",
		"<key>Umask</key><integer>63</integer>",
		"mac &#34;air&#34; &amp; &lt;node&gt; $1 %s",
		"state &amp; dir &lt;1&gt;/daemon.stdout.log",
		"state &amp; dir &lt;1&gt;/daemon.stderr.log",
	} {
		if !strings.Contains(plist, want) {
			t.Errorf("plist missing expected fragment %q in:\n%s", want, plist)
		}
	}
	if _, err := GeneratePlistXML("", cfg, tokenFile); err == nil {
		t.Fatal("expected error for empty binary path")
	}
}

func TestGenerateSystemdUnitEscapingAndTokenIsolation(t *testing.T) {
	tmp := t.TempDir()
	stateDir := filepath.Join(tmp, "state $HOME %i \"quote\" \\slash")
	cfg := sampleConfig(t, stateDir)
	cfg.NodeID = "linux-$NODE-%H-\"x\"\\y"
	tokenFile := ResolveTokenFilePath(stateDir)
	binPath := filepath.Join(tmp, "bin space", "super-leader-daemon")

	unit, err := GenerateSystemdUnit(binPath, cfg, tokenFile)
	if err != nil {
		t.Fatalf("GenerateSystemdUnit failed: %v", err)
	}
	if strings.Contains(unit, cfg.NodeToken) {
		t.Fatalf("systemd unit must never contain raw NodeToken")
	}
	for _, want := range []string{
		linuxManagedMarker,
		"\"--token-file\"",
		"\"--desktop-sock\"",
		"\"--codex-home\"",
		"\"--heartbeat\" \"20\"",
		"\"linux-$$NODE-%%H-\\\"x\\\"\\\\y\"",
		"UMask=0077",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit missing expected fragment %q in:\n%s", want, unit)
		}
	}
	if _, err := EscapeSystemdArg("bad\narg"); err == nil {
		t.Fatal("expected control character rejection in EscapeSystemdArg")
	}
	if _, err := GenerateSystemdUnit("", cfg, tokenFile); err == nil {
		t.Fatal("expected error for empty binary path")
	}
}

func TestAtomicWriteAndTokenPermissionsAndSymlinkRejection(t *testing.T) {
	tmp := t.TempDir()
	stateDir := filepath.Join(tmp, "state")

	tokenPath, err := WritePrivateTokenFile(stateDir, "secret-token-value")
	if err != nil {
		t.Fatalf("WritePrivateTokenFile failed: %v", err)
	}
	dirInfo, err := os.Stat(stateDir)
	if err != nil {
		t.Fatalf("stat stateDir: %v", err)
	}
	if got := dirInfo.Mode().Perm(); got != 0700 {
		t.Fatalf("expected stateDir mode 0700, got %04o", got)
	}
	tokInfo, err := os.Stat(tokenPath)
	if err != nil {
		t.Fatalf("stat tokenPath: %v", err)
	}
	if got := tokInfo.Mode().Perm(); got != 0600 {
		t.Fatalf("expected token file mode 0600, got %04o", got)
	}
	for _, badToken := range []string{"", "   ", "tok\nen", "tok\x00en"} {
		if _, err := WritePrivateTokenFile(stateDir, badToken); err == nil {
			t.Fatalf("expected invalid token %q to be rejected", badToken)
		}
	}
	if _, err := WritePrivateTokenFile("relative/state", "valid-token"); err == nil {
		t.Fatal("expected relative stateDir to be rejected")
	}

	realTarget := filepath.Join(tmp, "real-file")
	if err := os.WriteFile(realTarget, []byte("original"), 0600); err != nil {
		t.Fatalf("write realTarget: %v", err)
	}
	symlinkPath := filepath.Join(tmp, "symlink-target")
	if err := os.Symlink(realTarget, symlinkPath); err != nil {
		t.Fatalf("create symlink: %v", err)
	}
	if err := AtomicWriteFile(symlinkPath, []byte("overwrite"), 0600); err == nil {
		t.Fatal("expected AtomicWriteFile to reject symlink target")
	}
	if err := InstallManagedBinary("", symlinkPath); err == nil {
		t.Fatal("expected InstallManagedBinary to reject symlink destination")
	}

	if err := os.Remove(tokenPath); err != nil {
		t.Fatalf("remove tokenPath: %v", err)
	}
	if err := os.Symlink(realTarget, tokenPath); err != nil {
		t.Fatalf("symlink tokenPath: %v", err)
	}
	if _, err := WritePrivateTokenFile(stateDir, "new-token"); err == nil {
		t.Fatal("expected WritePrivateTokenFile to reject symlink token path")
	}
	data, err := os.ReadFile(realTarget)
	if err != nil || string(data) != "original" {
		t.Fatalf("symlink target was modified: %q (%v)", string(data), err)
	}
}

func TestDarwinManagerLifecycleOwnershipAndUninstallPreservesState(t *testing.T) {
	ctx := context.Background()
	homeDir := t.TempDir()
	stateDir := filepath.Join(t.TempDir(), "daemon-state")
	cfg := sampleConfig(t, stateDir)

	runner := &fakeRunner{
		handler: func(name string, args ...string) ([]byte, error) {
			if len(args) > 0 && args[0] == "print" {
				return []byte("Could not find service"), errors.New("exit status 113")
			}
			return nil, nil
		},
	}
	mgrIface, err := NewManagerWithRunnerAndHome("darwin", runner, homeDir)
	if err != nil {
		t.Fatalf("NewManagerWithRunnerAndHome darwin: %v", err)
	}
	mgr := mgrIface.(*DarwinManager)
	mgr.UID = 501

	if err := mgr.Install(ctx, cfg); err != nil {
		t.Fatalf("Darwin Install failed: %v", err)
	}
	if !reflect.DeepEqual(runner.calls, []recordedCall{
		{name: "launchctl", args: []string{"enable", mgr.ServiceTarget()}},
		{name: "launchctl", args: []string{"bootstrap", mgr.DomainTarget(), mgr.ResolvePlistPath()}},
	}) {
		t.Fatalf("unexpected LaunchAgent install commands: %+v", runner.calls)
	}
	plistBytes, err := os.ReadFile(mgr.ResolvePlistPath())
	if err != nil {
		t.Fatalf("read plist: %v", err)
	}
	if strings.Contains(string(plistBytes), cfg.NodeToken) {
		t.Fatal("installed plist leaked NodeToken")
	}
	managedBin, err := ResolveManagedBinaryPath(homeDir)
	if err != nil {
		t.Fatalf("ResolveManagedBinaryPath: %v", err)
	}
	binInfo, err := os.Stat(managedBin)
	if err != nil || binInfo.Mode().Perm() != 0755 {
		t.Fatalf("expected managed binary with 0755 mode, got err=%v mode=%v", err, binInfo)
	}

	// Write a fake journal file in StateDir to verify Uninstall preserves it.
	journalPath := filepath.Join(stateDir, "commands.db")
	if err := os.WriteFile(journalPath, []byte("bbolt-journal-bytes"), 0600); err != nil {
		t.Fatalf("write fake journal: %v", err)
	}

	// Start when already running must not restart/kickstart.
	runner.calls = nil
	runner.handler = func(name string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "print" {
			return []byte("\tstate = running\n\tpid = 4242\n"), nil
		}
		return nil, nil
	}
	if err := mgr.Start(ctx); err != nil {
		t.Fatalf("Start when running failed: %v", err)
	}
	if len(runner.calls) != 1 || runner.calls[0].args[0] != "print" {
		t.Fatalf("expected only launchctl print when already running, got %+v", runner.calls)
	}

	// Status fails when launchctl print fails with an unexpected error.
	runner.handler = func(name string, args ...string) ([]byte, error) {
		return []byte("permission denied"), errors.New("exit status 1")
	}
	if _, err := mgr.Status(ctx); err == nil {
		t.Fatal("expected Status error on unexpected launchctl print failure")
	}

	// Uninstall removes plist but preserves journal and token file.
	runner.handler = nil
	if err := mgr.Uninstall(ctx); err != nil {
		t.Fatalf("Darwin Uninstall failed: %v", err)
	}
	if _, err := os.Stat(mgr.ResolvePlistPath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected plist to be removed on uninstall, got %v", err)
	}
	if _, err := os.Stat(journalPath); err != nil {
		t.Fatalf("expected journal %s to be preserved after uninstall: %v", journalPath, err)
	}
	if _, err := os.Stat(ResolveTokenFilePath(stateDir)); err != nil {
		t.Fatalf("expected token file to be preserved after uninstall: %v", err)
	}

	// Ownership rejection: foreign plist without marker or with foreign binary must be rejected.
	foreignPlist := "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>com.other.agent</string>\n<key>ProgramArguments</key><array><string>/usr/local/bin/other</string></array>\n</dict></plist>"
	if err := os.WriteFile(mgr.ResolvePlistPath(), []byte(foreignPlist), 0644); err != nil {
		t.Fatalf("write foreign plist: %v", err)
	}
	runner.calls = nil
	if err := mgr.Install(ctx, cfg); err == nil {
		t.Fatal("expected Install to refuse overwriting foreign plist")
	}
	if err := mgr.Start(ctx); err == nil {
		t.Fatal("expected Start to refuse foreign plist")
	}
	if err := mgr.Stop(ctx); err == nil {
		t.Fatal("expected Stop to refuse foreign plist")
	}
	if err := mgr.Uninstall(ctx); err == nil {
		t.Fatal("expected Uninstall to refuse deleting foreign plist")
	}
	if len(runner.calls) != 0 {
		t.Fatalf("expected zero launchctl calls on ownership rejection, got %+v", runner.calls)
	}
	afterForeign, err := os.ReadFile(mgr.ResolvePlistPath())
	if err != nil || string(afterForeign) != foreignPlist {
		t.Fatal("foreign plist content was altered despite ownership rejection")
	}
}

func TestLinuxManagerLifecycleOwnershipAndUninstallPreservesState(t *testing.T) {
	ctx := context.Background()
	homeDir := t.TempDir()
	stateDir := filepath.Join(t.TempDir(), "daemon-state")
	cfg := sampleConfig(t, stateDir)

	runner := &fakeRunner{}
	mgrIface, err := NewManagerWithRunnerAndHome("linux", runner, homeDir)
	if err != nil {
		t.Fatalf("NewManagerWithRunnerAndHome linux: %v", err)
	}
	mgr := mgrIface.(*LinuxManager)

	if err := mgr.Install(ctx, cfg); err != nil {
		t.Fatalf("Linux Install failed: %v", err)
	}
	if !reflect.DeepEqual(runner.calls, []recordedCall{
		{name: "systemctl", args: []string{"--user", "daemon-reload"}},
		{name: "systemctl", args: []string{"--user", "enable", "--now", LinuxUnitName}},
	}) {
		t.Fatalf("unexpected systemd user install commands: %+v", runner.calls)
	}
	unitBytes, err := os.ReadFile(mgr.ResolveUnitPath())
	if err != nil {
		t.Fatalf("read unit: %v", err)
	}
	if strings.Contains(string(unitBytes), cfg.NodeToken) {
		t.Fatal("installed systemd unit leaked NodeToken")
	}

	journalPath := filepath.Join(stateDir, "commands.db")
	if err := os.WriteFile(journalPath, []byte("bbolt-journal-bytes"), 0600); err != nil {
		t.Fatalf("write fake journal: %v", err)
	}

	runner.handler = func(name string, args ...string) ([]byte, error) {
		return []byte("ActiveState=active\nSubState=running\nMainPID=7890\n"), nil
	}
	st, err := mgr.Status(ctx)
	if err != nil || !st.Installed || !st.Running || st.PID != 7890 {
		t.Fatalf("unexpected Linux Status: %+v, err=%v", st, err)
	}

	// Command error propagation.
	runner.handler = func(name string, args ...string) ([]byte, error) {
		return []byte("dbus failure"), errors.New("exit status 1")
	}
	if err := mgr.Start(ctx); err == nil {
		t.Fatal("expected Start error when systemctl fails")
	}
	if err := mgr.Stop(ctx); err == nil {
		t.Fatal("expected Stop error when systemctl fails")
	}
	if err := mgr.Restart(ctx); err == nil {
		t.Fatal("expected Restart error when systemctl fails")
	}

	// Uninstall removes unit file but preserves journal and token file.
	runner.handler = nil
	if err := mgr.Uninstall(ctx); err != nil {
		t.Fatalf("Linux Uninstall failed: %v", err)
	}
	if _, err := os.Stat(mgr.ResolveUnitPath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected unit file to be removed on uninstall, got %v", err)
	}
	if _, err := os.Stat(journalPath); err != nil {
		t.Fatalf("expected journal %s to be preserved after uninstall: %v", journalPath, err)
	}
	if _, err := os.Stat(ResolveTokenFilePath(stateDir)); err != nil {
		t.Fatalf("expected token file to be preserved after uninstall: %v", err)
	}

	// Foreign unit ownership rejection.
	foreignUnit := "[Unit]\nDescription=Other\n[Service]\nExecStart=/usr/bin/other\n"
	if err := os.WriteFile(mgr.ResolveUnitPath(), []byte(foreignUnit), 0644); err != nil {
		t.Fatalf("write foreign unit: %v", err)
	}
	runner.calls = nil
	if err := mgr.Install(ctx, cfg); err == nil {
		t.Fatal("expected Install to refuse overwriting foreign unit")
	}
	if err := mgr.Start(ctx); err == nil {
		t.Fatal("expected Start to refuse foreign unit")
	}
	if err := mgr.Stop(ctx); err == nil {
		t.Fatal("expected Stop to refuse foreign unit")
	}
	if err := mgr.Uninstall(ctx); err == nil {
		t.Fatal("expected Uninstall to refuse foreign unit")
	}
	if len(runner.calls) != 0 {
		t.Fatalf("expected zero systemctl calls on ownership rejection, got %+v", runner.calls)
	}
	afterForeign, err := os.ReadFile(mgr.ResolveUnitPath())
	if err != nil || string(afterForeign) != foreignUnit {
		t.Fatal("foreign unit content was altered despite ownership rejection")
	}

	if _, err := NewManagerWithRunnerAndHome("windows", runner, homeDir); !errors.Is(err, ErrNotSupported) {
		t.Fatalf("expected ErrNotSupported on windows, got %v", err)
	}
}
