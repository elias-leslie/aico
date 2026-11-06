package lease

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Another process saves the document between this writer's read and its write: the write is refused, redone on
// a fresh read, and both changes are kept.
func TestConcurrentWriterLosesNothing(t *testing.T) {
	repo := sandbox(t)
	real, _ := filepath.EvalSymlinks(repo)
	b := agent(sidB, "")
	if _, err := b.Acquire("demo", real, []string{"b.txt"}); err != nil {
		t.Fatal(err)
	}
	once := true
	fake.BeforePut = func(name string) {
		if name != "demo" || !once {
			return
		}
		once = false
		var doc map[string]any
		raw, _ := json.Marshal(fake.Doc("demo"))
		_ = json.Unmarshal(raw, &doc)
		other := map[string]any{"lease_id": "other001", "agent_id": "codex:999999", "agent_slug": "codex",
			"session_id": "s", "provider": "codex_cli", "globs": []string{filepath.Join(real, "c.txt")}, "task_id": nil,
			"acquired_at": stamp(time.Now()), "last_heartbeat": stamp(time.Now()), "kind": "file"}
		doc["leases"] = append(doc["leases"].([]any), other)
		fake.Put("demo", doc)
	}
	if _, err := agent(sidA, "").Acquire("demo", real, []string{"a.txt"}); err != nil {
		t.Fatal(err)
	}
	if fake.Conflicts != 1 {
		t.Fatalf("want one refused write, got %d", fake.Conflicts)
	}
	var leases []Lease
	_ = json.Unmarshal(storeDoc(t, "demo")["leases"], &leases)
	got := map[string]bool{}
	for _, l := range leases {
		got[l.AgentID] = true
	}
	for _, want := range []string{"cc:111111", "cc:222222", "codex:999999"} {
		if !got[want] {
			t.Errorf("lease of %s lost: %+v", want, leases)
		}
	}
}

// A store that does not answer is never read as empty: nothing is written over it, and the edit warns.
// Many writers on one document: a change that keeps losing the race is redone well past a handful of tries
// (live, 30 concurrent edit hooks lost 9 leases to a 5-try limit).
func TestManyLostRacesStillLand(t *testing.T) {
	repo := sandbox(t)
	real, _ := filepath.EvalSymlinks(repo)
	lost := 0
	fake.BeforePut = func(name string) {
		if name == "demo" && lost < 12 {
			lost++
			fake.Put("demo", fake.Doc("demo"))
		}
	}
	if _, err := agent(sidA, "").Acquire("demo", real, []string{"a.txt"}); err != nil {
		t.Fatal(err)
	}
	if fake.Conflicts != 12 {
		t.Fatalf("want 12 refused writes, got %d", fake.Conflicts)
	}
	var leases []Lease
	_ = json.Unmarshal(storeDoc(t, "demo")["leases"], &leases)
	if len(leases) != 1 || leases[0].AgentID != "cc:111111" {
		t.Fatalf("lease lost: %+v", leases)
	}
}

func TestEditWithStoreDownWarnsAndWritesNothing(t *testing.T) {
	repo := sandbox(t)
	file := filepath.Join(repo, "a.txt")
	t.Setenv("TETHER_SOCKET", filepath.Join(t.TempDir(), "gone.sock"))
	blocked, text := New(testConfig(), edit(sidA, file)).Edit()
	if blocked || !strings.Contains(text, "coordination store unavailable") || !strings.Contains(text, file) {
		t.Fatalf("want an unleased warning naming the file: blocked=%v %q", blocked, text)
	}
	if Unavailable() == nil {
		t.Fatal("the failed call must mark the store down for the rest of the call")
	}
}

// A hung Tether (accepts, never answers) costs one hook call its budget once, not once per store call.
func TestHungStoreCostsOneBudget(t *testing.T) {
	repo := sandbox(t)
	file := filepath.Join(repo, "a.txt")
	dir, err := os.MkdirTemp("/tmp", "hung")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "control.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	var held []net.Conn
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			held = append(held, c) // read nothing, answer nothing
		}
	}()
	t.Setenv("TETHER_SOCKET", sock)
	start := time.Now()
	SetBudget(start, 300*time.Millisecond)
	defer SetBudget(time.Now(), 0)
	h := New(testConfig(), edit(sidA, file))
	_, text := h.Edit()
	h.InboxHook("turn", "claude_code")
	if took := time.Since(start); took > 900*time.Millisecond {
		t.Fatalf("edit and inbox with a hung store took %v; the budget is 300ms", took)
	}
	if !strings.Contains(text, "coordination store unavailable") {
		t.Fatalf("want an unleased warning: %q", text)
	}
}

// Observe reads the registry and writes it only when something changed.
func TestObserveWritesOnlyOnChange(t *testing.T) {
	sandbox(t)
	h := agent(sidA, "")
	h.ID.Anchor = "1:" + mustStart(t, 1)
	h.ID.Harness = "claude_code"
	h.Cfg.Observe(h.ID, false, false, false)
	if fake.Puts["_coord"] != 1 {
		t.Fatalf("a new identity is saved once, got %d writes", fake.Puts["_coord"])
	}
	for range 3 {
		h.Cfg.Observe(h.ID, false, false, false)
	}
	if fake.Puts["_coord"] != 1 {
		t.Fatalf("a known identity saved moments ago must not be rewritten, got %d writes", fake.Puts["_coord"])
	}
}

func mustStart(t *testing.T, pid int) string {
	t.Helper()
	s, ok := processStart(pid)
	if !ok {
		t.Skip("no /proc start time for pid 1")
	}
	return s
}

// Seen state that cannot be read shows nothing that turn (not every item again), and an item is shown only once
// its seen record is saved.
func TestInboxShowsNothingWithoutSeenState(t *testing.T) {
	sandbox(t)
	a := agent(sidA, "")
	if _, _, err := a.Send(SendOpts{To: "cc:222222", Text: "FYI the build is green", FYI: true}); err != nil {
		t.Fatal(err)
	}
	fake.Put("_seen", map[string]any{"cc:222222": "not a set"}) // readable: unparsable sets are skipped
	b := agent(sidB, "UserPromptSubmit")
	failSeenWrites := func(name string) {
		if name == "_seen" {
			fake.Put("_seen", map[string]any{}) // someone always saves first: the record never lands
		}
	}
	fake.BeforePut = failSeenWrites
	if ctx, _ := b.InboxHook("turn", "claude_code"); ctx != "" {
		t.Fatalf("an item whose seen record failed must not show: %q", ctx)
	}
	fake.BeforePut = nil
	ctx, _ := agent(sidB, "UserPromptSubmit").InboxHook("turn", "claude_code")
	if !strings.Contains(ctx, "FYI") {
		t.Fatalf("once the record saves, the item shows: %q", ctx)
	}
	if ctx, _ := agent(sidB, "UserPromptSubmit").InboxHook("turn", "claude_code"); ctx != "" {
		t.Fatalf("shown once: %q", ctx)
	}
	// Seen state unreadable: nothing, not the whole ledger again.
	fake.Put("_seen", map[string]any{})
	t.Setenv("TETHER_SOCKET", filepath.Join(t.TempDir(), "gone.sock"))
	SetBudget(time.Now(), 0)
	if ctx, _ := agent(sidB, "UserPromptSubmit").InboxHook("turn", "claude_code"); ctx != "" {
		t.Fatalf("unread seen state must show nothing: %q", ctx)
	}
}

// Re-running the legacy import merges rows by id and never drops what the store has.
func TestImportLegacyMergesRows(t *testing.T) {
	sandbox(t)
	dir := t.TempDir()
	now := stamp(time.Now())
	lease := func(id, agent string) map[string]any {
		return map[string]any{"lease_id": id, "agent_id": agent, "agent_slug": "cc", "session_id": "s", "provider": "claude_code",
			"globs": []string{"/x/" + id}, "task_id": nil, "acquired_at": now, "last_heartbeat": now, "kind": "file"}
	}
	write := func(name string, doc any) {
		raw, _ := json.Marshal(doc)
		if err := os.WriteFile(filepath.Join(dir, name+".json"), raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("demo", map[string]any{"leases": []any{lease("old1", "cc:aaaaaa"), lease("both", "cc:old")}})
	write("_coord", map[string]any{"messages": []any{map[string]any{"id": "m1", "state": "open"}},
		"identities": map[string]any{"cc:aaaaaa": map[string]any{"anchor": "old"}}})
	fake.Put("demo", map[string]any{"leases": []any{lease("both", "cc:new"), lease("new1", "cc:bbbbbb")}})
	fake.Put("_coord", map[string]any{"messages": []any{map[string]any{"id": "m2", "state": "acked"}},
		"identities": map[string]any{"cc:aaaaaa": map[string]any{"anchor": "new"}}})
	for range 2 {
		if _, err := ImportLegacy(dir); err != nil {
			t.Fatal(err)
		}
	}
	var leases []map[string]any
	_ = json.Unmarshal(storeDoc(t, "demo")["leases"], &leases)
	ids := map[string]string{}
	for _, l := range leases {
		ids[str(l["lease_id"])] = str(l["agent_id"])
	}
	if len(leases) != 3 || ids["both"] != "cc:new" || ids["new1"] != "cc:bbbbbb" || ids["old1"] != "cc:aaaaaa" {
		t.Fatalf("merged leases: %v", ids)
	}
	var msgs []map[string]any
	_ = json.Unmarshal(fake.Doc("_coord")["messages"], &msgs)
	var idents map[string]map[string]any
	_ = json.Unmarshal(fake.Doc("_coord")["identities"], &idents)
	if len(msgs) != 2 || idents["cc:aaaaaa"]["anchor"] != "new" {
		t.Fatalf("merged ledger: %v %v", msgs, idents)
	}
}
