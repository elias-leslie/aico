package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const schemaPath = "../../contracts/hook-payloads.schema.json" // contracts/hook-payloads.schema.json

// TestMain lets the test binary stand in for aico-hook (AICO_HOOK_AS_MAIN=1), so the crash path runs for real.
func TestMain(m *testing.M) {
	if os.Getenv("AICO_HOOK_AS_MAIN") == "1" {
		os.Args = append([]string{"aico-hook"}, strings.Fields(os.Getenv("AICO_HOOK_ARGS"))...)
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// sandbox isolates leases, shell snapshots, Tether and the startup checks; returns a fresh git checkout.
func sandbox(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("AICO_HOOK_DATA", "data")
	t.Setenv("ST_LEASES_DIR", filepath.Join(tmp, "leases"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(tmp, "run"))
	t.Setenv("TETHER_SOCKET", filepath.Join(tmp, "none.sock"))
	t.Setenv("ST_COORD_ANCHOR", "")
	for _, k := range []string{"ST_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID",
		"CODEX_THREAD_ID", "PI_SESSION_ID", "ANTIGRAVITY_CONVERSATION_ID", "TMUX", "TMUX_PANE"} {
		t.Setenv(k, "")
	}
	repo := filepath.Join(tmp, "demo")
	if out, err := exec.Command("git", "init", "-q", repo).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	return repo
}

func loadSchema(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatal(err)
	}
	var s map[string]any
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

// validate is the slice of JSON Schema the contract uses: $ref, allOf, oneOf, type, const, enum, required,
// properties, additionalProperties false.
func validate(root, schema map[string]any, v any) error {
	if ref, ok := schema["$ref"].(string); ok {
		def, _ := root["$defs"].(map[string]any)[strings.TrimPrefix(ref, "#/$defs/")].(map[string]any)
		if def == nil {
			return fmt.Errorf("unknown $ref %s", ref)
		}
		return validate(root, def, v)
	}
	for _, sub := range list(schema["allOf"]) {
		if err := validate(root, sub, v); err != nil {
			return err
		}
	}
	if one := list(schema["oneOf"]); len(one) > 0 {
		n := 0
		for _, sub := range one {
			if validate(root, sub, v) == nil {
				n++
			}
		}
		if n != 1 {
			return fmt.Errorf("matches %d of oneOf", n)
		}
	}
	if c, ok := schema["const"]; ok && c != v {
		return fmt.Errorf("%v is not %v", v, c)
	}
	if e, ok := schema["enum"].([]any); ok && !contains(e, v) {
		return fmt.Errorf("%v not in %v", v, e)
	}
	switch schema["type"] {
	case "string":
		if _, ok := v.(string); !ok {
			return fmt.Errorf("%v is not a string", v)
		}
	case "object":
		obj, ok := v.(map[string]any)
		if !ok {
			return fmt.Errorf("%v is not an object", v)
		}
		props, _ := schema["properties"].(map[string]any)
		required, _ := schema["required"].([]any)
		for _, k := range required {
			if _, ok := obj[k.(string)]; !ok {
				return fmt.Errorf("missing %s", k)
			}
		}
		for k, val := range obj {
			sub, known := props[k].(map[string]any)
			if !known && schema["additionalProperties"] == false {
				return fmt.Errorf("unexpected %s", k)
			}
			if known {
				if err := validate(root, sub, val); err != nil {
					return fmt.Errorf("%s: %w", k, err)
				}
			}
		}
	}
	return nil
}

func list(v any) []map[string]any {
	var out []map[string]any
	for _, x := range func() []any { l, _ := v.([]any); return l }() {
		if m, ok := x.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func contains(l []any, v any) bool {
	for _, x := range l {
		if x == v {
			return true
		}
	}
	return false
}

func answer(t *testing.T, argv string, input []byte) map[string]any {
	t.Helper()
	cfg, err := loadConfig("data")
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	_ = json.Unmarshal(input, &payload)
	var out Out
	if argv == "guard" {
		out = runGuard(payload, input)
	} else {
		out = dispatch(cfg, argv, str(payload["hook_event_name"]), payload, input)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(out.JSON()), &got); err != nil {
		t.Fatalf("output is not JSON: %v", err)
	}
	return got
}

func TestContractExamples(t *testing.T) {
	repo := sandbox(t)
	schema := loadSchema(t)
	defs := schema["$defs"].(map[string]any)
	for i, ex := range list(schema["examples"]) {
		input, _ := json.Marshal(ex["input"])
		input = []byte(strings.ReplaceAll(string(input), "{repo}", repo))
		var payload map[string]any
		_ = json.Unmarshal(input, &payload)
		event := str(payload["hook_event_name"])
		inDef := map[string]string{"PostToolUseFailure": "PostToolUse", "SubagentStart": "SessionStart"}[event]
		if inDef == "" {
			inDef = event
		}
		if err := validate(schema, defs[inDef].(map[string]any), payload); err != nil {
			t.Errorf("example %d input: %v", i, err)
		}
		argv := ex["argv"].([]any)[0].(string)
		got := answer(t, argv, input)
		want := ex["output"].(string)
		if err := validate(schema, defs[want].(map[string]any), got); err != nil {
			t.Errorf("example %d (%s %s) answered %v, want %s: %v", i, argv, event, got, want, err)
		}
		if err := validate(schema, defs["output"].(map[string]any), got); err != nil {
			t.Errorf("example %d output: %v", i, err)
		}
	}
}

// A crash says what went unchecked and never blocks.
func TestCrashIsPlainAndAllows(t *testing.T) {
	sandbox(t)
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "AICO_HOOK_AS_MAIN=1", "AICO_HOOK_ARGS=claude", "AICO_HOOK_DATA="+t.TempDir())
	cmd.Stdin = strings.NewReader(`{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}`)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("crash exited non-zero: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("crash output %q: %v", out, err)
	}
	if err := validate(loadSchema(t), loadSchema(t)["$defs"].(map[string]any)["context"].(map[string]any), got); err != nil {
		t.Fatalf("crash output %v: %v", got, err)
	}
	text := got["hookSpecificOutput"].(map[string]any)["additionalContext"].(string)
	if !strings.Contains(text, "aico-hook crashed") || !strings.Contains(text, "not checked") {
		t.Errorf("crash text %q", text)
	}
}

func TestSessionStartGathersEachPart(t *testing.T) {
	repo := sandbox(t)
	cfg, err := loadConfig("data")
	if err != nil {
		t.Fatal(err)
	}
	cfg.StartupBrief.Release, cfg.StartupBrief.Checkout = "/nonexistent", "/nonexistent"
	cfg.Publication.ClaudeSettings = filepath.Join(repo, "none.json")
	stub := filepath.Join(repo, "deliver.sh")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\necho \"{\\\"hookSpecificOutput\\\":{\\\"hookEventName\\\":\\\"SessionStart\\\",\\\"additionalContext\\\":\\\"CTX $*\\\"}}\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg.Context.Command = []string{stub}
	t.Setenv("PATH", "/usr/bin:/bin") // no codex: its trust is reported unverified
	out := sessionStart(cfg, "claude", "SessionStart", map[string]any{"hook_event_name": "SessionStart",
		"session_id": "0f0e0d0c-0000-4000-8000-000000000009", "cwd": repo, "source": "startup"})
	text := strings.Join(out.Context, "\n")
	for _, want := range []string{
		"Claude publication adapter: unavailable",
		"CTX --tool claude-code --session 0f0e0d0c-0000-4000-8000-000000000009 --format claude --event SessionStart --project demo",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("session start lacks %q:\n%s", want, text)
		}
	}
}
