package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"aico/hook/lease"
)

// capture runs fn with stdout and stderr redirected and returns both.
func capture(t *testing.T, fn func() int) (code int, out, errOut string) {
	t.Helper()
	oldOut, oldErr := os.Stdout, os.Stderr
	ro, wo, _ := os.Pipe()
	re, we, _ := os.Pipe()
	os.Stdout, os.Stderr = wo, we
	code = fn()
	os.Stdout, os.Stderr = oldOut, oldErr
	wo.Close()
	we.Close()
	o, _ := io.ReadAll(ro)
	e, _ := io.ReadAll(re)
	return code, string(o), string(e)
}

func as(t *testing.T, session string) { t.Setenv("CLAUDE_CODE_SESSION_ID", session) }

// registered makes a session a known agent the way its first turn does.
func registered(t *testing.T, session string) {
	t.Helper()
	as(t, session)
	t.Setenv("ST_COORD_ANCHOR", "1:2")
	t.Setenv("ST_COORD_HARNESS", "claude-code")
	stdin(t, `{"hook_event_name":"UserPromptSubmit","session_id":"`+session+`","prompt":"hi"}`)
	capture(t, func() int { return coordMain("inbox", []string{"turn"}) })
	t.Setenv("ST_COORD_ANCHOR", "")
	t.Setenv("ST_COORD_HARNESS", "")
}

const (
	sessA = "11111111-aaaa-4bbb-8ccc-000000000001"
	sessB = "22222222-aaaa-4bbb-8ccc-000000000002"
)

func TestSendToAnUnknownNameWritesNothing(t *testing.T) {
	t.Chdir(sandbox(t))
	as(t, sessA)
	code, out, errOut := capture(t, func() int { return coordMain("sessions", []string{"send", "burn-gone", "hello"}) })
	if code == 0 || out != "" || !strings.Contains(errOut, "not sent: burn-gone") {
		t.Fatalf("refused: %d %q %q", code, out, errOut)
	}
	_, inbox, _ := capture(t, func() int { return coordMain("sessions", []string{"inbox"}) })
	if strings.Contains(inbox, "hello") {
		t.Errorf("a refused send left a request behind: %q", inbox)
	}
}

func TestSessionSendHelpDoesNotSendARequest(t *testing.T) {
	t.Chdir(sandbox(t))
	code, out, errOut := capture(t, func() int { return coordMain("sessions", []string{"send", "--help"}) })
	if code != 0 || !strings.Contains(out, "sessions send TO TEXT") || errOut != "" {
		t.Fatalf("help: %d %q %q", code, out, errOut)
	}
}

func TestLeaseVerbsAndHandshakeFromTheCommandLine(t *testing.T) {
	repo := sandbox(t)
	t.Chdir(repo)
	run := func(session, mode string, args ...string) (int, string, string) {
		as(t, session)
		return capture(t, func() int { return coordMain(mode, args) })
	}

	if code, out, _ := run(sessA, "lease", "src/**"); code != 0 || !strings.HasPrefix(out, "Acquired lease ") {
		t.Fatalf("acquire: %d %q", code, out)
	}
	if code, out, _ := run(sessB, "lease", "--list"); code != 0 || !strings.Contains(out, "cc:111111 · lease:'") {
		t.Fatalf("list: %d %q", code, out)
	}
	if code, _, errOut := run(sessB, "lease", "--check", "src/a.go"); code != 0 || !strings.HasPrefix(errOut, "WARNING: ") {
		t.Fatalf("check: %d %q", code, errOut)
	}
	if code, out, _ := run(sessA, "lease", "--release-all"); code != 0 || out != "Released 1 lease(s).\n" {
		t.Fatalf("release: %d %q", code, out)
	}
	run(sessA, "lease", "src/**")
	if code, out, _ := run(sessA, "lease", "--release"); code != 0 || out != "Released 1 lease(s).\n" {
		t.Fatalf("bare --release: %d %q", code, out)
	}
	if code, out, _ := run(sessB, "lease", "--help"); code != 0 || !strings.HasPrefix(out, "Usage: aico lease GLOB") {
		t.Fatalf("lease --help: %d %q", code, out)
	}
	if code, out, _ := run(sessB, "lease", "-h"); code != 0 || !strings.Contains(out, "--release-all") {
		t.Fatalf("lease -h: %d %q", code, out)
	}
	if code, _, errOut := run(sessA, "lease", "list"); code != 2 || !strings.Contains(errOut, "use --list") {
		t.Fatalf("an action word is not a path: %d %q", code, errOut)
	}
	if code, _, errOut := run(sessA, "lease", "status"); code != 2 || !strings.Contains(errOut, "use --list") {
		t.Fatalf("an action word is not a path: %d %q", code, errOut)
	}

	registered(t, sessB)
	code, out, _ := run(sessA, "sessions", "send", "cc:222222", "please look at the lease change", "--source-key", "k1")
	if code != 0 || !strings.HasPrefix(out, "sent ") {
		t.Fatalf("send: %d %q", code, out)
	}
	id := strings.Fields(out)[1]
	if _, again, _ := run(sessA, "sessions", "send", "cc:222222", "other", "--source-key", "k1"); !strings.HasPrefix(again, "existing "+id) {
		t.Errorf("duplicate send: %q", again)
	}
	if _, inbox, _ := run(sessB, "sessions", "inbox"); !strings.HasPrefix(inbox, id+" open cc:111111->cc:222222 - | please look") {
		t.Errorf("recipient inbox: %q", inbox)
	}
	if _, inbox, _ := run(sessA, "sessions", "inbox"); !strings.HasPrefix(inbox, id+" open/unseen ") {
		t.Errorf("sender inbox: %q", inbox)
	}
	if code, _, errOut := run(sessB, "sessions", "ack", id, "no"); code != 2 || !strings.Contains(errOut, "needs a short reason") {
		t.Errorf("no without a reason: %d %q", code, errOut)
	}
	if code, out, _ := run(sessB, "sessions", "ack", id, "yes", "done, see the diff"); code != 0 || !strings.HasPrefix(out, "acked "+id+" yes") {
		t.Errorf("ack: %d %q", code, out)
	}
	if code, out, _ := run(sessA, "sessions", "confirm", id); code != 0 || out != "closed "+id+"\n" {
		t.Errorf("confirm: %d %q", code, out)
	}
	if code, _, errOut := run(sessA, "sessions", "send", "cc:222222", "x", "--delivery", "fleet-stream"); code != 2 || !strings.Contains(errOut, "handshakes only") {
		t.Errorf("fleet delivery stays in st: %d %q", code, errOut)
	}
}

func TestInboxHookPrintsHookJSON(t *testing.T) {
	repo := sandbox(t)
	t.Chdir(repo)
	registered(t, sessB)
	as(t, sessA)
	if code, _, _ := capture(t, func() int {
		return coordMain("sessions", []string{"send", "cc:222222", "urgent: build is red"})
	}); code != 0 {
		t.Fatal("send failed")
	}
	as(t, sessB)
	stdin(t, `{"hook_event_name":"UserPromptSubmit","session_id":"`+sessB+`","prompt":"hi"}`)
	code, out, _ := capture(t, func() int { return coordMain("inbox", []string{"turn"}) })
	if code != 0 || !strings.Contains(out, `"hookEventName":"UserPromptSubmit"`) || !strings.Contains(out, "URGENT REQUEST") {
		t.Fatalf("turn: %d %q", code, out)
	}
	stdin(t, `{"hook_event_name":"UserPromptSubmit","session_id":"`+sessB+`"}`)
	if _, out, _ = capture(t, func() int { return coordMain("inbox", []string{"turn"}) }); out != "" {
		t.Errorf("shown once: %q", out)
	}
	stdin(t, `{}`)
	if code, out, _ = capture(t, func() int { return coordMain("inbox", []string{"watch"}) }); code != 0 || out != "" {
		t.Errorf("watch is a no-op: %d %q", code, out)
	}
}

// stdin replaces os.Stdin with text for the rest of the test.
func stdin(t *testing.T, text string) {
	t.Helper()
	r, w, _ := os.Pipe()
	_, _ = w.WriteString(text)
	w.Close()
	old := os.Stdin
	os.Stdin = r
	t.Cleanup(func() { os.Stdin = old })
}

// st sessions inbox, delegated here, still prints the notices after the rows (an ack to confirm), and says so
// when the store does not answer instead of listing nothing.
func TestSessionsInboxPrintsNoticesAndRefusesUnknown(t *testing.T) {
	repo := sandbox(t)
	t.Chdir(repo)
	run := func(session string, args ...string) (int, string, string) {
		as(t, session)
		return capture(t, func() int { return coordMain("sessions", args) })
	}
	registered(t, sessB)
	if _, empty, _ := run(sessA, "inbox"); !strings.Contains(empty, "No messages.") {
		t.Fatalf("an empty inbox should say so: %q", empty)
	}
	_, out, errSend := run(sessA, "send", "cc:222222", "can I take the lease file")
	if len(strings.Fields(out)) < 2 {
		t.Fatalf("send: %q %q", out, errSend)
	}
	id := strings.Fields(out)[1]
	if code, _, _ := run(sessB, "ack", id, "eta:5"); code != 0 {
		t.Fatal("ack failed")
	}
	_, inbox, _ := run(sessA, "inbox")
	if !strings.Contains(inbox, id+" acked ") || !strings.Contains(inbox, "ACK "+id+" eta 5m from cc:222222; close: st sessions confirm "+id) {
		t.Fatalf("inbox lacks the row or the ack notice: %q", inbox)
	}
	t.Setenv("TETHER_SOCKET", filepath.Join(t.TempDir(), "gone.sock"))
	lease.SetBudget(time.Now(), 0)
	if code, out, errOut := run(sessA, "inbox"); code != 2 || out != "" || !strings.Contains(errOut, "coordination store unavailable") {
		t.Fatalf("store down: %d %q %q", code, out, errOut)
	}
}
