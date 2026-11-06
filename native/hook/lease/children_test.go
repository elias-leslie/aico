package lease

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNativeBackgroundChildSurvivesRestartAndReportsOnlyTranscriptAge(t *testing.T) {
	sandbox(t)
	path := filepath.Join(t.TempDir(), "agent-test.jsonl")
	if err := os.WriteFile(path, []byte("private transcript content must never be read"), 0600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-20 * time.Minute)
	_ = os.Chtimes(path, old, old)
	launch := agent(sidA, "PostToolUse")
	launch.ID.env["AICO_WIDGET_ID"] = "abcd1234"
	launch.Payload = map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Agent", "tool_use_id": "call-1",
		"tool_input":    map[string]any{"run_in_background": true, "subagent_type": "reviewer", "prompt": "do not retain this"},
		"tool_response": map[string]any{"agentId": "child-1", "outputFile": path}}
	launch.RecordAgent()
	restarted := agent(sidA, "SessionStart")
	lines := restarted.UnfinishedChildren()
	if len(lines) != 1 || !strings.Contains(lines[0], "child-1") || !strings.Contains(lines[0], "20m") {
		t.Fatalf("unfinished child not reported: %v", lines)
	}
	replacement := agent(sidB, "SessionStart")
	replacement.ID.env["AICO_WIDGET_ID"] = "abcd1234"
	if len(replacement.UnfinishedChildren()) != 1 {
		t.Fatal("a coordinator's replacement context lost the unfinished child")
	}
	raw := string(fake.Doc("_coord")["native_children"])
	if strings.Contains(raw, "do not retain") || strings.Contains(strings.Join(lines, ""), "private transcript") {
		t.Fatal("retained task or transcript text")
	}
	stop := agent(sidA, "SubagentStop")
	stop.Payload = map[string]any{"hook_event_name": "SubagentStop", "agent_id": "child-1"}
	stop.RecordAgent()
	if got := agent(sidA, "SessionStart").UnfinishedChildren(); len(got) != 0 {
		t.Fatalf("finished child still unfinished: %v", got)
	}
}

func TestSessionStartBindsHistoryBeforeAnyPoll(t *testing.T) {
	sandbox(t)
	h := agent(sidA, "SessionStart")
	h.ID.env["AICO_WIDGET_ID"] = "abcd1234"
	h.SessionStart()
	if len(fake.HistoryOwners) != 1 {
		t.Fatal("SessionStart did not bind the native transcript")
	}
	owner := fake.HistoryOwners[0]
	if owner["session"] != "abcd1234" || owner["nativeId"] != sidA || owner["tool"] != "claude-code" {
		t.Fatalf("%v", owner)
	}
}

func TestCodexChildStopFinishesItsSelfRecordedStartAndOldRowsArePruned(t *testing.T) {
	sandbox(t)
	const child = "01a1aaab-d0db-7e20-b992-4fe413fe6780"
	start := agent(child, "SubagentStart")
	start.ID.env["AICO_WIDGET_ID"] = "abcd1234"
	start.Payload = map[string]any{"hook_event_name": "SubagentStart", "session_id": child, "agent_id": child, "agent_type": "worker"}
	start.RecordAgent()
	parent := agent(sidA, "SessionStart")
	parent.ID.env["AICO_WIDGET_ID"] = "abcd1234"
	if got := parent.UnfinishedChildren(); len(got) != 1 {
		t.Fatalf("running Codex child not listed for its coordinator: %v", got)
	}
	// The stop may name the parent's session; it still finishes the child's own row.
	stop := agent(sidA, "SubagentStop")
	stop.Payload = map[string]any{"hook_event_name": "SubagentStop", "session_id": sidA, "agent_id": child, "agent_type": "worker"}
	stop.RecordAgent()
	if got := parent.UnfinishedChildren(); len(got) != 0 {
		t.Fatalf("stopped Codex child still unfinished: %v", got)
	}
	var doc map[string]map[string]any
	_ = json.Unmarshal(fake.Doc("_coord")["native_children"], &doc)
	children := map[string]map[string]any{}
	for k, v := range doc {
		children[k] = v
	}
	old := stamp(time.Now().Add(-100 * time.Hour))
	children["x/stale"] = map[string]any{"id": "stale", "started": old}
	children["x/done"] = map[string]any{"id": "done", "started": old, "finished": stamp(time.Now().Add(-25 * time.Hour))}
	children["x/live"] = map[string]any{"id": "live", "started": stamp(time.Now().Add(-2 * time.Hour))}
	testConfig().pruneChildren(children, time.Now())
	if children["x/stale"] != nil || children["x/done"] != nil || children["x/live"] == nil || len(children) != 2 {
		t.Fatalf("pruning kept or dropped the wrong rows: %v", children)
	}
}
