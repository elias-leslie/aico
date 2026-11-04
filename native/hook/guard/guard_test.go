package guard

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Focused tests for what the recorded corpus cannot reach: the fail-open
// fault paths, Load errors, and Python-compat helpers.

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

func TestPanicInIrreversibleCheckAllows(t *testing.T) {
	c := *loadRules(t)
	c.rcloneRemote = nil // only the irreversible rclone rule reads it
	res := c.Evaluate(map[string]any{
		"tool_name":  "Bash",
		"tool_input": map[string]any{"command": "rclone delete b:c"},
		"cwd":        "/tmp",
	})
	if res.Deny || !strings.Contains(res.Fault, "irreversible-command check failed") {
		t.Fatalf("want allow with fault, got %+v", res)
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
