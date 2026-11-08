package lease

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
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(tmp, "run"))
	fake = testtether.Start(t, filepath.Join(tmp, "tether"))
	SetBudget(time.Now(), 0)
	t.Setenv("ST_COORD_ANCHOR", "")
	t.Setenv("ST_COORD_HARNESS", "")
	t.Setenv("ST_COORD_SENSITIVE", "")
	for _, k := range append([]string{"ST_SESSION_ID", "TMUX", "TMUX_PANE"}, identityEnv...) {
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

// fake is this test's Tether (coordination documents in memory).
var fake *testtether.Server

func storeDoc(t *testing.T, project string) map[string]json.RawMessage {
	t.Helper()
	d := fake.Doc(project)
	if d == nil {
		t.Fatalf("no %s document in the store", project)
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

func TestConcurrentShellCreationsKeepTheirWriters(t *testing.T) {
	repo := sandbox(t)
	a, b := "33333333-aaaa-4bbb-8ccc-000000000003", "44444444-aaaa-4bbb-8ccc-000000000004"
	call := func(sid, file string) map[string]any {
		return map[string]any{"session_id": sid, "tool_use_id": "shell", "tool_name": "Bash", "cwd": repo,
			"tool_input": map[string]any{"command": "cat > '" + file + "' <<'EOF'\nnew file\nEOF"}}
	}
	ha, hb := New(testConfig(), call(a, "mine.txt")), New(testConfig(), call(b, "their file.txt"))
	for _, h := range []*Hook{ha, hb} {
		raw, _ := json.Marshal(h.Payload)
		h.BashPre(raw)
	}
	for _, file := range []string{"mine.txt", "their file.txt"} {
		if err := os.WriteFile(filepath.Join(repo, file), []byte("new file\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ha.BashPost()
	hb.BashPost()
	for _, pair := range []struct {
		h    *Hook
		file string
	}{{ha, "mine.txt"}, {hb, "their file.txt"}} {
		path := realPath(filepath.Join(repo, pair.file))
		foreign, err := pair.h.Foreign("demo", []string{path})
		if err != nil || len(foreign[path]) != 0 {
			t.Errorf("own shell creation must be fixable: %s: %v (%v)", pair.file, foreign, err)
		}
	}
}

func TestShellOutputPathsAreLiteral(t *testing.T) {
	for _, tc := range []struct{ command, want string }{
		{`echo 'quoted > fake' > made.txt`, "/repo/made.txt"},
		{`printf hi>>"with space.txt"`, "/repo/with space.txt"},
		{"cat <<'EOF' > made.txt\n> fake\nEOF", "/repo/made.txt"},
		{`echo hi # > fake`, ""},
		{`[[ a > fake ]]`, ""},
		{`echo hi > file#part`, ""},
		{`echo hi > "$DEST"`, ""},
		{`cd somewhere && echo hi > fake`, ""},
		{`echo hi 2>&1`, ""},
	} {
		payload := map[string]any{"tool_input": map[string]any{"command": tc.command}}
		if got := strings.Join(shellOutputs(payload, "/repo"), " "); got != tc.want {
			t.Errorf("shellOutputs(%q) = %q, want %q", tc.command, got, tc.want)
		}
	}
}

func TestConcurrentIndirectShellWritesRemainUnknown(t *testing.T) {
	repo := sandbox(t)
	call := func(sid string) *Hook {
		h := New(testConfig(), map[string]any{"session_id": sid, "tool_use_id": "shell", "tool_name": "exec_command", "cwd": "/tmp",
			"tool_input": map[string]any{"cmd": "python make_files.py", "workdir": repo}})
		raw, _ := json.Marshal(h.Payload)
		h.BashPre(raw)
		return h
	}
	ha := call("33333333-aaaa-4bbb-8ccc-000000000003")
	call("44444444-aaaa-4bbb-8ccc-000000000004")
	path := filepath.Join(repo, "uncertain.txt")
	if err := os.WriteFile(path, []byte("ambiguous\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ha.BashPost()
	foreign, err := ha.Foreign("demo", []string{realPath(path)})
	if err != nil || strings.Join(foreign[realPath(path)], ",") != "unknown" {
		t.Fatalf("indirect concurrent write must stay unknown: %v (%v)", foreign, err)
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

func TestGateCommandsTakeNoShellSnapshot(t *testing.T) {
	gate := []string{
		`st check --quick --changed-only`,
		`cd /x && st commit -m "Fix (the) thing; again > twice" --paths a.ts b.ts`,
		`ST_CHECK_CHANGED_FILES=a.ts time st check --quick 2>&1 | tail -20`,
		`aico check --fix | grep FAIL`,
	}
	other := []string{
		`st check --quick && echo hi > made.txt`,
		`st check --quick > out.txt`,
		`st commit -m x; rm a.ts`,
		`st checkout main`,
		`npm run lint`,
		`st done t-1`,
	}
	for _, c := range gate {
		if !gateCommand(map[string]any{"tool_input": map[string]any{"command": c}}) {
			t.Errorf("gate run not recognised: %s", c)
		}
	}
	for _, c := range other {
		if gateCommand(map[string]any{"tool_input": map[string]any{"cmd": c}}) {
			t.Errorf("not only a gate run: %s", c)
		}
	}
}

func TestForeignWritersAndCommittedPaths(t *testing.T) {
	repo := sandbox(t)
	real, _ := filepath.EvalSymlinks(repo)
	mine, theirs := filepath.Join(real, "mine.txt"), filepath.Join(real, "theirs.txt")
	a, b := "44444444-aaaa-4bbb-8ccc-000000000004", "55555555-aaaa-4bbb-8ccc-000000000005"
	New(testConfig(), edit(a, mine)).Edit()
	New(testConfig(), edit(b, theirs)).Edit()

	h := New(testConfig(), map[string]any{"session_id": a})
	got, err := h.Foreign("demo", []string{mine, theirs})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || strings.Join(got[theirs], ",") != "cc:555555,lease:cc:555555" {
		t.Errorf("foreign writers %v, want only theirs.txt by cc:555555 (writer and lease)", got)
	}
	n, err := h.Committed("demo", []string{mine})
	if err != nil || n != 1 {
		t.Fatalf("committed released %d (%v), want 1", n, err)
	}
	var leases []map[string]any
	var writers map[string][]map[string]any
	d := storeDoc(t, "demo")
	_ = json.Unmarshal(d["leases"], &leases)
	_ = json.Unmarshal(d["writers"], &writers)
	if len(leases) != 1 || leases[0]["agent_id"] != "cc:555555" {
		t.Errorf("only the other agent's lease should stay: %v", leases)
	}
	if _, ok := writers[mine]; ok || len(writers[theirs]) != 1 {
		t.Errorf("committed path's writer set should go, the other stays: %v", writers)
	}
}

func TestGuardRefusesAnotherAgentsHold(t *testing.T) {
	repo := sandbox(t)
	a, b := "66666666-aaaa-4bbb-8ccc-000000000006", "77777777-aaaa-4bbb-8ccc-000000000007"
	holder := New(testConfig(), map[string]any{"session_id": b})
	if _, err := holder.Hold("demo", repo, "integration"); err != nil {
		t.Fatal(err)
	}
	if line, err := holder.Guard("demo", repo, "commit", ""); err != nil || line != "" {
		t.Errorf("own hold should not refuse: %q %v", line, err)
	}
	other := New(testConfig(), map[string]any{"session_id": a})
	for _, op := range []string{"commit", "acceptance"} {
		line, err := other.Guard("demo", repo, op, "")
		if err != nil || !strings.Contains(line, op+" refused") || !strings.Contains(line, "cc:777777") {
			t.Errorf("%s under another agent's hold: %q %v", op, line, err)
		}
	}
}

func TestWritersYesHandsOverTheirPaths(t *testing.T) {
	repo := sandbox(t)
	real, _ := filepath.EvalSymlinks(repo)
	theirs := filepath.Join(real, "theirs.txt")
	New(testConfig(), edit(sidB, theirs)).Edit()
	a, b := agent(sidA, ""), agent(sidB, "")
	register(t, a, b)
	found, err := a.Foreign("demo", []string{theirs})
	if err != nil || len(found[theirs]) == 0 {
		t.Fatalf("the other agent's write must show: %v (%v)", found, err)
	}
	row, _, err := a.Send(SendOpts{To: "cc:222222", Text: "may I commit theirs.txt?"})
	if err != nil {
		t.Fatal(err)
	}
	id := row["id"].(string)
	if got := a.ExceptAcked(found, id, "demo"); len(got[theirs]) == 0 {
		t.Errorf("an open request hands nothing over: %v", got)
	}
	if _, err := b.Ack(id, "yes", ""); err != nil {
		t.Fatal(err)
	}
	if got := a.ExceptAcked(found, id, "demo"); len(got[theirs]) != 0 {
		t.Errorf("the writer's yes hands its path over: %v", got)
	}
	if got := b.ExceptAcked(found, id, "demo"); len(got[theirs]) == 0 {
		t.Errorf("only the requester may use the yes: %v", got)
	}
}
