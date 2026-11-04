package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The Pi extension (pi/aico-hook.ts) run by Node against the real hook and against broken ones, as SummitFlow's
// test_pi_publication_guard_extension.py did for its guard: a bash or connector call is refused on any fault; an
// edit goes ahead and its result carries the note.

const piFixture = `import adapter from %q;
const on = {};
adapter({ on: (name, fn) => { on[name] = fn; }, sendUserMessage() {} });
const ctx = { cwd: process.cwd(), isIdle: () => false,
	sessionManager: { getSessionId: () => "0f0e0d0c-0000-4000-8000-00000000000a", getCwd: () => process.cwd() } };
const out = [];
for (const [toolName, input] of JSON.parse(process.argv[2])) {
	const event = { toolName, toolCallId: "c" + out.length, input };
	const call = (await on.tool_call(event, ctx)) ?? null;
	let note = null;
	if (!call) {
		const res = await on.tool_result({ ...event, content: [] }, ctx);
		note = res?.content?.map((c) => c.text).join("\n") ?? null;
	}
	out.push({ call, note });
}
console.log(JSON.stringify(out));
`

type piAnswer struct {
	Call *struct {
		Block  bool   `json:"block"`
		Reason string `json:"reason"`
	} `json:"call"`
	Note *string `json:"note"`
}

// runPi installs the extension in a fresh dir with `hook` as its aico-hook ("" for none) and runs the calls.
func runPi(t *testing.T, hook string, calls [][2]any) []piAnswer {
	t.Helper()
	node := tsNode()
	if node == "" {
		t.Skip("a Node that runs TypeScript (22.6+ with type stripping) is required for the Pi extension fixture")
	}
	dir := t.TempDir()
	src, err := os.ReadFile("pi/aico-hook.ts")
	if err != nil {
		t.Fatal(err)
	}
	ext := filepath.Join(dir, "pi", "aico-hook.ts")
	if err := os.MkdirAll(filepath.Dir(ext), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ext, src, 0o644); err != nil {
		t.Fatal(err)
	}
	switch {
	case hook == "self": // this test binary standing in for aico-hook (TestMain)
		if err := os.Symlink(os.Args[0], filepath.Join(dir, "aico-hook")); err != nil {
			t.Fatal(err)
		}
	case hook != "":
		if err := os.WriteFile(filepath.Join(dir, "aico-hook"), []byte("#!/bin/sh\n"+hook+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	fixture := filepath.Join(dir, "fixture.mjs")
	if err := os.WriteFile(fixture, []byte(strings.Replace(piFixture, "%q", `"file://`+ext+`"`, 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	arg, _ := json.Marshal(calls)
	cmd := exec.Command(node, fixture, string(arg))
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PATH=/usr/bin:/bin", "HOME="+dir, "AICO_HOOK_AS_MAIN=1", "AICO_HOOK_ARGS=pi")
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node: %v %s", err, stderr.String())
	}
	var got []piAnswer
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("fixture printed %q: %v", out, err)
	}
	return got
}

// tsNode is the first node on PATH that strips TypeScript types (a distro build may lack it).
func tsNode() string {
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		node := filepath.Join(dir, "node")
		if out, err := exec.Command(node, "-p", "process.features.typescript").Output(); err == nil &&
			strings.TrimSpace(string(out)) != "false" && strings.TrimSpace(string(out)) != "undefined" {
			return node
		}
	}
	return ""
}

var (
	piPush  = [2]any{"bash", map[string]any{"command": "git push origin main"}}
	piLs    = [2]any{"bash", map[string]any{"command": "ls -la"}}
	piMerge = [2]any{"mcp__github__merge_pull_request", map[string]any{"pull_number": 1}}
	piRead  = [2]any{"mcp__github__get_file_contents", map[string]any{"path": "a"}}
	piEdit  = [2]any{"edit", map[string]any{"path": "/tmp/aico-hook-pi-test.txt"}}
	piOther = [2]any{"read", map[string]any{"path": "/tmp/x"}}
)

func TestPiBlocksWithTheGuardsReasonAndOtherCallsPass(t *testing.T) {
	sandbox(t)
	got := runPi(t, "self", [][2]any{piPush, piMerge, piLs, piOther})
	if c := got[0].Call; c == nil || !c.Block || c.Reason != "Use the canonical ST publication workflow." {
		t.Errorf("git push: %+v", got[0].Call)
	}
	if c := got[1].Call; c == nil || !c.Block {
		t.Errorf("connector merge: %+v", got[1].Call)
	}
	if got[2].Call != nil || got[3].Call != nil {
		t.Errorf("ls and read must pass: %+v %+v", got[2].Call, got[3].Call)
	}
}

func TestPiRefusesGuardedCallsOnAnyFault(t *testing.T) {
	sandbox(t)
	for name, hook := range map[string]string{
		"missing":    "",
		"exits 3":    "exit 3",
		"exits 2":    `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"x"}}'; exit 2`,
		"killed":     "kill -KILL $$",
		"unreadable": "echo not-json",
	} {
		got := runPi(t, hook, [][2]any{piLs, piRead, piEdit})
		for i, what := range []string{"bash", "connector"} {
			if c := got[i].Call; c == nil || !c.Block || !strings.Contains(c.Reason, "execution refused") {
				t.Errorf("%s hook, %s: want refused, got %+v", name, what, got[i].Call)
			}
		}
		if got[2].Call != nil || got[2].Note == nil || !strings.Contains(*got[2].Note, "was not checked") {
			t.Errorf("%s hook, edit: want it to go ahead with a note, got %+v note %v", name, got[2].Call, got[2].Note)
		}
	}
	// A clean `{}` from the hook lets bash run.
	if got := runPi(t, "echo '{}'", [][2]any{piLs}); got[0].Call != nil {
		t.Errorf("clean allow: %+v", got[0].Call)
	}
}
