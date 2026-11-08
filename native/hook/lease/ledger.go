package lease

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The handshake ledger: requests agents send each other (`st sessions send|ack|confirm|inbox`), kept in the
// "_coord" document's messages for 24 hours. Rows keep the field names SummitFlow's coord.py wrote.

const (
	MaxText    = 500
	ackValid   = 2 * time.Hour
	ackHintFmt = "st sessions ack %s yes | no 'why' | eta:MIN (note a yes only if the sender must act; urgent: send a request; status: done report, progress: --fyi)"
)

var etaIntent = regexp.MustCompile(`^eta:(\d{1,4})$`)

// AckHint says how to answer request id.
func AckHint(id string) string { return fmt.Sprintf(ackHintFmt, id) }

func shortID() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func cleanText(text string, limit int) (string, error) {
	flat := strings.Join(strings.Fields(text), " ")
	if flat == "" {
		return "", fmt.Errorf("message text is empty")
	}
	if limit > 0 && len([]rune(flat)) > limit {
		return "", fmt.Errorf("message text exceeds %d chars; put long material in a brief file and send its path", limit)
	}
	return flat, nil
}

// withLedger runs fn on the live messages as one change of the registry; fn returns true when it changed a row
// (the messages are then saved, which also drops rows older than 24 hours). fn runs again on a fresh read when
// someone else saved first, so it must set its results on every run.
func (h *Hook) withLedger(fn func(rows []map[string]any, d map[string]any) ([]map[string]any, bool, error)) error {
	var ferr error
	err := h.Cfg.withCoordLock(func() error {
		ferr = nil
		d := h.Cfg.loadDoc()
		rows := h.ledger(d, time.Now().UTC())
		rows, changed, e := fn(rows, d)
		if e != nil {
			ferr = e
			return nil
		}
		if !changed {
			return nil
		}
		all := make([]any, len(rows))
		for i, r := range rows {
			all[i] = r
		}
		d["messages"] = all
		return h.Cfg.saveDoc(d)
	})
	if err != nil {
		return fmt.Errorf("the coordination store did not answer (is Tether running?): %w", err)
	}
	return ferr
}

// Rows is the live ledger, read without taking the lock.
func (h *Hook) Rows() []map[string]any {
	return h.ledger(h.Cfg.loadDoc(), time.Now().UTC())
}

func find(rows []map[string]any, id string) (map[string]any, error) {
	for _, r := range rows {
		if str(r["id"]) == id {
			return r, nil
		}
	}
	return nil, &UnknownRequest{id}
}

// UnknownRequest: no request with that id in this machine's ledger.
type UnknownRequest struct{ ID string }

func (e *UnknownRequest) Error() string { return "unknown request " + e.ID }

func copyRow(r map[string]any) map[string]any {
	out := make(map[string]any, len(r))
	for k, v := range r {
		out[k] = v
	}
	return out
}

// SendOpts is one request. Project is the sender's project (may be empty).
type SendOpts struct {
	To, Text, Project, SourceKey string
	FYI                          bool
}

// Send records a request (state open) or an FYI note. An identical open request, or any with the same source
// key, comes back as the existing row with duplicate true.
func (h *Hook) Send(o SendOpts) (row map[string]any, duplicate bool, err error) {
	body, err := cleanText(o.Text, MaxText)
	if err != nil {
		return nil, false, err
	}
	now := time.Now().UTC()
	err = h.withLedger(func(rows []map[string]any, d map[string]any) ([]map[string]any, bool, error) {
		row, duplicate = nil, false
		for _, r := range rows {
			if str(r["from"]) != h.ID.AgentID || str(r["to"]) != o.To {
				continue
			}
			same := o.SourceKey != "" && str(r["source_key"]) == o.SourceKey
			same = same || (str(r["text"]) == body && ((!o.FYI && str(r["state"]) == "open") ||
				(o.FYI && str(r["state"]) == "fyi" && !h.fyiShown(r))))
			if same {
				row, duplicate = copyRow(r), true
				return rows, false, nil
			}
		}
		state := "open"
		if o.FYI {
			state = "fyi"
		}
		row = map[string]any{"id": shortID(), "from": h.ID.AgentID, "from_session": h.ID.SessionID, "to": o.To,
			"project": nilIfEmpty(o.Project), "source_key": nilIfEmpty(o.SourceKey), "text": body,
			"created": stamp(now), "state": state, "intent": nil, "eta_min": nil, "note": nil, "acked_at": nil,
			"closed_at": nil, "surfaced_at": nil, "ack_seen": false}
		return append(rows, row), true, nil
	})
	return row, duplicate, err
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// Ack records the recipient's answer: yes | no | eta:MIN. A no needs a reason.
func (h *Hook) Ack(id, intent, note string) (map[string]any, error) {
	eta := etaIntent.FindStringSubmatch(intent)
	if intent != "yes" && intent != "no" && eta == nil {
		return nil, fmt.Errorf("intent must be yes, no or eta:<minutes>")
	}
	if intent == "no" && strings.TrimSpace(note) == "" {
		return nil, fmt.Errorf("a 'no' ack needs a short reason")
	}
	var out map[string]any
	lin := h.lineage()
	err := h.withLedger(func(rows []map[string]any, d map[string]any) ([]map[string]any, bool, error) {
		r, err := find(rows, id)
		if err != nil {
			return rows, false, err
		}
		if !h.addresses(str(r["to"]), lin.SelfIDs(h.ID), d) {
			return rows, false, fmt.Errorf("request %s is not addressed to %s", id, h.ID.AgentID)
		}
		switch str(r["state"]) {
		case "closed":
			return rows, false, fmt.Errorf("request %s is already closed", id)
		case "fyi":
			return rows, false, fmt.Errorf("%s is an FYI note: nothing to answer", id)
		}
		r["state"], r["acked_at"], r["acked_by"], r["ack_seen"] = "acked", stamp(time.Now()), h.ID.AgentID, false
		r["intent"], r["eta_min"], r["note"] = intent, nil, nil
		if eta != nil {
			n, _ := strconv.Atoi(eta[1])
			r["intent"], r["eta_min"] = "eta", n
		}
		if strings.TrimSpace(note) != "" {
			n, _ := cleanText(note, 0)
			r["note"] = n
		}
		out = copyRow(r)
		return rows, true, nil
	})
	return out, err
}

// CloseBareAck closes an acked request for its sender with no third step: a yes they wait on nothing for.
func (h *Hook) CloseBareAck(id string) (map[string]any, error) {
	var out map[string]any
	err := h.withLedger(func(rows []map[string]any, _ map[string]any) ([]map[string]any, bool, error) {
		r, err := find(rows, id)
		if err != nil {
			return rows, false, err
		}
		out = copyRow(r)
		if str(r["state"]) != "acked" || str(r["intent"]) != "yes" || truthy(r["note"]) {
			return rows, false, nil
		}
		r["state"], r["auto_closed"], r["closed_at"], r["ack_seen"] = "closed", true, stamp(time.Now()), true
		out = copyRow(r)
		return rows, true, nil
	})
	return out, err
}

// Confirm closes an acked request the caller sent; withdraw closes one nobody acked.
func (h *Hook) Confirm(id string, withdraw bool) (map[string]any, error) {
	mine := h.lineage().SelfIDs(h.ID)
	var out map[string]any
	err := h.withLedger(func(rows []map[string]any, _ map[string]any) ([]map[string]any, bool, error) {
		r, err := find(rows, id)
		if err != nil {
			return rows, false, err
		}
		if !mine[str(r["from"])] {
			return rows, false, fmt.Errorf("request %s was not sent by %s", id, h.ID.AgentID)
		}
		state := str(r["state"])
		if state == "closed" && truthy(r["auto_closed"]) && !withdraw {
			out = copyRow(r)
			return rows, false, nil
		}
		if state == "fyi" {
			return rows, false, fmt.Errorf("%s is an FYI note: nothing to confirm", id)
		}
		if withdraw {
			if state != "open" {
				return rows, false, fmt.Errorf("request %s is %s; only an unacked request can be withdrawn", id, state)
			}
			r["withdrawn"] = true
		} else if state != "acked" {
			return rows, false, fmt.Errorf("request %s has no ack to confirm (state=%s); to drop it: st sessions confirm %s --withdraw", id, state, id)
		}
		r["state"], r["closed_at"], r["ack_seen"] = "closed", stamp(time.Now()), true
		out = copyRow(r)
		return rows, true, nil
	})
	return out, err
}

// AckAuthorizes: a yes-ack of this request from holder (the project's lease holder), under two hours old.
func (h *Hook) AckAuthorizes(id string, holder Lease, project string) bool {
	r := h.yesFrom(id, holder.AgentID)
	return r != nil && (!truthy(r["project"]) || str(r["project"]) == project)
}

// yesFrom: my request id, answered yes by agent under two hours ago, else nil.
func (h *Hook) yesFrom(id, agent string) map[string]any {
	mine := h.lineage().SelfIDs(h.ID)
	for _, r := range h.Rows() {
		if str(r["id"]) != id || !mine[str(r["from"])] || str(r["intent"]) != "yes" {
			continue
		}
		if t, ok := parseStamp(str(r["acked_at"])); ok && str(r["acked_by"]) == agent && time.Since(t) <= ackValid {
			return r
		}
		return nil
	}
	return nil
}

// maxListedAgents bounds the live agents a refused send lists: enough to spot the one meant.
const maxListedAgents = 12

// KnownTarget: to names a registered identity (its exact id or a 13+ char session prefix).
func (h *Hook) KnownTarget(to string) bool {
	ids := rows(h.Cfg.loadDoc(), "identities")
	if _, ok := ids[to]; ok {
		return true
	}
	if len(to) < 13 {
		return false
	}
	for _, r := range ids {
		if strings.HasPrefix(str(r["session"]), to) {
			return true
		}
	}
	return false
}

// ResolveTarget maps the forms listings and st aico print to the registered agent id: the session forms
// (claude-code:9548c97a, cc:9548c97a, a session prefix or the whole id) when exactly one identity's session starts
// with it, then a request id or window id, to that window's live main agent.
func (h *Hook) ResolveTarget(to string) string {
	ids := rows(h.Cfg.loadDoc(), "identities")
	if _, ok := ids[to]; ok {
		return to
	}
	if prefix := to[strings.LastIndex(to, ":")+1:]; len(prefix) >= 6 {
		found := ""
		for id, r := range ids {
			if strings.HasPrefix(str(r["session"]), prefix) {
				if found != "" && found != id {
					return to
				}
				found = id
			}
		}
		if found != "" {
			return found
		}
	}
	if widget, host, err := sessionWindow(to); err == nil && widget != "" && host == "" {
		if agent := windowAgent(ids, widget); agent != "" {
			return agent
		}
	}
	return to
}

// sessionWindow: the Aico window of a running session named by its window id or its request id, and its host when
// it runs on another computer; "" when no session has that name.
func sessionWindow(name string) (widget, host string, err error) {
	var list struct {
		Items []map[string]any `json:"items"`
	}
	if _, err := tetherCall("GET", "/v1/sessions", nil, &list); err != nil {
		return "", "", err
	}
	for _, item := range list.Items {
		if str(item["id"]) == name || str(item["rootRequestId"]) == name {
			return str(item["id"]), str(item["host"]), nil
		}
	}
	return "", "", nil
}

// windowAgent: the newest live main-thread identity running in that window, or "".
func windowAgent(ids map[string]map[string]any, widget string) string {
	agent, newest := "", ""
	for id, r := range ids {
		anchor := str(r["anchor"])
		if anchor == "" || nested(anchor) || widgetFor(anchor) != widget {
			continue
		}
		if k := str(r["last"]); agent == "" || k > newest || (k == newest && id > agent) {
			agent, newest = id, k
		}
	}
	return agent
}

// SendTarget resolves a send's target or says why no message should be written: a row addressed to a name no agent
// answers to is never seen, while the sender would believe it was delivered. A remote name (id@host) is its host's
// to judge. An unreachable store is the caller's error, not an unknown name.
func (h *Hook) SendTarget(to string) (string, error) {
	if _, err := loadDocErr(coordDoc); err != nil {
		return "", err
	}
	resolved := h.ResolveTarget(to)
	if strings.Contains(resolved, "@") || h.KnownTarget(resolved) {
		return resolved, nil
	}
	widget, host, err := sessionWindow(to)
	if err != nil {
		return "", err
	}
	if host != "" {
		return "", fmt.Errorf("not sent: %s runs on %s, and its agent isn't known here. Use st aico root send %s", to, host, to)
	}
	if widget != "" {
		return "", fmt.Errorf("not sent: %s (window %s) has no agent registered yet; it registers when its agent starts, so send again in a moment", to, widget)
	}
	live, more := h.LiveAgents(), ""
	if len(live) == 0 {
		live = []string{"none"}
	}
	if len(live) > maxListedAgents {
		live, more = live[:maxListedAgents], fmt.Sprintf(" and %d more", len(live)-maxListedAgents)
	}
	return "", fmt.Errorf("not sent: %s is not a running session or agent. Use a request id from st aico roots, a session id or an agent id. Live agents: %s%s", to, strings.Join(live, ", "), more)
}

// LiveAgents: registered identities whose harness process is alive.
func (h *Hook) LiveAgents() []string {
	var out []string
	for id, r := range rows(h.Cfg.loadDoc(), "identities") {
		if anchorAlive(str(r["anchor"])) {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// Inbox: requests awaiting my ack, acks awaiting my confirm, requests I sent that are still open, FYI notes to
// me not yet shown, and noted closed acks not yet shown.
func (h *Hook) Inbox() []map[string]any {
	d := h.Cfg.loadDoc()
	lin := h.lineage()
	mine := lin.SelfIDs(h.ID)
	seen, _ := h.seenFor(mine) // a listing, not a shown-once surface: unread seen state lists every row
	var out []map[string]any
	for _, r := range h.ledger(d, time.Now().UTC()) {
		to, from, state := str(r["to"]), str(r["from"]), str(r["state"])
		addressed := h.addresses(to, mine, d)
		switch {
		case state == "open" && addressed,
			state == "fyi" && addressed && !seen.has(str(r["id"])+":fyi"),
			state == "acked" && mine[from],
			state == "open" && mine[from],
			state == "closed" && truthy(r["auto_closed"]) && truthy(r["note"]) && mine[from] &&
				!seen.has(str(r["id"])+":ack:"+pyStr(r["acked_at"])):
			out = append(out, r)
		}
	}
	return out
}

// ClosedAcks: my requests a yes closed with no third step.
func (h *Hook) ClosedAcks() []map[string]any {
	mine := h.lineage().SelfIDs(h.ID)
	var out []map[string]any
	for _, r := range h.Rows() {
		if str(r["state"]) == "closed" && truthy(r["auto_closed"]) && mine[str(r["from"])] {
			out = append(out, r)
		}
	}
	return out
}

// Surfaced: the recipient's own hook has shown it this request.
func (h *Hook) Surfaced(r map[string]any) bool {
	return loadSeen(str(r["to"])).has(str(r["id"]) + ":req")
}

func (h *Hook) fyiShown(r map[string]any) bool {
	key := str(r["id"]) + ":fyi"
	if loadSeen(str(r["to"])).has(key) {
		return true
	}
	seen, _ := h.seenFor(h.lineage().SelfIDs(h.ID))
	return seen.has(key)
}
