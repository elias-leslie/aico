package lease

import (
	"testing"
)

func TestResolvedRefusalDoesNotBlockDisruption(t *testing.T) {
	sandbox(t)
	a, b := agent(sidA, ""), agent(sidB, "")
	req, _, err := a.Send(SendOpts{To: b.ID.AgentID, Text: "restart test"})
	if err != nil {
		t.Fatal(err)
	}
	id := str(req["id"])
	if _, err := b.Ack(id, "no", "test still running"); err != nil {
		t.Fatal(err)
	}
	run := func(args []string) (string, error) { return "", nil }
	before := a.disruption("demo", []string{id}, run)
	if len(before["blocking"].([]string)) != 1 {
		t.Fatalf("open refusal not blocking: %v", before)
	}
	if _, err := a.Confirm(id, false); err != nil {
		t.Fatal(err)
	}
	after := a.disruption("demo", []string{id}, run)
	if len(after["blocking"].([]string)) != 0 {
		t.Fatalf("resolved refusal still blocking: %v", after)
	}
}
