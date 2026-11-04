package lease

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func testConfig() Config {
	return Config{IdleTTLMinutes: 30, ActiveMinutes: 10, RegistryHours: 24, NoteHours: 24, UnackedMinutes: 10,
		SnapshotMaxMins: 120, RegistrySaveSec: 60}
}

// sandbox isolates the lease store, the shell snapshots and Tether, and drops any harness identity the test
// runner inherited, so each payload's session_id is the agent.
func sandbox(t *testing.T) (repo string) {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("ST_LEASES_DIR", filepath.Join(tmp, "leases"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(tmp, "run"))
	t.Setenv("TETHER_SOCKET", filepath.Join(tmp, "none.sock"))
	t.Setenv("ST_COORD_ANCHOR", "")
	t.Setenv("ST_COORD_HARNESS", "")
	t.Setenv("ST_COORD_SENSITIVE", "")
	for _, k := range append([]string{"ST_SESSION_ID", "AGENT_HUB_SESSION_ID", "TMUX", "TMUX_PANE"}, identityEnv...) {
		t.Setenv(k, "")
	}
	repo = filepath.Join(tmp, "demo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "-C", repo, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	return repo
}

func edit(sid, path string) map[string]any {
	return map[string]any{"hook_event_name": "PreToolUse", "session_id": sid, "tool_name": "Edit",
		"tool_input": map[string]any{"file_path": path}, "cwd": filepath.Dir(path)}
}

func storeDoc(t *testing.T, project string) map[string]json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(os.Getenv("ST_LEASES_DIR"), project+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var d map[string]json.RawMessage
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestEditLeasesAndWarnsTheSecondWriter(t *testing.T) {
	repo := sandbox(t)
	file := filepath.Join(repo, "a.txt")
	a, b := "11111111-aaaa-4bbb-8ccc-000000000001", "22222222-aaaa-4bbb-8ccc-000000000002"

	if blocked, text := New(testConfig(), edit(a, file)).Edit(); blocked || text != "" {
		t.Fatalf("first writer: blocked=%v text=%q", blocked, text)
	}
	if blocked, text := New(testConfig(), edit(a, file)).Edit(); blocked || text != "" {
		t.Fatalf("own lease again: blocked=%v text=%q", blocked, text)
	}
	blocked, text := New(testConfig(), edit(b, file)).Edit()
	if blocked {
		t.Fatalf("a foreign lease never blocks: %q", text)
	}
	for _, want := range []string{"WARNING: ", "cc:111111", "edit allowed", `st sessions send cc:111111 "<what changed>" --delivery handshake`} {
		if !strings.Contains(text, want) {
			t.Errorf("warning %q lacks %q", text, want)
		}
	}

	d := storeDoc(t, "demo")
	var leases []map[string]any
	if err := json.Unmarshal(d["leases"], &leases); err != nil {
		t.Fatal(err)
	}
	if len(leases) != 2 {
		t.Fatalf("want one lease per agent, got %d", len(leases))
	}
	for _, l := range leases {
		if l["kind"] != "file" || l["provider"] != "claude_code" || len(l["globs"].([]any)) != 1 {
			t.Errorf("lease row %v", l)
		}
	}
	var writers map[string][]map[string]any
	if err := json.Unmarshal(d["writers"], &writers); err != nil {
		t.Fatal(err)
	}
	real, _ := filepath.EvalSymlinks(repo)
	if got := len(writers[filepath.Join(real, "a.txt")]); got != 2 {
		t.Errorf("want both agents as writers, got %d (%v)", got, writers)
	}
}

func TestApplyPatchPaths(t *testing.T) {
	patch := "*** Begin Patch\n*** Update File: /x/a.go\n@@\n*** Add File: /x/b.go\n*** Delete File: /x/c.go\n" +
		"*** Update File: /x/d.go\n*** Move to: /x/e.go\n*** End Patch\n"
	got := EditPaths(map[string]any{"tool_name": "apply_patch", "tool_input": map[string]any{"command": patch}})
	want := "/x/a.go /x/b.go /x/c.go /x/d.go /x/e.go"
	if strings.Join(got, " ") != want {
		t.Errorf("paths %v, want %s", got, want)
	}
}

func TestShellWritesJoinTheWriterSet(t *testing.T) {
	repo := sandbox(t)
	sid := "33333333-aaaa-4bbb-8ccc-000000000003"
	call := map[string]any{"session_id": sid, "tool_use_id": "t1", "tool_name": "Bash", "cwd": repo,
		"tool_input": map[string]any{"command": "echo hi > made.txt"}}
	raw, _ := json.Marshal(call)
	h := New(testConfig(), call)
	h.BashPre(raw)
	if err := os.WriteFile(filepath.Join(repo, "made.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if line := New(testConfig(), call).BashPost(); line != "" {
		t.Errorf("a lone shell has nothing to warn about: %q", line)
	}
	var writers map[string][]map[string]any
	if err := json.Unmarshal(storeDoc(t, "demo")["writers"], &writers); err != nil {
		t.Fatal(err)
	}
	real, _ := filepath.EvalSymlinks(repo)
	if got := writers[filepath.Join(real, "made.txt")]; len(got) != 1 || got[0]["agent_id"] != "cc:333333" {
		t.Errorf("shell write not recorded: %v", writers)
	}
}

func TestFnmatchFollowsPython(t *testing.T) {
	for _, c := range []struct {
		name, pat string
		want      bool
	}{
		{"/r/a/b.py", "/r/*.py", true}, // fnmatch's * crosses /
		{"/r/a.py", "/r/?.py", true},
		{"/r/ab.py", "/r/?.py", false},
		{"/r/x", "/r/[!a]", true},
		{"/r/a", "/r/[!a]", false},
		{"/r/[", "/r/[", true},
		{"/r/a.PY", "/r/*.py", false},
	} {
		if got := fnmatch(c.name, c.pat); got != c.want {
			t.Errorf("fnmatch(%q, %q) = %v", c.name, c.pat, got)
		}
	}
}

func TestShlexFollowsPython(t *testing.T) {
	for in, want := range map[string]string{
		`gh api repos/x -X PATCH`:       `gh api repos/x -X PATCH`,
		`cd /x && gh pr list # gh repo`: `cd /x '&&' gh pr list`, // shlex.join quotes punctuation
		`a|b;c`:                         `a '|' b ';' c`,
		`echo "a b" 'c d'`:              `echo 'a b' 'c d'`,
		"x=1 gh\nrepo":                  "x=1 gh '\n' repo",
	} {
		argv, ok := shlexSplit(in)
		if !ok || shlexJoin(argv) != want {
			t.Errorf("shlexSplit(%q) = %q, want %q", in, shlexJoin(argv), want)
		}
	}
	if _, ok := shlexSplit(`echo "open`); ok {
		t.Error("an unterminated quote is an error, as in Python")
	}
}

func TestShortID(t *testing.T) {
	for in, want := range map[string]string{
		"019a1b2c-3d4e-7f00-8abc-def012345678": "345678",
		"aico-root-abcdef123":                  "abcdef",
		"abc":                                  "abc",
	} {
		if got := ShortID(in); got != want {
			t.Errorf("ShortID(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestStoreReadableBySummitFlow: SummitFlow's st lease keeps reading this store until M10a. Skipped where the
// SummitFlow checkout is absent (set AICO_HOOK_SF to its backend directory to point elsewhere).
func TestStoreReadableBySummitFlow(t *testing.T) {
	backend := os.Getenv("AICO_HOOK_SF")
	if backend == "" {
		backend = "/srv/workspaces/projects/summitflow/backend"
	}
	py := filepath.Join(backend, ".venv/bin/python")
	if _, err := os.Stat(py); err != nil {
		t.Skip("SummitFlow backend not present")
	}
	repo := sandbox(t)
	file := filepath.Join(repo, "a.txt")
	New(testConfig(), edit("44444444-aaaa-4bbb-8ccc-000000000004", file)).Edit()
	New(testConfig(), edit("55555555-aaaa-4bbb-8ccc-000000000005", file)).Edit()
	code := `import sys; sys.path.insert(0, sys.argv[1])
from cli.lib import leases
print(" ".join(sorted(l.agent_id for l in leases.list_active("demo"))))
print(len(leases.writers("demo").get(sys.argv[2], [])))`
	real, _ := filepath.EvalSymlinks(repo)
	cmd := exec.Command(py, "-I", "-c", code, backend, filepath.Join(real, "a.txt"))
	cmd.Env = append(os.Environ(), "ST_LEASES_DIR="+os.Getenv("ST_LEASES_DIR"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("SummitFlow could not read the store: %v\n%s", err, out)
	}
	if got := strings.Fields(string(out)); len(got) != 3 || got[0] != "cc:444444" || got[1] != "cc:555555" || got[2] != "2" {
		t.Errorf("SummitFlow sees %q", out)
	}
}

// A missing or zero idle TTL falls back to 30 minutes: it used to make every lease stale, so the next save
// deleted other agents' leases.
func TestZeroIdleTTLKeepsOtherAgentsLeases(t *testing.T) {
	a, b := "11111111-aaaa-4bbb-8ccc-000000000001", "22222222-aaaa-4bbb-8ccc-000000000002"
	for _, ttl := range []int{0, -5} {
		t.Run(fmt.Sprint(ttl), func(t *testing.T) {
			file := filepath.Join(sandbox(t), "a.txt")
			cfg := testConfig()
			cfg.IdleTTLMinutes = ttl
			New(cfg, edit(a, file)).Edit()
			blocked, text := New(cfg, edit(b, file)).Edit()
			if blocked || !strings.Contains(text, "WARNING: ") {
				t.Errorf("b must see a's lease, got blocked=%v %q", blocked, text)
			}
			var leases []map[string]any
			if err := json.Unmarshal(storeDoc(t, "demo")["leases"], &leases); err != nil {
				t.Fatal(err)
			}
			if len(leases) != 2 {
				t.Errorf("want a's and b's leases kept, got %d", len(leases))
			}
		})
	}
	if got := (Config{}).withDefaults(); got.IdleTTLMinutes != 30 || got.RegistryHours != 24 || got.NoteHours != 24 {
		t.Fatalf("defaults %+v", got)
	}
}
