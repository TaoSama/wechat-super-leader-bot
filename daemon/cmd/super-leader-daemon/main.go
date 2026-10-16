package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/client"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/service"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
)

func main() {
	cfg, err := config.ParseFlags(os.Args[1:])
	if err != nil {
		if err == flag.ErrHelp {
			os.Exit(0)
		}
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(2)
	}

	if cfg.ServiceAction != "" {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		err := service.Execute(ctx, cfg)
		cancel()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Service error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if cfg.ProbeSkills {
		catalog, scanErr := skills.Scan(cfg.SkillRoots)
		if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"skills": catalog}); err != nil {
			log.Printf("Could not encode skill catalog: %v", err)
			os.Exit(1)
		}
		if scanErr != nil {
			log.Printf("Skill discovery incomplete: %v", scanErr)
			os.Exit(1)
		}
		return
	}
	adapter := appserver.NewAppServerAdapter(cfg.SocketPath)

	if cfg.ProbeOnly {
		ctx, cancel := context.WithTimeout(context.Background(), client.ProbeTimeout)
		defer cancel()
		probe, err := client.NewDaemon(cfg, adapter).Probe(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Probe error: %v\n", err)
			os.Exit(1)
		}
		out, err := json.MarshalIndent(map[string]any{
			"nodeId":     cfg.NodeID,
			"socketPath": cfg.SocketPath,
			"codexHome":  cfg.CodexHome,
			"sessions":   probe.Sessions,
			"sources":    probe.Sources,
			"warnings":   probe.Warnings,
		}, "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "Marshal error: %v\n", err)
			os.Exit(1)
		}
		fmt.Println(string(out))
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("Starting Super Leader Daemon (nodeId=%s, controller=%s, socket=%s)",
		cfg.NodeID, cfg.ControllerURL, cfg.SocketPath)

	daemon, err := client.OpenDaemon(cfg, adapter)
	if err != nil {
		log.Printf("Daemon journal initialization failed: %v", err)
		os.Exit(1)
	}
	runErr := daemon.Run(ctx)
	closeErr := daemon.Close()
	if closeErr != nil {
		log.Printf("Daemon journal close failed: %v", closeErr)
	}
	if runErr != nil && ctx.Err() == nil {
		log.Printf("Daemon terminated with error: %v", runErr)
	}
	if closeErr != nil || (runErr != nil && ctx.Err() == nil) {
		os.Exit(1)
	}
}
