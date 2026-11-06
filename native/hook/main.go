// aico-hook: one hook binary for Claude Code, Codex, Pi and Aico's own agent harness. It replaces
// SummitFlow's publication guard, lease hook and publication startup check (M7a).
//
//	aico-hook claude|codex|pi   a hook event on stdin (Claude-style JSON; the event is hook_event_name)
//	aico-hook guard             the guard only: {} or a PreToolUse deny (Aico's agent harness)
//	aico-hook codex-trust       mark this config's Codex hooks trusted through Codex's own /hooks flow
//	aico-hook lease|sessions|inbox|import-legacy   the agent's coordination verbs and inbox hook (coord.go)
//
// Output is the Claude Code hook JSON on stdout (Codex reads the same; the Pi extension maps it), exit 0.
// The guard fails closed: when guard.json cannot be loaded, or anything on the guard path panics or runs past
// its deadline, shell and GitHub connector calls are refused with a plain reason (guard_failure.go). The rest
// fails open with a note: a broken hook.json or a lease-hook crash never blocks and never disables the guard.
// Policy and wording that may change live in data/*.json next to the binary.
//
// Why the guard must always answer in time, with exit 0 (checked 2026-11-04):
//   - Claude Code 2.1.318 (code.claude.com/docs/en/hooks): a PreToolUse deny or exit 2 blocks; any other exit
//     code, invalid JSON, a hook that does not start or one that times out is a non-blocking error and the tool
//     runs, unless the hook entry sets "onFailure": "block" (2.1.295+), which claude-config's shell and connector
//     entry does.
//   - Codex 0.164 (codex-rs/hooks/src/events/pre_tool_use.rs): a deny, or exit 2 with a reason on stderr, blocks;
//     a timeout or spawn error, any other exit code, exit 2 with empty stderr or JSON it cannot parse marks the
//     hook failed and the tool runs. Codex has no onFailure setting.
//   - Pi (pi/aico-hook.ts) and Aico's agent harness refuse a guarded call on any fault.
//
// So the guard's deadline (guard.json limits.deadline_ms, 2 s) sits well inside the shortest PreToolUse timeout
// (10 s in every tool's config), and a Go runtime crash (exit 2, stack on stderr) blocks in both tools.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"time"

	"aico/hook/guard"
	"aico/hook/lease"
)

type Config struct {
	Lease lease.Config `json:"lease"`
	Tools struct {
		Shell string `json:"shell"`
		Edit  string `json:"edit"`
	} `json:"tools"`
	shell, edit   *regexp.Regexp // Tools, compiled by loadConfig
	GitHubPATHint string         `json:"github_pat_hint"`
	Inbox         struct {
		TimeoutSeconds float64 `json:"timeout_seconds"`
	} `json:"inbox"`
	Context struct {
		Command        []string          `json:"command"`
		TimeoutSeconds float64           `json:"timeout_seconds"`
		Tool           map[string]string `json:"tool"`
	} `json:"context"`
	StartupBrief struct {
		Command        []string `json:"command"`
		TimeoutSeconds float64  `json:"timeout_seconds"`
	} `json:"startup_brief"`
	Publication struct {
		TimeoutSeconds float64 `json:"timeout_seconds"`
		PrePushHook    string  `json:"pre_push_hook"`
		PrePushMarker  string  `json:"pre_push_marker"`
		ClaudeSettings string  `json:"claude_settings"`
		CodexHooks     string  `json:"codex_hooks"`
		HookMarker     string  `json:"hook_marker"`
	} `json:"publication"`
}

// dataDir is data/ next to the real binary (AICO_HOOK_DATA overrides, for tests).
func dataDir() string {
	if d := os.Getenv("AICO_HOOK_DATA"); d != "" {
		return d
	}
	exe, err := os.Executable()
	if err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
	}
	return filepath.Join(filepath.Dir(exe), "data")
}

func loadConfig(dir string) (*Config, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "hook.json"))
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("hook.json: %w", err)
	}
	if c.shell, err = regexp.Compile(c.Tools.Shell); err != nil {
		return nil, fmt.Errorf("hook.json tools.shell: %w", err)
	}
	if c.edit, err = regexp.Compile(c.Tools.Edit); err != nil {
		return nil, fmt.Errorf("hook.json tools.edit: %w", err)
	}
	return &c, nil
}

// Out is one hook answer.
type Out struct {
	Event   string
	Deny    string   // a guard decision (PreToolUse only)
	Context []string // lines the agent sees (additionalContext)
}

func (o Out) JSON() string {
	switch {
	case o.Deny != "":
		return mustJSON(map[string]any{"hookSpecificOutput": map[string]any{
			"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": o.Deny}})
	case len(o.Context) > 0:
		return mustJSON(map[string]any{"hookSpecificOutput": map[string]any{
			"hookEventName": o.Event, "additionalContext": strings.Join(o.Context, "\n")}})
	}
	return "{}"
}

func mustJSON(v any) string {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimRight(b.String(), "\n")
}

// started is when this process began: a hook call's store budget counts from here.
var started = time.Now()

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: aico-hook claude|codex|pi|guard|codex-trust")
		os.Exit(2)
	}
	mode := os.Args[1]
	if isCoordMode(mode) {
		os.Exit(coordMain(mode, os.Args[2:]))
	}
	if mode == "codex-trust" {
		os.Exit(codexTrust(os.Args[2:]))
	}
	if mode != "guard" && mode != "claude" && mode != "codex" && mode != "pi" {
		fmt.Fprintln(os.Stderr, "aico-hook: unknown mode "+mode)
		os.Exit(2)
	}
	raw, _ := io.ReadAll(os.Stdin)
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		payload = nil
	}
	event := "PreToolUse"
	if e := str(payload["hook_event_name"]); e != "" {
		event = e
	}
	fmt.Println(handle(mode, event, payload, raw).JSON())
}

// handle is one hook call. A panic before the guard has answered a PreToolUse call is a guard failure (refused);
// a later one (leases, session start) is said plainly and blocks nothing.
func handle(mode, event string, payload map[string]any, raw []byte) (out Out) {
	guarded := event != "PreToolUse" && mode != "guard"
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "aico-hook crashed: %v\n%s", r, debug.Stack())
			if !guarded {
				out = guardFailed(payload, fmt.Sprintf("aico-hook crashed (%v)", r))
				return
			}
			out = Out{Event: event, Context: []string{fmt.Sprintf(
				"aico-hook crashed (%v): this %s call was not checked by the lease hook. Tell the owner.", r, event)}}
		}
	}()
	if event == "PreToolUse" || mode == "guard" {
		if out = runGuard(payload, raw, mode == "guard"); out.Deny != "" || mode == "guard" {
			return out
		}
		guarded = true
	}
	cfg, err := loadConfig(dataDir())
	if err != nil {
		return Out{Event: event, Context: append(out.Context, fmt.Sprintf("aico-hook could not read hook.json (%v): "+
			"file leases, overlap hints and session start were skipped; the guard still ran. Tell the owner.", err))}
	}
	lease.SetBudget(started, cfg.Lease.StoreBudget())
	more := dispatch(cfg, mode, event, payload, raw)
	more.Context = append(out.Context, more.Context...)
	return more
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// loadRules reads data/guard.json (a variable so a test can hand the guard path broken rules).
var loadRules = func() (*guard.Rules, error) { return guard.Load(filepath.Join(dataDir(), "guard.json")) }

// runGuard is the guard's answer for a PreToolUse call; only guard.json is read. Every call is judged in guard
// mode (Aico's agent harness sends only shell calls), else the tools guard.json names. Malformed input is the
// guard's own decision (it denies); missing or broken rules and panics are guard failures (refused).
func runGuard(payload map[string]any, raw []byte, every bool) (out Out) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "aico-hook guard crashed: %v\n%s", r, debug.Stack())
			out = guardFailed(payload, fmt.Sprintf("aico-hook crashed while checking it (%v)", r))
		}
	}()
	r, err := loadRules()
	if err != nil {
		return guardFailed(payload, fmt.Sprintf("aico-hook could not load its guard rules (%v)", err))
	}
	if payload == nil {
		_ = json.Unmarshal(raw, &payload) // a non-object payload: the guard decides on its shape
	} else if !every && !r.Guards(str(payload["tool_name"])) {
		return Out{Event: "PreToolUse"}
	}
	res := r.Evaluate(payload)
	if res.Deny {
		return Out{Event: "PreToolUse", Deny: res.Reason}
	}
	if res.Fault != "" {
		return Out{Event: "PreToolUse", Context: []string{"aico-hook: the irreversible-command check failed (" +
			res.Fault + "); this command was allowed unchecked. Tell the owner."}}
	}
	return Out{Event: "PreToolUse"}
}

// dispatch answers the lease, overlap and session-start part of one hook event for a tool; the guard has
// already allowed a PreToolUse call.
func dispatch(cfg *Config, tool, event string, payload map[string]any, raw []byte) Out {
	if payload == nil {
		return Out{Event: event}
	}
	name := str(payload["tool_name"])
	lease.New(cfg.Lease, payload).RecordAgent()
	switch event {
	case "PreToolUse":
		out := Out{Event: event}
		h := lease.New(cfg.Lease, payload)
		if cfg.shell.MatchString(name) {
			h.BashPre(raw)
		}
		if cfg.edit.MatchString(name) {
			blocked, text := h.Edit()
			if blocked {
				return Out{Event: event, Deny: text}
			}
			if text != "" {
				out.Context = append(out.Context, text)
			}
		}
		return out
	case "PostToolUse", "PostToolUseFailure":
		out := Out{Event: event}
		if !cfg.shell.MatchString(name) {
			return out
		}
		var hint string
		if strings.Contains(string(raw), "Resource not accessible by personal access token") {
			if ev := lease.GitHubPATDenied(payload); ev == "PostToolUse" || ev == "PostToolUseFailure" {
				hint = cfg.GitHubPATHint
			}
		}
		if line := lease.New(cfg.Lease, payload).BashPost(); line != "" {
			out.Context = append(out.Context, line)
		}
		if hint != "" {
			out.Context = append(out.Context, hint)
		}
		return out
	case "SessionStart", "SubagentStart":
		return sessionStart(cfg, tool, event, payload)
	}
	return Out{Event: event}
}
