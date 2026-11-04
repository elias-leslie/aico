// aico-hook: one hook binary for Claude Code, Codex, Pi and Aico's own agent harness. It replaces
// SummitFlow's publication guard, lease hook and publication startup check (M7a).
//
//	aico-hook claude|codex|pi   a hook event on stdin (Claude-style JSON; the event is hook_event_name)
//	aico-hook guard             the guard only: {} or a PreToolUse deny (Aico's agent harness)
//	aico-hook codex-trust       mark this config's Codex hooks trusted through Codex's own /hooks flow
//
// Output is the Claude Code hook JSON on stdout (Codex reads the same; the Pi extension maps it), exit 0.
// Only a guard decision blocks. A crash or missing data never blocks: the agent is told plainly what
// was not checked. Policy and wording that may change live in data/*.json next to the binary.
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

	"aico/hook/guard"
	"aico/hook/lease"
)

type Config struct {
	Lease lease.Config `json:"lease"`
	Tools struct {
		Guard string `json:"guard"`
		Shell string `json:"shell"`
		Edit  string `json:"edit"`
	} `json:"tools"`
	GitHubPATHint string `json:"github_pat_hint"`
	Context       struct {
		Command        []string          `json:"command"`
		TimeoutSeconds float64           `json:"timeout_seconds"`
		Tool           map[string]string `json:"tool"`
	} `json:"context"`
	StartupBrief struct {
		Release        string  `json:"release"`
		Checkout       string  `json:"checkout"`
		TimeoutSeconds float64 `json:"timeout_seconds"`
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

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: aico-hook claude|codex|pi|guard|codex-trust")
		os.Exit(2)
	}
	mode := os.Args[1]
	if mode == "codex-trust" {
		os.Exit(codexTrust(os.Args[2:]))
	}
	raw, _ := io.ReadAll(os.Stdin)
	var payload map[string]any
	event := "PreToolUse"
	defer func() {
		if r := recover(); r != nil {
			// Never a silent allow: the agent reads what went unchecked. Never a block either: only a guard
			// decision blocks.
			fmt.Fprintf(os.Stderr, "aico-hook crashed: %v\n%s", r, debug.Stack())
			fmt.Println(Out{Event: event, Context: []string{fmt.Sprintf(
				"aico-hook crashed (%v): this %s call was not checked by the guard or the lease hook. Tell the owner.", r, event)}}.JSON())
			os.Exit(0)
		}
	}()
	if json.Unmarshal(raw, &payload) != nil || payload == nil {
		payload = nil
	}
	if e := str(payload["hook_event_name"]); e != "" {
		event = e
	}
	cfg, err := loadConfig(dataDir())
	if err != nil {
		panic(fmt.Sprintf("hook data unavailable: %v", err))
	}
	switch mode {
	case "guard":
		fmt.Println(runGuard(payload, raw).JSON())
	case "claude", "codex", "pi":
		fmt.Println(dispatch(cfg, mode, event, payload, raw).JSON())
	default:
		fmt.Fprintln(os.Stderr, "aico-hook: unknown mode "+mode)
		os.Exit(2)
	}
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

var rules *guard.Rules

// runGuard is the guard's answer. Malformed input is the guard's own decision (it denies); missing rules are
// a crash (allowed, said plainly).
func runGuard(payload map[string]any, raw []byte) Out {
	if rules == nil {
		r, err := guard.Load(filepath.Join(dataDir(), "guard.json"))
		if err != nil {
			panic(fmt.Sprintf("guard rules unavailable: %v", err))
		}
		rules = r
	}
	if payload == nil {
		_ = json.Unmarshal(raw, &payload) // a non-object payload: the guard decides on its shape
	}
	res := rules.Evaluate(payload)
	if res.Deny {
		return Out{Event: "PreToolUse", Deny: res.Reason}
	}
	if res.Fault != "" {
		return Out{Event: "PreToolUse", Context: []string{"aico-hook: the irreversible-command check failed (" +
			res.Fault + "); this command was allowed unchecked. Tell the owner."}}
	}
	return Out{Event: "PreToolUse"}
}

func match(pattern, name string) bool {
	ok, err := regexp.MatchString(pattern, name)
	return err == nil && ok
}

// dispatch answers one hook event for a tool.
func dispatch(cfg *Config, tool, event string, payload map[string]any, raw []byte) Out {
	if payload == nil {
		if event == "PreToolUse" {
			return runGuard(payload, raw) // the guard denies malformed input
		}
		return Out{Event: event}
	}
	name := str(payload["tool_name"])
	switch event {
	case "PreToolUse":
		out := Out{Event: event}
		if match(cfg.Tools.Guard, name) {
			if out = runGuard(payload, raw); out.Deny != "" {
				return out
			}
		}
		h := lease.New(cfg.Lease, payload)
		if match(cfg.Tools.Shell, name) {
			h.BashPre(raw)
		}
		if match(cfg.Tools.Edit, name) {
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
		if !match(cfg.Tools.Shell, name) {
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
