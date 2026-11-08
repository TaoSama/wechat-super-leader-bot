package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

type serviceRunnerFunc func(context.Context, string, ...string) ([]byte, error)

func (f serviceRunnerFunc) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return f(ctx, name, args...)
}

func restartFixture(t *testing.T) (*DarwinManager, map[string]string) {
	t.Helper()
	home := filepath.Join(t.TempDir(), "home")
	cfg := sampleConfig(t, filepath.Join(t.TempDir(), "state"))
	manager, _, files := seedInstalledService(t, "darwin", home, cfg)
	return manager.(*DarwinManager), files
}

func assertServiceFilesUnchanged(t *testing.T, files map[string]string) {
	t.Helper()
	for path, before := range files {
		after, err := os.ReadFile(path)
		if err != nil || string(after) != before {
			t.Fatalf("service file changed: %s, err=%v", path, err)
		}
	}
}

func TestDarwinRestartWaitsForUnloadedService(t *testing.T) {
	for _, state := range []string{"state = running\npid = 4242\n", "state = not running\n"} {
		t.Run(state, func(t *testing.T) {
			m, files := restartFixture(t)
			prints := 0
			runner := &fakeRunner{handler: func(_ string, args ...string) ([]byte, error) {
				switch args[0] {
				case "print":
					prints++
					if prints == 1 {
						return []byte(state), nil
					}
					return []byte("Could not find service"), errors.New("exit status 113")
				case "kickstart":
					return []byte("Could not find service"), errors.New("exit status 113")
				}
				return nil, nil
			}}
			m.Runner = runner
			if err := m.Restart(context.Background()); err != nil {
				t.Fatal(err)
			}
			var actions []string
			for _, call := range runner.calls {
				actions = append(actions, call.args[0])
			}
			want := []string{"bootout", "print", "print", "print", "enable", "bootstrap"}
			if !reflect.DeepEqual(actions, want) {
				t.Fatalf("restart crossed unload boundary incorrectly: got %v, want %v", actions, want)
			}
			assertServiceFilesUnchanged(t, files)
		})
	}
}

func TestDarwinRestartPreservesFailures(t *testing.T) {
	for _, stage := range []string{"bootout", "print", "enable", "bootstrap"} {
		t.Run(stage, func(t *testing.T) {
			m, files := restartFixture(t)
			failure := errors.New("permission or unknown external failure")
			var actions []string
			m.Runner = serviceRunnerFunc(func(_ context.Context, _ string, args ...string) ([]byte, error) {
				actions = append(actions, args[0])
				if args[0] == stage {
					return []byte("Operation not permitted"), failure
				}
				if args[0] == "print" {
					return []byte("Could not find service"), errors.New("exit status 113")
				}
				return nil, nil
			})
			if err := m.Restart(context.Background()); !errors.Is(err, failure) {
				t.Fatalf("lost external error identity: %v", err)
			}
			if actions[len(actions)-1] != stage {
				t.Fatalf("continued after failure: %v", actions)
			}
			assertServiceFilesUnchanged(t, files)
		})
	}
}

func TestDarwinRestartCancellation(t *testing.T) {
	t.Run("already-canceled", func(t *testing.T) {
		m, _ := restartFixture(t)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		runner := &fakeRunner{}
		m.Runner = runner
		if err := m.Restart(ctx); !errors.Is(err, context.Canceled) {
			t.Fatalf("expected cancellation, got %v", err)
		}
		if len(runner.calls) != 0 {
			t.Fatalf("executed commands after cancellation: %+v", runner.calls)
		}
	})
	for _, stage := range []string{"bootout", "print", "bootstrap"} {
		t.Run(stage, func(t *testing.T) {
			m, _ := restartFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			failure := errors.New("external process interrupted")
			var actions []string
			m.Runner = serviceRunnerFunc(func(_ context.Context, _ string, args ...string) ([]byte, error) {
				actions = append(actions, args[0])
				if args[0] == stage {
					cancel()
					if stage == "print" {
						return []byte("No such process"), failure
					}
					return nil, failure
				}
				if args[0] == "print" {
					return []byte("No such process"), errors.New("exit status 113")
				}
				return nil, nil
			})
			err := m.Restart(ctx)
			if !errors.Is(err, context.Canceled) || !errors.Is(err, failure) {
				t.Fatalf("lost cancellation or external error: %v", err)
			}
			if actions[len(actions)-1] != stage {
				t.Fatalf("continued after cancellation: %v", actions)
			}
		})
	}
}

func TestDarwinRestartDeadlineBoundsBlockedPrint(t *testing.T) {
	m, _ := restartFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	failure := errors.New("external print terminated")
	var actions []string
	m.Runner = serviceRunnerFunc(func(ctx context.Context, _ string, args ...string) ([]byte, error) {
		actions = append(actions, args[0])
		if args[0] == "print" {
			<-ctx.Done()
			return nil, failure
		}
		return nil, nil
	})
	err := m.Restart(ctx)
	if !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, failure) {
		t.Fatalf("lost deadline or external error: %v", err)
	}
	if !reflect.DeepEqual(actions, []string{"bootout", "print"}) {
		t.Fatalf("started after timeout: %v", actions)
	}
}

func TestDarwinRestartAlreadyUnloaded(t *testing.T) {
	m, _ := restartFixture(t)
	runner := &fakeRunner{handler: func(_ string, args ...string) ([]byte, error) {
		if args[0] == "bootout" || args[0] == "print" {
			return []byte("Could not find service"), errors.New("exit status 113")
		}
		return nil, nil
	}}
	m.Runner = runner
	if err := m.Restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	var actions []string
	for _, call := range runner.calls {
		actions = append(actions, call.args[0])
	}
	if !reflect.DeepEqual(actions, []string{"bootout", "print", "print", "enable", "bootstrap"}) {
		t.Fatalf("unexpected restart actions: %v", actions)
	}
}

func TestDarwinRestartBoundsWaitWithoutCallerDeadline(t *testing.T) {
	m, _ := restartFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var actions []string
	m.Runner = serviceRunnerFunc(func(commandCtx context.Context, _ string, args ...string) ([]byte, error) {
		actions = append(actions, args[0])
		if args[0] == "print" {
			deadline, ok := commandCtx.Deadline()
			if !ok || time.Until(deadline) > darwinUnloadTimeout {
				t.Fatal("unload command lacks the local timeout")
			}
			cancel()
			return []byte("state = running\npid = 4242\n"), nil
		}
		return nil, nil
	})
	if err := m.Restart(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation of bounded wait: %v", err)
	}
	if !reflect.DeepEqual(actions, []string{"bootout", "print"}) {
		t.Fatalf("started after cancellation: %v", actions)
	}
}
