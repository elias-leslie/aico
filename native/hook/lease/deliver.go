package lease

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// Waking a recipient: one content-free `[Message] ...` line on the delivery queue of the Aico window its agent
// runs in (Tether "Deliveries"). The line carries counts and agent ids, never request text; the recipient's
// own turn hook shows the content. One source per recipient (coord:<agent>), so a newer line replaces an
// undelivered one and always sums up what that recipient has waiting.

const queuedDoc = "_queued"

const (
	lineMax    = 500
	sourcePre  = "coord:"
	namedSends = 3
)

var (
	widgetID = regexp.MustCompile(`^[0-9a-f]{8}$`)
	agentRef = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,15}:[A-Za-z0-9_.-]{1,64}(@[a-z0-9][a-z0-9-]{0,31})?$`)
)

// Target is where a recipient's line goes: its window, the id the line is queued under, and every id its own
// inbox answers for.
type Target struct {
	Widget   string
	AgentID  string
	Family   map[string]bool
	Sessions []string
}

// nested: a harness started under another harness (a headless `claude -p` an agent runs) inherits its window.
func nested(anchor string) bool {
	pidS, _, _ := strings.Cut(anchor, ":")
	pid := 0
	fmt.Sscan(pidS, &pid)
	_, ppid, _, ok := procStat(pid)
	for i := 0; ok && ppid > 1 && i < 40; i++ {
		comm, next, _, ok2 := procStat(ppid)
		if !ok2 {
			return false
		}
		if harnessProvider(ppid, comm) != "" && !sharedHost(ppid) {
			return true
		}
		ppid = next
	}
	return false
}

// TargetFor finds the Aico window a local recipient is the live agent of, or nil: only the window's own agent
// (its newest main-thread identity, or a main-thread predecessor on the same process) is woken there.
func (h *Hook) TargetFor(to string) *Target {
	if to == "" || strings.Contains(to, "@") {
		return nil
	}
	ids := rows(h.Cfg.loadDoc(), "identities")
	agent, row := to, ids[to]
	if row == nil && len(to) >= 13 {
		for aid, r := range ids {
			if strings.HasPrefix(str(r["session"]), to) {
				agent, row = aid, r
				break
			}
		}
	}
	if row == nil {
		return nil
	}
	anchor := str(row["anchor"])
	if anchor == "" || !anchorAlive(anchor) || nested(anchor) {
		return nil
	}
	widget := widgetFor(anchor)
	if !widgetID.MatchString(widget) {
		return nil
	}
	newest, newestAnchor := "", ""
	for _, r := range ids {
		a := str(r["anchor"])
		if a == "" || !anchorAlive(a) || widgetFor(a) != widget || nested(a) {
			continue
		}
		if k := str(r["last"]); k > newest || (k == newest && a > newestAnchor) {
			newest, newestAnchor = k, a
		}
	}
	if newestAnchor != anchor {
		return nil // the window's newest agent runs in another process
	}
	family := map[string]bool{}
	mains := map[string]bool{}
	var sessions []string
	for aid, r := range ids {
		if str(r["anchor"]) == anchor {
			family[aid] = true
			if truthy(r["main"]) {
				mains[aid] = true
			}
			if s := str(r["session"]); s != "" {
				sessions = append(sessions, s)
			}
		}
	}
	if len(mains) == 0 {
		mains = family
	}
	if !mains[agent] {
		return nil // a child thread keeps its own inbox
	}
	current, last := agent, ""
	for aid := range mains {
		if l := str(ids[aid]["last"]); l >= last {
			current, last = aid, l
		}
	}
	return &Target{Widget: widget, AgentID: current, Family: family, Sessions: sessions}
}

func (t *Target) addressed(to string) bool {
	if t.Family[to] {
		return true
	}
	if len(to) < 13 {
		return false
	}
	for _, s := range t.Sessions {
		if strings.HasPrefix(s, to) {
			return true
		}
	}
	return false
}

// waiting: open requests to the recipient and acks of its requests it has not been shown; rides: FYI notes to
// it and bare acks that closed its requests it has not been shown (ride-along only).
func (h *Hook) waiting(t *Target, replyWaited map[string]bool) (requests, acks, fyis, closed []map[string]any) {
	seen := loadSeen(t.AgentID)
	for _, r := range h.Rows() {
		id, to, from, state := str(r["id"]), str(r["to"]), str(r["from"]), str(r["state"])
		switch {
		case state == "open" && t.addressed(to) && !t.Family[from]:
			requests = append(requests, r)
		case state == "acked" && t.Family[from] && !seen.has(id+":ack:"+pyStr(r["acked_at"])):
			waited := false
			for ref := range replyWaited {
				waited = waited || strings.HasPrefix(id, ref)
			}
			if !waited {
				acks = append(acks, r)
			}
		case state == "fyi" && t.addressed(to) && !t.Family[from] && !seen.has(id+":fyi"):
			fyis = append(fyis, r)
		case state == "closed" && truthy(r["auto_closed"]) && t.Family[from] && !seen.has(id+":ack:"+pyStr(r["acked_at"])):
			closed = append(closed, r)
		}
	}
	return
}

func counted(n int, word string) string {
	if n == 1 {
		return strings.ToUpper(word[:1]) + word[1:]
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func names(ids []string, named int) string {
	var shown []string
	have := map[string]bool{}
	for _, i := range ids {
		if agentRef.MatchString(i) && !have[i] {
			have[i] = true
			shown = append(shown, i)
		}
	}
	if len(shown) == 0 || named == 0 {
		if len(shown) > 1 {
			return fmt.Sprintf("%d agents", len(shown))
		}
		return "another agent"
	}
	extra := len(shown) - named
	if extra > 0 {
		return strings.Join(shown[:named], ", ") + fmt.Sprintf(" +%d", extra)
	}
	return strings.Join(shown, ", ")
}

// Compose is the recipient's line and whether it is ride-along only; ok false when nothing is waiting.
func (h *Hook) Compose(t *Target, replyWaited map[string]bool) (line string, ride, ok bool) {
	requests, acks, fyis, closed := h.waiting(t, replyWaited)
	if len(requests)+len(acks)+len(fyis)+len(closed) == 0 {
		return "", false, false
	}
	from := func(rs []map[string]any, key string) []string {
		var out []string
		for _, r := range rs {
			out = append(out, str(r[key]))
		}
		return out
	}
	for _, named := range []int{namedSends, 1, 0} {
		var parts []string
		if len(requests) > 0 {
			parts = append(parts, fmt.Sprintf("%s from %s", counted(len(requests), "request"), names(from(requests, "from"), named)))
		}
		if len(acks) > 0 {
			parts = append(parts, fmt.Sprintf("%s from %s", counted(len(acks), "ack"), names(from(acks, "acked_by"), named)))
		}
		if len(fyis) > 0 {
			n := "FYI"
			if len(fyis) > 1 {
				n = fmt.Sprintf("%d FYIs", len(fyis))
			}
			parts = append(parts, fmt.Sprintf("%s from %s", n, names(from(fyis, "from"), named)))
		}
		if len(closed) > 0 {
			parts = append(parts, fmt.Sprintf("%s from %s (closed)", counted(len(closed), "ack"), names(from(closed, "acked_by"), named)))
		}
		line = "[Message] " + strings.Join(parts, " · ") + " · st sessions inbox"
		if len([]rune(line)) <= lineMax {
			break
		}
	}
	return line, len(requests)+len(acks) == 0, true
}

// ReplyWaited: requests whose ack this window's own `st aico wait reply` reports, so the ack needs no line.
func replyWaited(widget string) map[string]bool {
	var out struct {
		Items []map[string]any `json:"items"`
	}
	if _, err := tetherCall("GET", "/v1/sessions/"+url.PathEscape(widget)+"/waits?recent=1", nil, &out); err != nil {
		return nil
	}
	refs := map[string]bool{}
	for _, w := range out.Items {
		ref := str(w["ref"])
		if str(w["kind"]) != "reply" || str(w["until"]) != "acked" || truthy(w["host"]) || ref == "" {
			continue
		}
		if st := str(w["state"]); st == "armed" || (st == "fired" && str(w["outcome"]) == "until") {
			refs[ref] = true
		}
	}
	return refs
}

// WindowOf is the Aico window an agent id runs in, "" when none.
func (h *Hook) WindowOf(agent string) string {
	if agent == "" {
		return ""
	}
	r := rows(h.Cfg.loadDoc(), "identities")[agent]
	if r == nil {
		return ""
	}
	if w := widgetFor(str(r["anchor"])); widgetID.MatchString(w) {
		return w
	}
	return ""
}

// Wake queues the recipient's line. sender is the agent whose command queues it (its window is the line's
// `from`); reply marks an ack. It returns the line queued, "" when the recipient has no window it is the agent
// of or nothing waits; an error means Tether did not take it (the ledger row is written either way).
func (h *Hook) Wake(to, sender string, reply bool) (string, error) {
	t := h.TargetFor(to)
	if t == nil {
		return "", nil
	}
	line, ride, ok := h.Compose(t, replyWaited(t.Widget))
	if !ok {
		return "", nil
	}
	body := map[string]any{"source": sourcePre + t.AgentID, "line": line, "ride": ride}
	if own := h.WindowOf(sender); own != "" && own != t.Widget {
		body["from"] = []string{own}
		if reply {
			body["reply"] = true
		}
	}
	if _, err := tetherCall("POST", "/v1/sessions/"+url.PathEscape(t.Widget)+"/deliveries", body, nil); err != nil {
		return "", err
	}
	_ = markQueued(t.AgentID, true)
	return line, nil
}

// markQueued remembers that a line is queued for agent (or taken back), so the turn hook asks Tether to drop a
// stale one only when there is one. Kept in its own document, {agent id: true}.
func markQueued(agent string, queued bool) error {
	return updateDoc(queuedDoc, func() error {
		out := map[string]any{}
		for k, v := range readDoc(queuedDoc) {
			out[k] = v
		}
		if queued {
			out[agent] = true
		} else {
			delete(out, agent)
		}
		return writeDoc(queuedDoc, out)
	})
}

func wasQueued(agent string) bool { _, ok := readDoc(queuedDoc)[agent]; return ok }

// WithdrawStale takes back agent's undelivered line once its inbox has nothing waiting.
func (h *Hook) WithdrawStale(agent string) bool {
	t := h.TargetFor(agent)
	if t == nil || !wasQueued(t.AgentID) {
		return false
	}
	if _, _, waiting := h.Compose(t, replyWaited(t.Widget)); waiting {
		return false
	}
	_, err := tetherCall("DELETE", "/v1/sessions/"+url.PathEscape(t.Widget)+"/deliveries?source="+url.QueryEscape(sourcePre+t.AgentID), nil, nil)
	if err == nil {
		_ = markQueued(t.AgentID, false)
	}
	return err == nil
}

// Nudge asks Tether to re-read a wait now (a hint: a lost one costs Tether's own re-read).
func Nudge(kind, ref string) {
	_, _ = tetherCall("POST", "/v1/waits/check", map[string]any{"kind": kind, "ref": ref}, nil)
}

// SettleBareAck closes an acked request for its sender when the ack is a bare yes the sender waits on nothing for
// (no note, not from another host, and no `aico wait reply` armed or fired for it). A noted yes, a no, an eta
// and a waited-on request stay as they are. The row returned is the ledger's, closed or not.
func (h *Hook) SettleBareAck(row map[string]any) map[string]any {
	if str(row["intent"]) != "yes" || truthy(row["host"]) || str(row["state"]) != "acked" || truthy(row["note"]) {
		return row
	}
	id := str(row["id"])
	if w := h.WindowOf(str(row["from"])); w != "" {
		for ref := range replyWaited(w) {
			if strings.HasPrefix(id, ref) {
				return row
			}
		}
	}
	if closed, err := h.CloseBareAck(id); err == nil {
		return closed
	}
	return row
}
