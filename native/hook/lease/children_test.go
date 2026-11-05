package lease

import (
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
