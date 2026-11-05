package lease

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The coordination inbox hook (`aico-hook inbox turn|stop`): what the agent is shown on each prompt and tool
// result, from the handshake ledger and Tether's ride-along lines. Not a safety gate: it fails open and is
// silent when nothing is waiting.

const (
	remindEvery   = 300 * time.Second // an unanswered request shows again this often
	throttleEvery = 15 * time.Second  // PostToolUse looks at most this often per thread
)

// Item is one inbox entry: its seen key, the line shown, URGENT, and ride-along (an FYI, a closed bare ack).
type Item struct {
	Key    string
	Line   string
	Urgent bool
	Ride   bool
}

func urgent(text string) bool {
	t := strings.ToUpper(strings.TrimLeft(text, "[!( "))
	return strings.HasPrefix(t, "URGENT") || strings.HasPrefix(t, "CONFLICT") || strings.HasPrefix(t, "CRITICAL")
}

// Pending is every inbox item for this agent: requests to me, acks of my requests, FYI notes, closed bare acks.
func (h *Hook) Pending() []Item {
	d := h.Cfg.loadDoc()
	mine := h.lineage().SelfIDs(h.ID)
	var items []Item
	for _, r := range h.ledger(d, time.Now().UTC()) {
		id, from, state := str(r["id"]), str(r["from"]), str(r["state"])
		switch {
		case state == "fyi" && !mine[from] && h.addresses(str(r["to"]), mine, d):
			items = append(items, Item{id + ":fyi", fmt.Sprintf("FYI %s from %s: %s | no reply needed", id, from, str(r["text"])), false, true})
		case state == "open" && !mine[from] && h.addresses(str(r["to"]), mine, d):
			u := urgent(str(r["text"]))
			flag := ""
			if u {
				flag = "URGENT "
			}
			lapsed := ""
			if str(r["intent"]) == "eta" {
				lapsed = fmt.Sprintf(" (your eta:%s ran out)", str(r["eta_min"]))
			}
			items = append(items, Item{id + ":req", fmt.Sprintf("%sREQUEST %s from %s%s: %s | answer now: %s", flag, id, from, lapsed, str(r["text"]), AckHint(id)), u, false})
		case state == "acked" && mine[from]:
			intent := pyStr(r["intent"])
			if intent == "" {
				intent = "?"
			}
			if truthy(r["eta_min"]) {
				intent += " " + str(r["eta_min"]) + "m"
			}
			note := ""
			if truthy(r["note"]) {
				note = " (" + str(r["note"]) + ")"
			}
			items = append(items, Item{id + ":ack:" + pyStr(r["acked_at"]), fmt.Sprintf("ACK %s %s%s from %s | close with `st sessions confirm %s`", id, intent, note, pyStr(r["acked_by"]), id), false, false})
		case state == "closed" && truthy(r["auto_closed"]) && mine[from]:
			note := ""
			if truthy(r["note"]) {
				note = " (" + str(r["note"]) + ")"
			}
			items = append(items, Item{id + ":ack:" + pyStr(r["acked_at"]), fmt.Sprintf("ACK %s yes%s from %s | closed; nothing to do", id, note, pyStr(r["acked_by"])), false, true})
		}
	}
	return append(items, h.childItems()...)
}

func (h *Hook) childItems() []Item {
	widget := h.ID.env["AICO_WIDGET_ID"]
	if widget == "" {
		return nil
	}
	var data struct {
		Items []map[string]any `json:"items"`
	}
	if _, err := tetherCall("GET", "/v1/children", nil, &data); err != nil {
		return nil
	}
	return vanishedChildren(data.Items, widget)
}

func vanishedChildren(children []map[string]any, parent string) []Item {
	var items []Item
	for _, child := range children {
		if str(child["parent"]) == parent && str(child["state"]) == "vanished" {
			id := str(child["id"])
			items = append(items, Item{Key: "child:" + id + ":vanished", Line: "Child agent " + str(child["title"]) + " (" + id + ") vanished; check its session with aico pulse.", Urgent: false, Ride: true})
		}
	}
	return items
}

// due is what a turn hook or Stop shows: a request again every remindEvery until answered, an ack or FYI once.
func due(seen seenSet, items []Item) []Item {
	now := float64(time.Now().UnixNano()) / 1e9
	var out []Item
	for _, it := range items {
		once := strings.Contains(it.Key, ":ack:") || it.Ride
		if (once && !seen.has(it.Key)) || (!once && now-seen[it.Key] >= remindEvery.Seconds()) {
			out = append(out, it)
		}
	}
	return out
}

func render(items []Item) string {
	waiting, allRide := false, true
	for _, it := range items {
		waiting = waiting || strings.HasSuffix(it.Key, ":req")
		allRide = allRide && it.Ride
	}
	head := "Coordination (update on a request you sent):"
	if waiting {
		head = "Coordination (another agent is waiting on you; reply before continuing):"
	} else if allRide {
		head = "Coordination (FYI; nothing to answer):"
	}
	sorted := append([]Item(nil), items...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Urgent && !sorted[j].Urgent })
	lines := []string{head}
	for _, it := range sorted {
		lines = append(lines, it.Line)
	}
	return strings.Join(lines, "\n")
}

// takesRide: the turns that carry Tether's ride-along lines: a new prompt, or the main agent's next tool result.
func takesRide(provider, event, subagent string) bool {
	if subagent != "" || (provider != "claude_code" && provider != "codex" && provider != "pi") {
		return false
	}
	return event == "UserPromptSubmit" || event == "PostToolUse" || (provider == "claude_code" && event == "PostToolUseFailure")
}

type ride struct{ widget, token, text string }

// peekRide: the ride-along lines Tether holds for this window, only for the window's own agent (a harness nested
// in it inherits AICO_WIDGET_ID but is not who they are for).
func (h *Hook) peekRide() *ride {
	widget := os.Getenv("AICO_WIDGET_ID")
	if !widgetID.MatchString(widget) {
		return nil
	}
	if t := h.TargetFor(h.ID.AgentID); t == nil || t.Widget != widget {
		return nil
	}
	var out struct {
		Text  *string `json:"text"`
		Token *string `json:"token"`
	}
	if _, err := tetherCall("GET", "/v1/sessions/"+url.PathEscape(widget)+"/due?ride=peek", nil, &out); err != nil || out.Text == nil || out.Token == nil || *out.Text == "" {
		return nil
	}
	return &ride{widget, *out.Token, *out.Text}
}

// confirm tells Tether the lines are taken; false when it did not answer (they are not shown then).
func (r *ride) confirm() bool {
	_, err := tetherCall("DELETE", "/v1/sessions/"+url.PathEscape(r.widget)+"/due?token="+url.QueryEscape(r.token), nil, nil)
	return err == nil
}

// throttled: a PostToolUse check ran for this thread less than throttleEvery ago (the stamp is its own record).
func (h *Hook) throttled(event string) bool {
	if event != "PostToolUse" && event != "PostToolUseFailure" {
		return false
	}
	thread := str(h.Payload["session_id"])
	if a := str(h.Payload["agent_id"]); a != "" {
		thread = a
	}
	if thread == "" || !validSession.MatchString(thread) {
		return false
	}
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		dir = os.TempDir()
	}
	path := filepath.Join(dir, "coord-inbox-throttle", thread)
	if raw, err := os.ReadFile(path); err == nil {
		if last, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64); err == nil &&
			float64(time.Now().UnixNano())/1e9-last < throttleEvery.Seconds() {
			return true
		}
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	_ = os.WriteFile(path, []byte(strconv.FormatFloat(float64(time.Now().UnixNano())/1e9, 'f', 3, 64)), 0o644)
	return false
}

// InboxHook is one inbox hook call. mode is "turn" (UserPromptSubmit, PostToolUse) or "stop"; provider the
// harness (claude_code, codex, pi). It returns the text to show as context, or a Stop block reason.
func (h *Hook) InboxHook(mode, provider string) (context, block string) {
	h.RecordAgent()
	event := str(h.Payload["hook_event_name"])
	worker := str(h.Payload["agent_id"])
	subagent := ""
	if provider == "claude_code" {
		subagent = worker // a Claude subagent shares its parent's session id; items stay for the parent
	}
	postTool := event == "PostToolUse" || event == "PostToolUseFailure"
	if mode == "turn" && postTool && (subagent != "" || h.throttled(event)) {
		return "", ""
	}
	var notice chan string // the memory notice runs beside the store calls, within its own short timeout
	if mode == "turn" && h.Extra != nil {
		notice = make(chan string, 1)
		go func() { notice <- h.Extra(event) }()
	}
	extra := func() string {
		if notice == nil {
			return ""
		}
		return <-notice
	}
	if subagent != "" || event == "SessionStart" || event == "SubagentStart" {
		return extra(), ""
	}
	h.Cfg.Observe(h.ID, false, false, false) // registered every turn: an agent that only reads must stay addressable
	agent := h.ID.AgentID
	var rd *ride
	if mode == "turn" && takesRide(provider, event, worker) {
		rd = h.peekRide()
	}
	var fresh []Item
	if seen, err := h.seenFor(h.lineage().SelfIDs(h.ID)); err == nil { // unread seen state: show nothing this turn
		fresh = due(seen, h.Pending())
	}
	waiting := false
	for _, it := range fresh {
		waiting = waiting || strings.HasSuffix(it.Key, ":req") // only a waiting requester justifies continuing Stop
	}
	if mode == "stop" && !waiting {
		fresh = nil
	}
	// What is shown is recorded first and shown only once recorded: a record that fails shows nothing now (it
	// shows on a later turn), never the same item twice. Every store call here shares the hook call's budget,
	// far inside the harness's timeout, so the answer is printed right after the record, not killed before.
	if len(fresh) > 0 {
		keys := make([]string, 0, len(fresh))
		for _, it := range fresh {
			keys = append(keys, it.Key)
		}
		if err := markSeen(agent, keys); err != nil {
			fresh = nil
		}
	}
	if rd != nil && !rd.confirm() {
		rd = nil // Tether keeps the lines for the next turn
	}
	if wasQueued(agent) { // a queued [Message] line nothing waits for any more is taken back before it is pasted
		h.WithdrawStale(agent)
	}
	if mode == "stop" {
		if len(fresh) > 0 {
			return "", render(fresh)
		}
		return "", ""
	}
	var parts []string
	if len(fresh) > 0 {
		parts = append(parts, render(fresh))
	}
	if rd != nil {
		parts = append(parts, rd.text)
	}
	if x := extra(); x != "" {
		parts = append(parts, x)
	}
	return strings.Join(parts, "\n\n"), ""
}

// StopJSON is Claude Code's and Codex's Stop answer: the turn continues so the agent answers.
func StopJSON(reason string) string {
	b, _ := json.Marshal(map[string]any{"decision": "block", "reason": reason})
	return string(b)
}
