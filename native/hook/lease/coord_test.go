package lease

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	sidA = "11111111-aaaa-4bbb-8ccc-000000000001" // agent cc:111111
	sidB = "22222222-aaaa-4bbb-8ccc-000000000002" // agent cc:222222
)

func agent(sid, event string) *Hook {
	h := New(testConfig(), map[string]any{"session_id": sid, "hook_event_name": event})
	h.ID.Anchor = "" // the test process is no agent's harness: ownership goes by id alone
	return h
}

func ledgerRows(t *testing.T) []map[string]any {
	t.Helper()
	var rows []map[string]any
	_ = json.Unmarshal(fake.Doc("_coord")["messages"], &rows)
	return rows
}

// ---------------------------------------------------------------- leases

func TestIdleLeaseIsReleased(t *testing.T) {
	repo := sandbox(t)
	file := filepath.Join(repo, "a.txt")
	New(testConfig(), edit(sidA, file)).Edit()
	var doc map[string]any
	raw, _ := json.Marshal(fake.Doc("demo"))
	_ = json.Unmarshal(raw, &doc)
	old := stamp(time.Now().Add(-31 * time.Minute))
	for _, l := range doc["leases"].([]any) {
		l.(map[string]any)["last_heartbeat"] = old
	}
	fake.Put("demo", doc)
	blocked, text := New(testConfig(), edit(sidB, file)).Edit()
	if blocked || text != "" {
		t.Fatalf("a lease idle for 31 minutes must not warn: blocked=%v %q", blocked, text)
	}
}

func TestHoldsBelongToTheTakingSession(t *testing.T) {
	repo := sandbox(t)
	a, b := agent(sidA, ""), agent(sidB, "")
	b.ID.AgentID = a.ID.AgentID // builders can inherit the coordinator's label
	first, _ := a.Hold("demo", repo, "first")
	second, _ := b.Hold("demo", repo, "second")
	marks, _ := a.Listed("demo", "hold")
	if len(marks) != 2 {
		t.Fatalf("a builder replaced another session's hold: %v", marks)
	}
	if n, _ := b.Release("demo", repo, first.LeaseID, false); n != 0 {
		t.Fatal("released another session's hold")
	}
	if n, _ := a.Release("demo", repo, first.LeaseID, false); n != 1 {
		t.Fatal("cannot release own hold by id")
	}
	if n, _ := a.Release("demo", repo, "", true); n != 0 {
		t.Fatal("release-all released another session's hold")
	}
	if n, _ := b.Release("demo", repo, second.LeaseID, false); n != 1 {
		t.Fatal("cannot release remaining hold")
	}
}

func TestSharedSessionCanReleaseOneOfItsHolds(t *testing.T) {
	repo := sandbox(t)
	a := agent(sidA, "")
	first, _ := a.Hold("demo", repo, "builder one")
	second, _ := a.Hold("demo", repo, "builder two")
	if n, _ := a.Release("demo", repo, first.LeaseID, false); n != 1 {
		t.Fatal("first hold was overwritten by the second")
	}
	live, _ := a.Listed("demo", "hold")
	if len(live) != 1 || !strings.Contains(live[0], "builder two") {
		t.Fatalf("other hold lost: %v", live)
	}
	if n, _ := a.Release("demo", repo, second.LeaseID, false); n != 1 {
		t.Fatal("remaining hold lost")
	}
}

func TestChildNoticeOnlyFlagsTheLaunchersVanishedChildren(t *testing.T) {
	items := vanishedChildren([]map[string]any{
		{"id": "one", "parent": "root", "title": "Builder", "state": "live"},
		{"id": "two", "parent": "root", "title": "Reviewer", "state": "vanished"},
		{"id": "three", "parent": "other", "state": "vanished"},
	}, "root")
	if len(items) != 1 || !strings.Contains(items[0].Line, "Reviewer (two) vanished") {
		t.Fatalf("%v", items)
	}
}

func TestLeaseVerbs(t *testing.T) {
	repo := sandbox(t)
	real, _ := filepath.EvalSymlinks(repo)
	a, b := agent(sidA, ""), agent(sidB, "")

	l, err := a.Acquire("demo", real, []string{"src/**"}, "T1")
	if err != nil || l.Globs[0] != filepath.Join(real, "src/**") || l.TaskID == nil || *l.TaskID != "T1" {
		t.Fatalf("acquire: %+v %v", l, err)
	}
	again, _ := a.Acquire("demo", real, []string{"src/**"}, "")
	if again.LeaseID != l.LeaseID {
		t.Errorf("the same glob set extends the lease: %s vs %s", again.LeaseID, l.LeaseID)
	}
	lines, _ := b.Listed("demo", "file")
	if len(lines) != 1 || !strings.Contains(lines[0], "cc:111111 · lease:'"+filepath.Join(real, "src/**")+"' · task:T1") {
		t.Fatalf("list: %q", lines)
	}
	if n, _ := b.Release("demo", real, "", true); n != 0 {
		t.Errorf("b released %d of a's leases", n)
	}
	if blocked, text := b.Check(filepath.Join(real, "src", "x.go")); blocked || !strings.Contains(text, "WARNING: ") {
		t.Errorf("check on another's glob: blocked=%v %q", blocked, text)
	}
	if n, _ := b.Release("demo", real, "", true); n != 1 {
		t.Errorf("a check leases the file to b like an edit, got %d", n)
	}

	if _, err := b.Take("demo", real, "src/x.go"); err != nil {
		t.Fatal(err)
	}
	if blocked, text := a.Check(filepath.Join(real, "src", "x.go")); blocked || !strings.Contains(text, "cc:222222") {
		t.Errorf("after take the file is b's: %q", text)
	}
	if n, _ := a.Release("demo", real, "", true); n != 1 {
		t.Errorf("a releases its one lease, got %d", n)
	}
	if n, _ := b.Release("demo", real, "", true); n != 1 {
		t.Errorf("b releases its taken lease, got %d", n)
	}
	if lines, _ := a.Listed("demo", "file"); len(lines) != 0 {
		t.Errorf("leases left: %q", lines)
	}

	h, err := a.Hold("demo", real, "integration")
	if err != nil || h.Kind != "hold" {
		t.Fatalf("hold: %+v %v", h, err)
	}
	if marks, _ := b.Listed("demo", "op", "hold"); len(marks) != 1 {
		t.Errorf("hold not listed: %q", marks)
	}
}

func TestImportLegacy(t *testing.T) {
	sandbox(t)
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("demo.json", `{"leases":[{"lease_id":"x1","agent_id":"cc:999999","globs":["/r/**"],"kind":"file"}],"writers":{}}`)
	write("_coord.json", `{"messages":[{"id":"m1","state":"open"}],"identities":{}}`)
	write("_sweep_refusals.jsonl", "ignored")
	done, err := ImportLegacy(dir)
	if err != nil || len(done) != 2 {
		t.Fatalf("import: %v %v", done, err)
	}
	if string(fake.Doc("demo")["leases"]) == "" || len(ledgerRows(t)) != 1 {
		t.Errorf("documents not carried over: demo=%v ledger=%v", fake.Doc("demo"), ledgerRows(t))
	}
}

func TestImportLegacySeenKeepsShownItemsShown(t *testing.T) {
	sandbox(t)
	dir := t.TempDir()
	now := float64(time.Now().UnixNano()) / 1e9
	body, _ := json.Marshal(map[string]float64{"74c9a2:fyi": now - 60, "old:req": now - 3*86400})
	if err := os.WriteFile(filepath.Join(dir, "cc_111111.seen.json"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	agents, err := ImportLegacySeen(dir)
	if err != nil || len(agents) != 1 || agents[0] != "cc:111111" {
		t.Fatalf("import: %v %v", agents, err)
	}
	keys := seenKeys("cc:111111")
	if len(keys) != 1 || keys[0] != "74c9a2:fyi" {
		t.Errorf("a shown item stays shown and a day-old one is dropped: %v", keys)
	}
}

// ---------------------------------------------------------------- handshakes

func register(t *testing.T, hs ...*Hook) {
	t.Helper()
	for _, h := range hs {
		h.ID.Anchor = "1:2"
		h.Cfg.Observe(h.ID, false, false, false)
	}
}

func TestHandshakeLifecycle(t *testing.T) {
	sandbox(t)
	a, b := agent(sidA, ""), agent(sidB, "")

	long := strings.Repeat("x", MaxText+1)
	if _, _, err := a.Send(SendOpts{To: "cc:222222", Text: long}); err == nil {
		t.Error("a request over the limit must be refused")
	}
	row, dup, err := a.Send(SendOpts{To: "cc:222222", Text: "please review  the lease change", Project: "demo", SourceKey: "k1"})
	if err != nil || dup || row["state"] != "open" || row["text"] != "please review the lease change" {
		t.Fatalf("send: %v dup=%v err=%v", row, dup, err)
	}
	id := row["id"].(string)
	if again, dup, _ := a.Send(SendOpts{To: "cc:222222", Text: "other", SourceKey: "k1"}); !dup || again["id"] != id {
		t.Errorf("same source key must not send twice: %v", again)
	}
	if _, dup, _ := a.Send(SendOpts{To: "cc:222222", Text: "please review the lease change"}); !dup {
		t.Error("same open text must not send twice")
	}

	if len(b.Inbox()) != 1 || len(a.Inbox()) != 1 {
		t.Fatalf("both sides list the open request: b=%d a=%d", len(b.Inbox()), len(a.Inbox()))
	}
	if _, err := a.Ack(id, "yes", ""); err == nil {
		t.Error("only the recipient may ack")
	}
	if _, err := b.Ack(id, "no", ""); err == nil {
		t.Error("a no needs a reason")
	}
	if _, err := b.Ack(id, "soon", ""); err == nil {
		t.Error("bad intent")
	}
	if r, err := b.Ack(id, "eta:15", "after lunch"); err != nil || r["intent"] != "eta" || r["eta_min"] != 15 {
		t.Fatalf("eta ack: %v %v", r, err)
	}
	if r, err := b.Ack(id, "yes", "done"); err != nil || r["state"] != "acked" || r["note"] != "done" {
		t.Fatalf("yes ack: %v %v", r, err)
	}
	if _, err := b.Confirm(id, false); err == nil {
		t.Error("only the sender may confirm")
	}
	if _, err := a.Confirm(id, true); err == nil {
		t.Error("an acked request cannot be withdrawn")
	}
	if r, err := a.Confirm(id, false); err != nil || r["state"] != "closed" {
		t.Fatalf("confirm: %v %v", r, err)
	}
	if _, err := b.Ack(id, "yes", ""); err == nil {
		t.Error("a closed request takes no ack")
	}
	if _, err := a.Confirm("nope00", false); err == nil {
		t.Error("unknown id")
	}
}

func TestWithdrawAndFYI(t *testing.T) {
	sandbox(t)
	a, b := agent(sidA, ""), agent(sidB, "")
	row, _, _ := a.Send(SendOpts{To: "cc:222222", Text: "never mind soon"})
	if r, err := a.Confirm(row["id"].(string), true); err != nil || r["state"] != "closed" || r["withdrawn"] != true {
		t.Fatalf("withdraw: %v %v", r, err)
	}
	note, _, _ := a.Send(SendOpts{To: "cc:222222", Text: "build is green", FYI: true})
	if note["state"] != "fyi" {
		t.Fatalf("fyi row: %v", note)
	}
	if _, err := b.Ack(note["id"].(string), "yes", ""); err == nil {
		t.Error("an FYI takes no ack")
	}
	if _, err := a.Confirm(note["id"].(string), false); err == nil {
		t.Error("an FYI takes no confirm")
	}
	items := b.Pending()
	if len(items) != 1 || !items[0].Ride || !strings.Contains(items[0].Line, "FYI "+note["id"].(string)) {
		t.Fatalf("fyi item: %+v", items)
	}
}

func TestBareYesClosesWithoutConfirm(t *testing.T) {
	sandbox(t)
	a, b := agent(sidA, ""), agent(sidB, "")
	row, _, _ := a.Send(SendOpts{To: "cc:222222", Text: "ok to proceed"})
	id := row["id"].(string)
	acked, _ := b.Ack(id, "yes", "")
	settled := b.SettleBareAck(acked)
	if settled["state"] != "closed" || settled["auto_closed"] != true {
		t.Fatalf("a bare yes closes for the sender: %v", settled)
	}
	items := a.Pending()
	if len(items) != 1 || !strings.Contains(items[0].Line, "closed; nothing to do") {
		t.Errorf("the sender is told once: %+v", items)
	}

	row2, _, _ := a.Send(SendOpts{To: "cc:222222", Text: "second question"})
	acked2, _ := b.Ack(row2["id"].(string), "yes", "watch the lock")
	if got := b.SettleBareAck(acked2); got["state"] != "acked" {
		t.Errorf("a noted yes stays for the sender to confirm: %v", got)
	}
}

// ---------------------------------------------------------------- inbox hook

func TestInboxHookShowsAndRemindsRequests(t *testing.T) {
	sandbox(t)
	a := agent(sidA, "UserPromptSubmit")
	row, _, _ := a.Send(SendOpts{To: "cc:222222", Text: "urgent: check the deploy"})
	id := row["id"].(string)

	b := agent(sidB, "UserPromptSubmit")
	ctx, block := b.InboxHook("turn", "claude_code")
	if block != "" || !strings.Contains(ctx, "REQUEST "+id+" from cc:111111") || !strings.Contains(ctx, "st sessions ack "+id) {
		t.Fatalf("turn: ctx=%q block=%q", ctx, block)
	}
	if ctx2, _ := agent(sidB, "UserPromptSubmit").InboxHook("turn", "claude_code"); ctx2 != "" {
		t.Errorf("a request shows again only after the reminder interval: %q", ctx2)
	}

	// Stop: a waiting requester justifies continuing, once it is due again.
	d := map[string]any{"cc:222222": map[string]any{id + ":req": float64(1)}}
	fake.Put("_seen", d)
	_, block = agent(sidB, "Stop").InboxHook("stop", "claude_code")
	if !strings.Contains(block, "REQUEST "+id) {
		t.Errorf("stop must continue the turn for a waiting request: %q", block)
	}

	// After the ack the sender is shown it once.
	if _, err := b.Ack(id, "yes", "on it"); err != nil {
		t.Fatal(err)
	}
	ctx, _ = agent(sidA, "UserPromptSubmit").InboxHook("turn", "claude_code")
	if !strings.Contains(ctx, "ACK "+id+" yes (on it) from cc:222222") {
		t.Errorf("ack not shown to the sender: %q", ctx)
	}
	if ctx, _ = agent(sidA, "UserPromptSubmit").InboxHook("turn", "claude_code"); ctx != "" {
		t.Errorf("an ack shows once: %q", ctx)
	}
}

func TestInboxHookSilentAndExtra(t *testing.T) {
	sandbox(t)
	h := agent(sidB, "UserPromptSubmit")
	if ctx, block := h.InboxHook("turn", "claude_code"); ctx != "" || block != "" {
		t.Errorf("an empty inbox is silent: %q %q", ctx, block)
	}
	h = agent(sidB, "UserPromptSubmit")
	h.Extra = func(string) string { return "Memory notice" }
	if ctx, _ := h.InboxHook("turn", "claude_code"); ctx != "Memory notice" {
		t.Errorf("extra text rides the turn: %q", ctx)
	}
	sub := New(testConfig(), map[string]any{"session_id": sidB, "hook_event_name": "PostToolUse", "agent_id": "sub1"})
	sub.Extra = func(string) string { t.Error("a Claude subagent's tool call asks nothing"); return "" }
	sub.InboxHook("turn", "claude_code")
}

func TestComposeLine(t *testing.T) {
	sandbox(t)
	a := agent(sidA, "")
	a.Send(SendOpts{To: "cc:222222", Text: "first"})
	a.Send(SendOpts{To: "cc:222222", Text: "second"})
	a.Send(SendOpts{To: "cc:222222", Text: "a note", FYI: true})
	tg := &Target{Widget: "abcd1234", AgentID: "cc:222222", Family: map[string]bool{"cc:222222": true}}
	line, ride, ok := a.Compose(tg, nil)
	if !ok || ride || !strings.HasPrefix(line, "[Message] 2 requests from cc:111111") || !strings.HasSuffix(line, "st sessions inbox") {
		t.Errorf("line %q ride=%v ok=%v", line, ride, ok)
	}
	if _, _, ok := a.Compose(&Target{Widget: "abcd1234", AgentID: "cc:333333", Family: map[string]bool{"cc:333333": true}}, nil); ok {
		t.Error("nothing waits for a third agent")
	}
}

// The Tether adapters' hooks.rideAlong must agree with takesRide; both tests read this fixture.
func TestTakesRideMatchesFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../contracts/ride-along-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Events []string            `json:"events"`
		Takes  map[string][]string `json:"takes"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	for provider, want := range fx.Takes {
		got := []string{}
		for _, event := range fx.Events {
			if takesRide(provider, event, "") {
				got = append(got, event)
			}
		}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s: takesRide events %v, fixture %v", provider, got, want)
		}
		if takesRide(provider, "UserPromptSubmit", "a1") {
			t.Errorf("%s: a subagent took a ride-along line", provider)
		}
	}
}
