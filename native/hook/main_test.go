package main

import (
	"aico/hook/testtether"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"aico/hook/guard"
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

// sandbox isolates leases, shell snapshots, Tether and the startup checks; returns a fresh git checkout. The
// hook reads a copy of data/ (AICO_HOOK_DATA) whose context command is off, so the real `aico context deliver`
// stays out of the examples.
func sandbox(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	data := filepath.Join(tmp, "data")
	if err := os.Mkdir(data, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"hook.json", "guard.json"} {
		raw, err := os.ReadFile(filepath.Join("data", name))
		if err != nil {
			t.Fatal(err)
		}
		if name == "hook.json" {
			var cfg map[string]any
			if err := json.Unmarshal(raw, &cfg); err != nil {
				t.Fatal(err)
			}
			cfg["context"].(map[string]any)["command"] = []any{}
			cfg["inbox"].(map[string]any)["memory"] = []any{}
			raw, _ = json.Marshal(cfg)
		}
		if err := os.WriteFile(filepath.Join(data, name), raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("AICO_HOOK_DATA", data)
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(tmp, "run"))
	testtether.Start(t, filepath.Join(tmp, "tether"))
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
	var payload map[string]any
	_ = json.Unmarshal(input, &payload)
	event := str(payload["hook_event_name"])
	if event == "" {
		event = "PreToolUse"
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(handle(argv, event, payload, input).JSON()), &got); err != nil {
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

// runMain runs the real aico-hook main (this test binary standing in) on one payload: exit status and answer.
func runMain(t *testing.T, mode, input string) map[string]any {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "AICO_HOOK_AS_MAIN=1", "AICO_HOOK_ARGS="+mode)
	cmd.Stdin = strings.NewReader(input)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("aico-hook %s exited non-zero: %v", mode, err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("aico-hook %s printed %q: %v", mode, out, err)
	}
	return got
}

// verdict is the deny reason, or "" and the additionalContext; each answer must fit the output contract.
func verdict(t *testing.T, got map[string]any) (deny, context string) {
	t.Helper()
	schema := loadSchema(t)
	if err := validate(schema, schema["$defs"].(map[string]any)["output"].(map[string]any), got); err != nil {
		t.Fatalf("answer %v: %v", got, err)
	}
	spec, _ := got["hookSpecificOutput"].(map[string]any)
	return str(spec["permissionDecisionReason"]), str(spec["additionalContext"])
}

const (
	callLs      = `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"/tmp"}`
	callPush    = `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push origin main"},"cwd":"/tmp"}`
	callExec    = `{"hook_event_name":"PreToolUse","tool_name":"exec_command","tool_input":{"cmd":["ls","-la"]},"cwd":"/tmp"}`
	callMerge   = `{"hook_event_name":"PreToolUse","tool_name":"mcp__github__merge_pull_request","tool_input":{"pull_number":1}}`
	callGitRead = `{"hook_event_name":"PreToolUse","tool_name":"mcp__github__get_file_contents","tool_input":{"path":"a"}}`
	callEdit    = `{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"/tmp/x"},"cwd":"/tmp"}`
)

// guard.json missing, corrupt or with a bad tool pattern: shell and connector calls are refused (plainly, naming
// the old fallback deny list where it matches), plain edits go ahead with a note. Exit 0 every time.
func TestGuardDataFailureRefusesShellAndConnectorCalls(t *testing.T) {
	sandbox(t)
	guardPath := filepath.Join(os.Getenv("AICO_HOOK_DATA"), "guard.json")
	good, _ := os.ReadFile(guardPath)
	for name, body := range map[string]string{
		"missing":     "",
		"corrupt":     `{"reasons": {`,
		"bad pattern": strings.Replace(string(good), `"guarded_tools": "^(`, `"guarded_tools": "^((`, 1),
	} {
		if body == "" {
			_ = os.Remove(guardPath)
		} else if err := os.WriteFile(guardPath, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		for _, mode := range []string{"claude", "codex", "pi", "guard"} {
			for _, call := range []string{callLs, callPush, callExec, callMerge, callGitRead} {
				deny, _ := verdict(t, runMain(t, mode, call))
				if !strings.Contains(deny, "could not load its guard rules") || !strings.Contains(deny, "refuses every shell") {
					t.Errorf("%s guard.json, %s %s: want a plain deny, got %q", name, mode, call, deny)
				}
			}
		}
		deny, _ := verdict(t, runMain(t, "claude", callPush))
		if !strings.Contains(deny, "fallback deny list (direct publication)") {
			t.Errorf("%s guard.json: git push names the fallback list: %q", name, deny)
		}
		deny, context := verdict(t, runMain(t, "claude", callEdit))
		if deny != "" || !strings.Contains(context, "could not load its guard rules") || !strings.Contains(context, "went ahead") {
			t.Errorf("%s guard.json: an edit goes ahead with a note, got deny %q context %q", name, deny, context)
		}
	}
}

// hook.json missing, corrupt or with a bad tool pattern: the guard still judges; leases are skipped with a note.
func TestHookDataFailureKeepsTheGuard(t *testing.T) {
	sandbox(t)
	hookPath := filepath.Join(os.Getenv("AICO_HOOK_DATA"), "hook.json")
	good, _ := os.ReadFile(hookPath)
	for name, body := range map[string]string{
		"missing":     "",
		"corrupt":     `{"lease": {`,
		"bad pattern": strings.Replace(string(good), `"shell":"^(`, `"shell":"^((`, 1),
	} {
		if body == string(good) {
			t.Fatalf("%s: the fixture did not change hook.json", name)
		}
		if body == "" {
			_ = os.Remove(hookPath)
		} else if err := os.WriteFile(hookPath, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		for _, mode := range []string{"claude", "codex", "pi"} {
			if deny, _ := verdict(t, runMain(t, mode, callPush)); deny != "Use the canonical ST publication workflow." {
				t.Errorf("%s hook.json, %s: git push must stay denied by the guard, got %q", name, mode, deny)
			}
			if deny, _ := verdict(t, runMain(t, mode, callMerge)); deny == "" {
				t.Errorf("%s hook.json, %s: a connector merge must stay denied", name, mode)
			}
			for _, call := range []string{callLs, callEdit} {
				deny, context := verdict(t, runMain(t, mode, call))
				if deny != "" || !strings.Contains(context, "could not read hook.json") {
					t.Errorf("%s hook.json, %s %s: want allowed with a note, got deny %q context %q", name, mode, call, deny, context)
				}
			}
		}
	}
}

// A panic on the guard path refuses shell and connector calls; an edit still goes ahead with a note.
func TestGuardPanicRefuses(t *testing.T) {
	sandbox(t)
	saved := loadRules
	t.Cleanup(func() { loadRules = saved })
	loadRules = func() (*guard.Rules, error) { return &guard.Rules{}, nil } // zero rules: Guards panics
	for _, call := range []string{callLs, callExec, callMerge} {
		deny, _ := verdict(t, answer(t, "claude", []byte(call)))
		if !strings.Contains(deny, "crashed while checking it") {
			t.Errorf("%s: want a crash deny, got %q", call, deny)
		}
	}
	deny, context := verdict(t, answer(t, "claude", []byte(callEdit)))
	if deny != "" || !strings.Contains(context, "crashed") {
		t.Errorf("edit after a guard crash: deny %q context %q", deny, context)
	}
}

// The eval bomb and a 1 MB command through the real binary: denied, quickly, exit 0. Run under a memory cap.
func TestBombsAreDeniedQuickly(t *testing.T) {
	sandbox(t)
	for name, command := range map[string]string{
		"eval bomb": strings.Repeat("eval ", 5000) + "git push",
		"1 MB":      "echo " + strings.Repeat("a", 1<<20),
	} {
		input, _ := json.Marshal(map[string]any{"hook_event_name": "PreToolUse", "tool_name": "Bash",
			"tool_input": map[string]any{"command": command}, "cwd": "/tmp"})
		start := time.Now()
		deny, _ := verdict(t, runMain(t, "claude", string(input)))
		if took := time.Since(start); deny == "" || took > time.Second {
			t.Errorf("%s: deny %q after %v", name, deny, took)
		}
	}
}

func TestSessionStartGathersEachPart(t *testing.T) {
	repo := sandbox(t)
	cfg, err := loadConfig("data")
	if err != nil {
		t.Fatal(err)
	}
	cfg.Publication.ClaudeSettings = filepath.Join(repo, "none.json")
	stub := filepath.Join(repo, "deliver.sh")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\necho \"{\\\"hookSpecificOutput\\\":{\\\"hookEventName\\\":\\\"SessionStart\\\",\\\"additionalContext\\\":\\\"CTX $*\\\"}}\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg.Context.Command = []string{stub}
	briefStub := filepath.Join(repo, "pulse.sh")
	if err := os.WriteFile(briefStub, []byte("#!/bin/sh\necho \"System brief: $* $(cat | grep -o session_id)\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg.StartupBrief.Command = []string{briefStub, "pulse", "--start"}
	t.Setenv("PATH", "/usr/bin:/bin") // no codex: its trust is reported unverified
	out := sessionStart(cfg, "claude", "SessionStart", map[string]any{"hook_event_name": "SessionStart",
		"session_id": "0f0e0d0c-0000-4000-8000-000000000009", "cwd": repo, "source": "startup"})
	text := strings.Join(out.Context, "\n")
	for _, want := range []string{
		"Claude publication adapter: unavailable",
		"System brief: pulse --start session_id",
		"CTX --tool claude-code --session 0f0e0d0c-0000-4000-8000-000000000009 --format claude --event SessionStart --project demo",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("session start lacks %q:\n%s", want, text)
		}
	}
}

// codex-trust trusts the current slots of the user hooks file and drops trust entries for slots that no longer
// exist (a removed hook's slot), keeping every other entry. Runs the real Codex app-server on a temp CODEX_HOME.
func TestCodexTrustDropsStaleSlots(t *testing.T) {
	if _, err := exec.LookPath("codex"); err != nil {
		t.Skip("codex is required")
	}
	sandbox(t)
	home := filepath.Join(t.TempDir(), "codex")
	hooksFile := filepath.Join(home, "hooks.json")
	hookPath := filepath.Join(os.Getenv("AICO_HOOK_DATA"), "hook.json")
	var cfg map[string]any
	raw, _ := os.ReadFile(hookPath)
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	cfg["publication"].(map[string]any)["codex_hooks"] = hooksFile
	raw, _ = json.Marshal(cfg)
	if err := os.WriteFile(hookPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hooksFile, []byte(`{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command",`+
		`"command":"aico-hook codex","timeout":10}]}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	stale := hooksFile + ":pre_tool_use:1:0"
	config := fmt.Sprintf("[hooks.state.%q]\ntrusted_hash = \"sha256:bbbb\"\n\n[hooks.state.\"other@plugin:stop:0:0\"]\n"+
		"trusted_hash = \"sha256:cccc\"\n", stale)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", home)
	if code := codexTrust([]string{"--cwd", home}); code != 0 {
		t.Fatalf("codex-trust exited %d", code)
	}
	got, _ := os.ReadFile(filepath.Join(home, "config.toml"))
	if strings.Contains(string(got), stale) || !strings.Contains(string(got), "other@plugin:stop:0:0") ||
		!strings.Contains(string(got), hooksFile+":pre_tool_use:0:0") {
		t.Fatalf("config after codex-trust:\n%s", got)
	}
}
