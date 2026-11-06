package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// memFixture is a pane cgroup with a kill counter and an events file the tests fill.
func memFixture(t *testing.T) (memPaths, func(kills int)) {
	t.Helper()
	tmp := t.TempDir()
	scope := "tmux-spawn-abc.scope"
	cg := filepath.Join(tmp, "cg", "user.slice", scope)
	if err := os.MkdirAll(cg, 0o755); err != nil {
		t.Fatal(err)
	}
	proc := filepath.Join(tmp, "cgroup")
	if err := os.WriteFile(proc, []byte("0::/user.slice/"+scope+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	events := filepath.Join(tmp, "events.jsonl")
	if err := os.WriteFile(events, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	setKills := func(n int) {
		body := "low 0\noom_kill " + strconv.Itoa(n) + "\n"
		if err := os.WriteFile(filepath.Join(cg, "memory.events"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	setKills(0)
	return memPaths{
		stateDir: filepath.Join(tmp, "state"), procCgroup: proc, cgroupRoot: filepath.Join(tmp, "cg"),
		events: events, heartbeat: filepath.Join(tmp, "none"),
	}, setKills
}

func TestMemoryCheckTellsEachKillOnce(t *testing.T) {
	now := time.Now()
	rec := `{"v":1,"ts":` + itoa(now.Unix()+1) + `,"kind":"kill","killer":"kernel-pane-cap","scope":"tmux-spawn-abc.scope","pid":42,"comm":"chrome","bytes":3221225472,"count":1}`
	other := `{"v":1,"ts":` + itoa(now.Unix()+1) + `,"kind":"kill","killer":"kernel-pane-cap","scope":"tmux-spawn-zzz.scope","pid":43,"comm":"firefox","bytes":1073741824,"count":1}`
	p, setKills := memFixture(t)

	if text, ok := memoryCheck("cc_a", false, p, now); ok {
		t.Fatalf("a new agent heard old news: %q", text)
	}
	setKills(1)
	if err := os.WriteFile(p.events, []byte("{}\n"+other+"\n"+rec+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	text, ok := memoryCheck("cc_a", false, p, now.Add(2*time.Second))
	if !ok || !strings.Contains(text, "the kernel killed chrome (pid 42), 3.0 GiB; this pane reached its memory limit.") {
		t.Fatalf("kill not told: %q", text)
	}
	if strings.Contains(text, "firefox") {
		t.Fatalf("another pane's kill was told: %q", text)
	}
	if !strings.Contains(text, "exit 137") {
		t.Fatalf("missing the early-exit hint: %q", text)
	}
	if text, ok := memoryCheck("cc_a", false, p, now.Add(3*time.Second)); ok {
		t.Fatalf("told twice: %q", text)
	}
	// Another agent in the same pane starts from what is there now.
	if text, ok := memoryCheck("cc_b", false, p, now.Add(4*time.Second)); ok {
		t.Fatalf("second agent heard the first's news: %q", text)
	}
}

func TestMemoryCheckCounterOnlyAndOutsidePane(t *testing.T) {
	now := time.Now()
	p, setKills := memFixture(t)
	memoryCheck("cc_a", false, p, now)
	setKills(2)
	text, ok := memoryCheck("cc_a", false, p, now.Add(time.Second))
	if !ok || !strings.Contains(text, "the kernel killed 2 processes in this pane for memory; memctl is not running") {
		t.Fatalf("counter-only notice: %q", text)
	}
	p.procCgroup = filepath.Join(t.TempDir(), "missing")
	if _, ok := memoryCheck("cc_a", false, p, now); ok {
		t.Fatal("a notice outside an agent pane")
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestMemoryCheckResumedHearsEarlierPaneOfItsSession(t *testing.T) {
	now := time.Now()
	p, _ := memFixture(t)
	old := itoa(now.Unix() - 600)
	lines := `{"v":1,"ts":` + old + `,"kind":"kill","killer":"kernel-pane-cap","scope":"tmux-spawn-old.scope","tether_session_id":"s1","pid":7,"comm":"node","bytes":2147483648,"count":1}` + "\n" +
		`{"v":1,"ts":` + old + `,"kind":"warning","killer":null,"scope":"tmux-spawn-abc.scope","tether_session_id":"s1","pid":8,"comm":"cc","class":"agent","bytes":1073741824}` + "\n" +
		`{"v":1,"ts":` + old + `,"kind":"kill","killer":"kernel-pane-cap","scope":"tmux-spawn-elsewhere.scope","tether_session_id":"s2","pid":9,"comm":"python","bytes":1073741824,"count":1}` + "\n"
	if err := os.WriteFile(p.events, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	text, ok := memoryCheck("cc_a", true, p, now)
	if !ok || !strings.Contains(text, "node (pid 7)") || !strings.Contains(text, "the pane this session ran in before") {
		t.Fatalf("earlier pane not told on resume: %q", text)
	}
	if strings.Contains(text, "python") {
		t.Fatalf("another session's kill was told: %q", text)
	}
}
