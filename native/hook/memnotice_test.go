package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// memFixture is a pane cgroup with a kill counter and a fake nightshift printing the given records.
func memFixture(t *testing.T, records string) (memPaths, func(kills int)) {
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
	bin := filepath.Join(tmp, "nightshift")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\ncat <<'EOF'\n"+records+"\nEOF\n"), 0o755); err != nil {
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
		events: events, heartbeat: filepath.Join(tmp, "none"), nightshift: bin, query: 5 * time.Second,
	}, setKills
}

func TestMemoryCheckTellsEachKillOnce(t *testing.T) {
	now := time.Now()
	rec := `[{"v":1,"ts":` + itoa(now.Unix()+1) + `,"kind":"kill","killer":"kernel-pane-cap","scope":"tmux-spawn-abc.scope","pid":42,"comm":"chrome","bytes":3221225472,"count":1}]`
	p, setKills := memFixture(t, rec)

	if text, ok := memoryCheck("cc_a", false, p, now); ok {
		t.Fatalf("a new agent heard old news: %q", text)
	}
	setKills(1)
	if err := os.WriteFile(p.events, []byte("{}\n{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	text, ok := memoryCheck("cc_a", false, p, now.Add(2*time.Second))
	if !ok || !strings.Contains(text, "the kernel killed chrome (pid 42), 3.0 GiB; this pane reached its memory limit.") {
		t.Fatalf("kill not told: %q", text)
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
	p, setKills := memFixture(t, `[]`)
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
