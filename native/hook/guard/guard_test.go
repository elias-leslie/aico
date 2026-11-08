package guard

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Focused tests for what the recorded corpus cannot reach: the fault and
// failure paths, the bounds, Load errors, and Python-compat helpers.

func TestFaultAllowsAndReports(t *testing.T) {
	r := loadRules(t)
	gone := filepath.Join(t.TempDir(), "gone")
	if err := os.Mkdir(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(gone)
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}
	// No cwd in the payload and no working directory to fall back on: the
	// irreversible check cannot run, so the command is allowed with a Fault.
	res := r.Evaluate(map[string]any{
		"tool_name":  "Bash",
		"tool_input": map[string]any{"command": "ls"},
	})
	if res.Deny || res.Fault == "" || !strings.Contains(res.Fault, "command allowed unchecked") {
		t.Fatalf("want allow with fault, got %+v", res)
	}
}

// A panic anywhere on the guard path denies, the irreversible check included.
func TestPanicInIrreversibleCheckDenies(t *testing.T) {
	c := *loadRules(t)
	c.rcloneRemote = nil // only the irreversible rclone rule reads it
	res := c.Evaluate(map[string]any{
		"tool_name":  "Bash",
		"tool_input": map[string]any{"command": "rclone delete b:c"},
		"cwd":        "/tmp",
	})
	if !res.Deny || res.Reason != c.reasons.evaluationError {
		t.Fatalf("want a deny, got %+v", res)
	}
}

// The commands that end the one tmux server every session lives in are denied; their near neighbours are not.
func TestTmuxServerKillsAreDenied(t *testing.T) {
	r := loadRules(t)
	for _, command := range []string{
		"pkill tmux", "pkill -9 tmux", "pkill -x tmux", "pkill -u kasadis tmux", "pkill --signal 9 tmux",
		"pkill -f tmux", "pkill -f 'tmux: server'", "pkill -f '[t]mux'", "sudo pkill tmux", "/usr/bin/pkill tmux",
		"pkill -f '[t]mux -S'", "pkill -f '[s]erver.sock'", "pkill 'tmux:'", "pkill --full '[t]mux -S'", "pkill -9f '[t]mux'",
		"pkill '*tmux*'", "pkill server",
		"killall tmux", "killall -9 tmux", "sudo killall -r tmux", "killall /usr/bin/tmux", "true && killall tmux",
		"systemctl --user stop aico-tmux-server-46aafdb9c5e62d4651484a18eb6e5a52.service",
		"systemctl --user kill aico-tmux-server-46aafdb9c5e62d4651484a18eb6e5a52.service",
		"systemctl --user restart tether-dev-tmux-server-abc.service",
		"systemctl --user stop 'aico-tmux-server-*'", "systemctl --user stop app.slice",
		"sudo systemctl restart user@1000.service", "systemctl restart user@1000", "sudo systemctl stop user-1000.slice",
		"systemctl --user stop '*tmux*'", "systemctl --user stop '*tmux-*'",
	} {
		if res := r.Evaluate(bash(command)); !res.Deny || !strings.Contains(res.Reason, "tmux server") && !strings.Contains(res.Reason, "pkill -f") {
			t.Errorf("%q: want the tmux server deny, got %+v", command, res)
		}
	}
	for _, command := range []string{
		"pkill node", "pkill -f '[t]mux -S /tmp/zz/s'", "pkill -x tmuxinator", "pkill -f '[d]adbot.web'", "pkill -f -u kasadis '[v]ite'",
		"killall chrome",
		"systemctl --user status aico-tmux-server-abc.service", "systemctl --user list-units '*tmux-server*'",
		"systemctl --user show aico-tmux-server-abc.service", "systemctl --user stop tether@dev.service",
		"systemctl --user stop zzv-proof.service", "tmux -S /tmp/zz/s kill-server",
	} {
		if res := r.Evaluate(bash(command)); res.Deny {
			t.Errorf("%q: want allowed, got %+v", command, res)
		}
	}
}

func bash(command string) map[string]any {
	return map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": command}, "cwd": "/tmp"}
}

// Nested eval used to cost quadratic time and memory with no bound (5000 levels > 10 s, 20000 levels 6.3 GiB).
// Past the nesting bound the guard denies at once; run under a memory cap (GOMEMLIMIT, ulimit -v).
func TestEvalBombIsDeniedFast(t *testing.T) {
	r := loadRules(t)
	for _, command := range []string{
		strings.Repeat("eval ", 5000) + "git push",
		strings.Repeat("eval ", 5000) + "ls",
		strings.Repeat("ssh h ", 200) + "ls", // only the irreversible check follows ssh
	} {
		start := time.Now()
		res := r.Evaluate(bash(command))
		took := time.Since(start)
		t.Logf("%.20q... (%d bytes): %v", command, len(command), took)
		if took > time.Second {
			t.Errorf("%.30q... took %v", command, took)
		}
		if !res.Deny || res.Reason != r.reasons.tooDeep {
			t.Errorf("%.30q...: want the nesting deny, got %+v", command, res)
		}
	}
	// Within the bound nothing changes: 64 levels still reach the publication rule.
	if res := r.Evaluate(bash(strings.Repeat("eval ", 63) + "git push")); res.Reason != r.reasons.publication {
		t.Errorf("63 evals: %+v", res)
	}
	if res := r.Evaluate(bash(strings.Repeat("eval ", 63) + "ls")); res.Deny {
		t.Errorf("63 evals of ls: %+v", res)
	}
}

func TestOversizedCommandIsDenied(t *testing.T) {
	r := loadRules(t)
	start := time.Now()
	res := r.Evaluate(bash("echo " + strings.Repeat("a", 1<<20)))
	if took := time.Since(start); took > time.Second || !res.Deny || res.Reason != r.reasons.tooLarge {
		t.Fatalf("1 MB command: %+v after %v", res, took)
	}
	if res := r.Evaluate(bash("echo " + strings.Repeat("a", r.maxBytes-5))); res.Deny {
		t.Fatalf("a command at the cap is judged as usual: %+v", res)
	}
	argv := map[string]any{"tool_name": "exec_command", "tool_input": map[string]any{
		"cmd": []any{"echo", strings.Repeat("a", 1<<20)}}}
	if res := r.Evaluate(argv); res.Reason != r.reasons.tooLarge {
		t.Fatalf("1 MB argv: %+v", res)
	}
}

func TestDeadlineDenies(t *testing.T) {
	c := *loadRules(t)
	c.deadline = time.Microsecond
	res := c.Evaluate(bash(strings.Repeat("echo $(echo $(echo hi)); ", 2000)))
	if !res.Deny || res.Reason != c.reasons.tooSlow {
		t.Fatalf("past the deadline: %+v", res)
	}
}

func TestLimitsDefaultWhenAbsent(t *testing.T) {
	f := readFile(t)
	f.Limits.MaxNestingDepth, f.Limits.MaxCommandBytes, f.Limits.DeadlineMS = 0, -1, 0
	r, err := build(f)
	if err != nil {
		t.Fatal(err)
	}
	if r.maxDepth != DefaultMaxDepth || r.maxBytes != DefaultMaxBytes || r.deadline != DefaultDeadlineMS*time.Millisecond {
		t.Fatalf("defaults: depth %d bytes %d deadline %v", r.maxDepth, r.maxBytes, r.deadline)
	}
	if !strings.Contains(r.reasons.tooDeep, "64") {
		t.Fatalf("the reason names the bound: %q", r.reasons.tooDeep)
	}
}

func TestZeroRulesDeny(t *testing.T) {
	var r Rules
	res := r.Evaluate(map[string]any{
		"tool_name":  "Bash",
		"tool_input": map[string]any{"command": "ls"},
	})
	if !res.Deny {
		t.Fatalf("a zero Rules must fail closed, got %+v", res)
	}
}

func TestLoadErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := Load(filepath.Join(dir, "missing.json")); err == nil {
		t.Fatal("missing file must fail")
	}
	for name, body := range map[string]string{
		"unknown field": `{"nonsense": 1}`,
		"not json":      `not json`,
		"empty rules":   `{}`,
	} {
		p := filepath.Join(dir, strings.ReplaceAll(name, " ", "_")+".json")
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(p); err == nil {
			t.Errorf("%s: Load must fail", name)
		}
	}
}

func readFile(t *testing.T) *file {
	t.Helper()
	raw, err := os.ReadFile(rulesPath)
	if err != nil {
		t.Fatal(err)
	}
	var f file
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return &f
}

func TestBuildRejectsBadRules(t *testing.T) {
	f := readFile(t)
	f.Publication.DisablePattern = "(unclosed"
	if _, err := build(f); err == nil || !strings.Contains(err.Error(), "disable_pattern") {
		t.Fatalf("bad regex must be named, got %v", err)
	}
	f = readFile(t)
	f.Payload.GuardedTools = "^(Bash"
	if _, err := build(f); err == nil || !strings.Contains(err.Error(), "guarded_tools") {
		t.Fatalf("a bad tool pattern must fail the load, got %v", err)
	}
	f = readFile(t)
	f.Payload.GuardedTools = ""
	if _, err := build(f); err == nil {
		t.Fatal("a missing tool pattern must fail the load")
	}
	f = readFile(t)
	f.Reasons.TooSlow = ""
	if _, err := build(f); err == nil || !strings.Contains(err.Error(), "too_slow") {
		t.Fatalf("missing reason must be named, got %v", err)
	}
	f = readFile(t)
	delete(f.Messages, "restic")
	if _, err := build(f); err == nil || !strings.Contains(err.Error(), "restic") {
		t.Fatalf("missing message must be named, got %v", err)
	}
	if _, err := build(readFile(t)); err != nil {
		t.Fatalf("untouched rules must build: %v", err)
	}
}

func TestForcePushesSharedMain(t *testing.T) {
	r := loadRules(t)
	for args, want := range map[string]bool{
		"-f origin main":        true,
		"--force origin master": true,
		"-f origin HEAD:main":   true,
		"origin main":           false,
		"-f origin feature":     false,
		"":                      false,
	} {
		if got := r.forcePushesSharedMain(strings.Fields(args)); got != want {
			t.Errorf("%q: got %v want %v", args, got, want)
		}
	}
}

func TestSplitShellSegmentsFallback(t *testing.T) {
	got := splitShellSegments("a b; c && d | e || f")
	if len(got) != 4 && len(got) != 5 {
		t.Fatalf("segments: %v", got)
	}
	if got := splitShellSegments("echo 'broken"); len(got) != 1 || got[0][0] != "echo 'broken" {
		t.Fatalf("unterminated quote falls back to the whole command: %v", got)
	}
}

func TestPyStr(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{nil, "None"},
		{"x", "x"},
		{[]any{"a", nil}, "[a, None]"},
		{map[string]any{"k": "v"}, "{k: v}"},
		{float64(3), "3"},
		{true, "true"},
	}
	for _, c := range cases {
		if got := pyStr(c.in); got != c.want {
			t.Errorf("pyStr(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestPathHelpers(t *testing.T) {
	t.Setenv("HOME", "/home/h")
	for in, want := range map[string]string{
		"~":          "/home/h",
		"~/x":        "/home/h/x",
		"~nosuchusr": "~nosuchusr",
		"a~":         "a~",
	} {
		if got := expandUser(in); got != want {
			t.Errorf("expandUser(%q) = %q, want %q", in, got, want)
		}
	}
	t.Setenv("HOME", "/")
	if got := expandUser("~"); got != "/" {
		t.Errorf("expandUser with root HOME = %q", got)
	}
	for in, want := range map[string]string{
		"":          ".",
		"a//b/../c": "a/c",
		"//x":       "//x",
		"///x":      "/x",
		"/../..":    "/",
		"./":        ".",
		"a/..":      ".",
		"../a":      "../a",
	} {
		if got := normPath(in); got != want {
			t.Errorf("normPath(%q) = %q, want %q", in, got, want)
		}
	}
	for _, c := range [][3]string{{"a", "b", "a/b"}, {"a/", "b", "a/b"}, {"a", "/b", "/b"}, {"", "b", "b"}} {
		if got := joinPath(c[0], c[1]); got != c[2] {
			t.Errorf("joinPath(%q,%q) = %q, want %q", c[0], c[1], got, c[2])
		}
	}
	if got := dirName("/a/b"); got != "/a" {
		t.Errorf("dirName = %q", got)
	}
	if got := dirName("b"); got != "" {
		t.Errorf("dirName(b) = %q", got)
	}
	if !under("/a/b", "/a") || under("/ab", "/a") || !under("/a", "/a") {
		t.Error("under")
	}
}

func TestCaseHelpers(t *testing.T) {
	if got := pyLower("İ"); got != "i̇" {
		t.Errorf("pyLower dotted I = %q", got)
	}
	if got := pyCasefold("ſßﬃ"); got != "ssffi" && got != "s"+"ss"+"ffi" {
		t.Errorf("pyCasefold = %q", got)
	}
	if got := pyUpper("ßﬆ"); got != "SSST" {
		t.Errorf("pyUpper = %q", got)
	}
	if got := regexText("İıſK xé y", true); got != "iis"+"k x_ y" && got != "iisk x_ y" {
		// é is a word character and becomes _, nbsp a space.
		t.Errorf("regexText fold = %q", got)
	}
	if got := regexText("İ \x0b", false); strings.ContainsRune(got, 'i') {
		t.Errorf("regexText without fold must not fold: %q", got)
	}
}

func TestShlexEdges(t *testing.T) {
	if _, err := shlexSplit(`a "b`); err == nil {
		t.Error("unterminated quote must fail")
	}
	if _, err := shlexSplit(`a\`); err == nil {
		t.Error("trailing escape must fail")
	}
	if got, _ := shlexSplit(`'' x`); len(got) != 2 || got[0] != "" {
		t.Errorf("empty quoted token: %q", got)
	}
	if got := shlexQuote(""); got != "''" {
		t.Errorf("shlexQuote empty = %q", got)
	}
	if got := shlexJoin([]string{"a b", "c'd"}); got != `'a b' 'c'"'"'d'` {
		t.Errorf("shlexJoin = %q", got)
	}
	if got := pathName("/"); got != "" {
		t.Errorf("pathName(/) = %q", got)
	}
}

func BenchmarkEvaluate(b *testing.B) {
	r := loadRules(b)
	payloads := []map[string]any{
		{"tool_name": "Bash", "tool_input": map[string]any{"command": "ls -la /tmp && git status --short"}, "cwd": "/tmp"},
		{"tool_name": "Bash", "tool_input": map[string]any{"command": "cd /srv/workspaces/projects/aico && go test ./... 2>&1 | tail -20"}, "cwd": "/srv/workspaces/projects/aico"},
		{"tool_name": "Bash", "tool_input": map[string]any{"command": "git push origin main"}, "cwd": "/srv/workspaces/projects/aico"},
		{"tool_name": "Bash", "tool_input": map[string]any{"command": "ssh host 'cd /srv/x && rm -rf build'"}, "cwd": "/srv/workspaces/projects/aico"},
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		r.Evaluate(payloads[i%len(payloads)])
	}
}
