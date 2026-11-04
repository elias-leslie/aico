package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"aico/hook/lease"
)

func expand(p string) string {
	if strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		if h := os.Getenv("HOME"); h != "" {
			home = h
		}
		return filepath.Join(home, p[2:])
	}
	return p
}

// sessionStart: the identity registry (and its reset line), the startup brief, the publication
// enforcement status and Aico's context delivery, gathered in parallel and printed in that order.
func sessionStart(cfg *Config, tool, event string, payload map[string]any) Out {
	parts := make([][]string, 4)
	var wg sync.WaitGroup
	run := func(i int, fn func() []string) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					parts[i] = []string{fmt.Sprintf("aico-hook: a session-start step failed (%v).", r)}
				}
			}()
			parts[i] = fn()
		}()
	}
	if event == "SessionStart" {
		run(0, func() []string { return lease.New(cfg.Lease, payload).SessionStart() })
		run(1, func() []string { return startupBrief(cfg, payload) })
	}
	if tool != "pi" { // Pi has no command hooks to verify (as before: SummitFlow's startup check ran for Claude and Codex)
		run(2, func() []string { return publicationStatus(cfg, payload) })
	}
	run(3, func() []string { return deliverContext(cfg, tool, event, payload) })
	wg.Wait()
	out := Out{Event: event}
	for _, p := range parts {
		out.Context = append(out.Context, p...)
	}
	return out
}

func withTimeout(seconds float64) (context.Context, context.CancelFunc) {
	if seconds <= 0 {
		seconds = 5
	}
	return context.WithTimeout(context.Background(), time.Duration(seconds*float64(time.Second)))
}

func lines(b []byte) []string {
	var out []string
	for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

// ---------------------------------------------------------------- startup brief

// startupBrief is the "what is already broken" brief: `aico pulse --start` with the hook payload on stdin
// (Status problems by role, held back for the re-show window). Silent on any failure.
func startupBrief(cfg *Config, payload map[string]any) []string {
	argv := append([]string{}, cfg.StartupBrief.Command...)
	if len(argv) == 0 {
		return nil
	}
	for i := range argv {
		argv[i] = expand(argv[i])
	}
	ctx, cancel := withTimeout(cfg.StartupBrief.TimeoutSeconds)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	in, _ := json.Marshal(payload)
	cmd.Stdin = bytes.NewReader(in)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	return lines(out)
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// ---------------------------------------------------------------- publication status

// publicationStatus reports what keeps publication enforcement from being verified (silent when healthy):
// Codex trust of this config's aico-hook entries, the git pre-push verifier, gitleaks, and the Claude adapter.
func publicationStatus(cfg *Config, payload map[string]any) []string {
	p := cfg.Publication
	var out []string
	cwd := str(payload["cwd"])
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	if hooks, err := codexHooks(cwd, p.TimeoutSeconds, expand(p.CodexHooks), p.HookMarker); errors.Is(err, errNoHooks) {
		out = append(out, "Publication hooks: Codex does not run aico-hook; enforcement is not verified.")
	} else if err != nil {
		out = append(out, "Publication hooks: Codex trust unavailable; enforcement is not verified.")
	} else {
		var pending []string
		for _, h := range hooks {
			if t := str(h["trustStatus"]); t != "trusted" && t != "managed" {
				pending = append(pending, str(h["eventName"]))
			}
		}
		if len(pending) > 0 {
			out = append(out, "Publication hooks: review pending for "+strings.Join(pending, ", "))
		}
	}
	if raw, err := os.ReadFile(expand(p.PrePushHook)); err != nil || !strings.Contains(string(raw), p.PrePushMarker) {
		out = append(out, "Git outgoing verifier: adapter unavailable; installation required.")
	}
	if _, err := exec.LookPath("gitleaks"); err != nil {
		out = append(out, "Outgoing secret scanner unavailable; publication fails closed.")
	}
	if !claudeGuarded(expand(p.ClaudeSettings), p.HookMarker) {
		out = append(out, "Claude publication adapter: unavailable; enforcement is not verified.")
	}
	return out
}

// claudeGuarded: a Claude Code PreToolUse hook covering Bash runs aico-hook.
func claudeGuarded(settings, marker string) bool {
	raw, err := os.ReadFile(settings)
	if err != nil {
		return false
	}
	var s struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct {
				Command string `json:"command"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if json.Unmarshal(raw, &s) != nil {
		return false
	}
	for _, group := range s.Hooks["PreToolUse"] {
		if ok, err := regexp.MatchString("^(?:"+group.Matcher+")$", "Bash"); (err != nil || !ok) && group.Matcher != "*" {
			continue
		}
		for _, h := range group.Hooks {
			if strings.Contains(h.Command, marker) {
				return true
			}
		}
	}
	return false
}

// ---------------------------------------------------------------- Codex hooks (app-server JSON-RPC)

type rpc struct {
	cmd *exec.Cmd
	in  *json.Encoder
	out *bufio.Reader
	seq int
}

func startRPC(ctx context.Context) (*rpc, error) {
	cmd := exec.CommandContext(ctx, "codex", "app-server", "--stdio")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	r := &rpc{cmd: cmd, in: json.NewEncoder(stdin), out: bufio.NewReaderSize(stdout, 1<<20)}
	if _, err := r.call("initialize", map[string]any{"clientInfo": map[string]any{"name": "aico-hook", "version": "1.0"},
		"capabilities": map[string]any{"experimentalApi": true}}); err != nil {
		r.close()
		return nil, err
	}
	_ = r.in.Encode(map[string]any{"method": "initialized"})
	return r, nil
}

func (r *rpc) call(method string, params any) (map[string]any, error) {
	r.seq++
	id := r.seq
	if err := r.in.Encode(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	for {
		line, err := r.out.ReadBytes('\n')
		if err != nil {
			return nil, fmt.Errorf("codex app-server closed: %w", err)
		}
		var msg map[string]any
		if json.Unmarshal(line, &msg) != nil {
			continue
		}
		if n, ok := msg["id"].(float64); !ok || int(n) != id {
			continue
		}
		if e, ok := msg["error"]; ok {
			return nil, fmt.Errorf("%s: %v", method, e)
		}
		res, _ := msg["result"].(map[string]any)
		return res, nil
	}
}

func (r *rpc) close() {
	_ = r.cmd.Process.Kill()
	_ = r.cmd.Wait()
}

func hookList(r *rpc, cwd string) ([]map[string]any, error) {
	res, err := r.call("hooks/list", map[string]any{"cwds": []string{cwd}})
	if err != nil {
		return nil, err
	}
	var hooks []map[string]any
	data, _ := res["data"].([]any)
	for _, e := range data {
		entry, _ := e.(map[string]any)
		if errs, _ := entry["errors"].([]any); len(errs) > 0 {
			return nil, errors.New("codex reports hook errors")
		}
		list, _ := entry["hooks"].([]any)
		for _, h := range list {
			if m, ok := h.(map[string]any); ok {
				hooks = append(hooks, m)
			}
		}
	}
	return hooks, nil
}

func sameFile(a, b string) bool {
	ra, err1 := filepath.EvalSymlinks(a)
	rb, err2 := filepath.EvalSymlinks(b)
	return err1 == nil && err2 == nil && ra == rb
}

var errNoHooks = errors.New("no aico-hook entries")

// codexHooks are the aico-hook entries Codex loads from the user hooks file; an error when there are none.
func codexHooks(cwd string, timeout float64, source, marker string) ([]map[string]any, error) {
	ctx, cancel := withTimeout(timeout)
	defer cancel()
	r, err := startRPC(ctx)
	if err != nil {
		return nil, err
	}
	defer r.close()
	all, err := hookList(r, cwd)
	if err != nil {
		return nil, err
	}
	var ours []map[string]any
	for _, h := range all {
		if strings.Contains(str(h["command"]), marker) && sameFile(str(h["sourcePath"]), source) {
			ours = append(ours, h)
		}
	}
	if len(ours) == 0 {
		return nil, errNoHooks
	}
	return ours, nil
}

// codexTrust marks every hook of the user hooks file (~/.codex/hooks.json) trusted at its current hash, the same
// hooks/list + config/batchWrite flow as Codex's /hooks review, and drops trust entries for slots of that file
// that no longer exist (a removed hook's slot would otherwise trust whatever later lands there). --check only
// lists them (exit 1 when any is untrusted); --cwd DIR lists from another project.
func codexTrust(args []string) int {
	cwd, _ := os.Getwd()
	check := false
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--check":
			check = true
		case args[i] == "--cwd" && i+1 < len(args):
			i++
			cwd = args[i]
		default:
			fmt.Fprintln(os.Stderr, "usage: aico-hook codex-trust [--check] [--cwd DIR]")
			return 2
		}
	}
	fail := func(err error) int { fmt.Fprintln(os.Stderr, "aico-hook:", err); return 1 }
	cfg, err := loadConfig(dataDir())
	if err != nil {
		return fail(fmt.Errorf("hook data unavailable: %w", err))
	}
	ctx, cancel := withTimeout(30)
	defer cancel()
	r, err := startRPC(ctx)
	if err != nil {
		return fail(fmt.Errorf("codex app-server: %w", err))
	}
	defer r.close()
	hooks, err := hookList(r, cwd)
	if err != nil {
		return fail(err)
	}
	source := expand(cfg.Publication.CodexHooks)
	prefixes := map[string]bool{source + ":": true}
	current, untrusted := map[string]bool{}, map[string]any{}
	for _, h := range hooks {
		if sameFile(str(h["sourcePath"]), source) {
			prefixes[str(h["sourcePath"])+":"] = true
			current[str(h["key"])] = true
			if str(h["trustStatus"]) != "trusted" {
				untrusted[str(h["key"])] = map[string]any{"trusted_hash": h["currentHash"]}
			}
		}
	}
	state, version, err := userHookState(r)
	if err != nil {
		return fail(err)
	}
	var stale []string
	for key := range state {
		for prefix := range prefixes {
			if strings.HasPrefix(key, prefix) && !current[key] {
				stale = append(stale, key)
				break
			}
		}
	}
	sort.Strings(stale)
	for _, key := range stale {
		fmt.Printf("%-16s %-9s %s\n", "-", map[bool]string{true: "stale", false: "dropped"}[check], key)
	}
	if (len(untrusted) > 0 || len(stale) > 0) && !check {
		edit := map[string]any{"keyPath": "hooks.state", "value": untrusted, "mergeStrategy": "upsert"}
		if len(stale) > 0 { // config/batchWrite cannot delete one key: replace the user layer's whole table
			for _, key := range stale {
				delete(state, key)
			}
			for key, v := range untrusted {
				state[key] = v
			}
			edit = map[string]any{"keyPath": "hooks.state", "value": state, "mergeStrategy": "replace"}
		}
		if _, err := r.call("config/batchWrite", map[string]any{"edits": []any{edit}, "expectedVersion": version,
			"reloadUserConfig": true}); err != nil {
			return fail(err)
		}
		if hooks, err = hookList(r, cwd); err != nil {
			return fail(err)
		}
	}
	bad := 0
	for _, h := range hooks {
		if sameFile(str(h["sourcePath"]), source) {
			if str(h["trustStatus"]) != "trusted" {
				bad++
			}
			fmt.Printf("%-16s %-9s %s %s\n", str(h["eventName"]), str(h["trustStatus"]), str(h["key"]), str(h["currentHash"]))
		}
	}
	if bad > 0 {
		return 1
	}
	return 0
}

// userHookState is hooks.state of Codex's user config layer (~/.codex/config.toml) and that layer's version.
func userHookState(r *rpc) (map[string]any, string, error) {
	res, err := r.call("config/read", map[string]any{"includeLayers": true})
	if err != nil {
		return nil, "", err
	}
	layers, _ := res["layers"].([]any)
	for _, l := range layers {
		layer, _ := l.(map[string]any)
		if name, _ := layer["name"].(map[string]any); str(name["type"]) != "user" {
			continue
		}
		config, _ := layer["config"].(map[string]any)
		hooks, _ := config["hooks"].(map[string]any)
		state, _ := hooks["state"].(map[string]any)
		if state == nil {
			state = map[string]any{}
		}
		return state, str(layer["version"]), nil
	}
	return nil, "", errors.New("codex config/read returned no user layer")
}

// ---------------------------------------------------------------- context delivery

// deliverContext runs `aico context deliver --tool T --project P --session S --format F --event E`
// (contracts/context-delivery.schema.json) and returns its text: the deployed release's aico, which prints nothing
// when the launch already delivered (Tether, or Agent Hub's launchers and Pi extension). An empty command delivers nothing.
func deliverContext(cfg *Config, tool, event string, payload map[string]any) []string {
	c := cfg.Context
	if len(c.Command) == 0 {
		return nil
	}
	session := str(payload["session_id"])
	if event == "SubagentStart" && str(payload["agent_id"]) != "" {
		session = str(payload["agent_id"])
	}
	args := append([]string{}, c.Command[1:]...)
	args = append(args, "--tool", c.Tool[tool], "--session", session, "--format", tool, "--event", event)
	cwd := str(payload["cwd"])
	if proj, ok := lease.ProjectFor(cwd); ok && cwd != "" {
		args = append(args, "--project", proj.ID)
	}
	ctx, cancel := withTimeout(c.TimeoutSeconds)
	defer cancel()
	cmd := exec.CommandContext(ctx, expand(c.Command[0]), args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		why := strings.TrimSpace(stderr.String())
		if i := strings.IndexByte(why, '\n'); i >= 0 {
			why = why[:i]
		}
		return []string{fmt.Sprintf("Aico context delivery failed (%v%s); this session started without its project context.",
			err, map[bool]string{true: ": " + why, false: ""}[why != ""])}
	}
	if text := deliveredText(out); text != "" {
		return []string{text}
	}
	return nil
}

// deliveredText is the additionalContext of a claude/codex envelope, or Pi's plain text.
func deliveredText(out []byte) string {
	var env struct {
		Hook struct {
			Context string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if json.Unmarshal(out, &env) == nil {
		return strings.TrimSpace(env.Hook.Context)
	}
	return strings.TrimSpace(string(out))
}
