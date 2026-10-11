// Command terminal-delivery drives the public delivery package against an owned
// synthetic Unix socket. It never accepts a real host or session as input.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/terminal"
)

const (
	samplePane      = "w1:p1"
	sampleRequestID = "ea8227ef-083b-44e0-801f-d16eeaafbf32"
	samplePrompt    = "请只检查这个合成目标。\n保持原始中文和换行，不操作任何真实会话。"
	sampleTimeout   = 5 * time.Second
)

func main() {
	if err := mainWithArgs(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func mainWithArgs(args []string) error {
	flags := flag.NewFlagSet("terminal-delivery", flag.ContinueOnError)
	run := flags.Bool("run", false, "run synthetic public-package scenarios; never contact a real terminal")
	flags.Usage = func() {
		fmt.Fprintln(flags.Output(), "Usage: go run ./examples/terminal-delivery --run\nOnly creates an owned temporary Unix socket; no real host/session arguments.")
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("positional arguments are not accepted")
	}
	if !*run {
		flags.Usage()
		return nil
	}
	for _, scenario := range []string{"delivered", "binding-changed", "acknowledgement-lost", "blank-prompt"} {
		if err := driveScenario(scenario); err != nil {
			return fmt.Errorf("%s: %w", scenario, err)
		}
	}
	return nil
}

func driveScenario(scenario string) (err error) {
	host, err := startSyntheticHost(scenario)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, host.Close()) }()
	ctx, cancel := context.WithTimeout(context.Background(), sampleTimeout)
	defer cancel()
	observer := terminal.NewObserver(host.socket, []string{samplePane})
	sessions, err := observer.DiscoverSessions(ctx)
	if err != nil || len(sessions) != 1 {
		return fmt.Errorf("synthetic discovery failed: %w", errors.Join(err, expectOneSession(len(sessions))))
	}
	prompt := samplePrompt
	if scenario == "blank-prompt" {
		prompt = " \n\t"
	}
	prepared, err := terminal.NewDeliveryController(observer).PrepareDelivery(ctx, sessions[0].ID, sampleRequestID, prompt)
	if scenario == "blank-prompt" {
		if prepared != nil {
			return errors.Join(errors.New("blank prompt unexpectedly prepared"), prepared.Close())
		}
		var deliveryErr *terminal.DeliveryError
		if !errors.As(err, &deliveryErr) || deliveryErr.Attempted || deliveryErr.Uncertain || host.promptCount() != 0 {
			return errors.New("blank prompt was not rejected before input")
		}
		return writeResult(scenario, 0, "", false, false)
	}
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, prepared.Close()) }()
	if host.promptCount() != 0 {
		return errors.New("preparation unexpectedly wrote input")
	}
	if scenario == "binding-changed" {
		host.changeBinding()
	}
	receipt, dispatchErr := prepared.Dispatch(ctx)
	var deliveryErr *terminal.DeliveryError
	switch scenario {
	case "delivered":
		if dispatchErr != nil || receipt.Kind != "terminal-input-written" || host.promptCount() != 1 {
			return errors.New("exact delivery was not acknowledged once")
		}
	case "binding-changed":
		if !errors.As(dispatchErr, &deliveryErr) || deliveryErr.Attempted || deliveryErr.Uncertain || host.promptCount() != 0 {
			return errors.New("changed binding was not rejected before input")
		}
	case "acknowledgement-lost":
		if !errors.As(dispatchErr, &deliveryErr) || !deliveryErr.Attempted || !deliveryErr.Uncertain || host.promptCount() != 1 {
			return errors.New("lost acknowledgement was not marked uncertain")
		}
	}
	beforeRepeat := host.promptCount()
	if _, repeatErr := prepared.Dispatch(ctx); repeatErr == nil || host.promptCount() != beforeRepeat {
		return errors.New("same preparation permitted another delivery")
	}
	return writeResult(scenario, host.promptCount(), receipt.Kind, deliveryErr != nil && deliveryErr.Uncertain, true)
}

func writeResult(scenario string, writes int, kind string, uncertain, repeatRejected bool) error {
	return json.NewEncoder(os.Stdout).Encode(struct {
		Scenario         string `json:"scenario"`
		PromptWrites     int    `json:"promptWrites"`
		ReceiptKind      string `json:"receiptKind,omitempty"`
		Uncertain        bool   `json:"uncertain"`
		RepeatRejected   bool   `json:"repeatRejected"`
		CompletionProven bool   `json:"completionProven"`
	}{scenario, writes, kind, uncertain, repeatRejected, false})
}

func expectOneSession(count int) error {
	if count == 1 {
		return nil
	}
	return errors.New("expected one synthetic session")
}
