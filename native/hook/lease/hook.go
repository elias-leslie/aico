package lease

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Hook carries one hook call: the payload, who it acts for, and the policy.
type Hook struct {
	Cfg     Config
	Payload map[string]any
	ID      Identity
	lin     *Lineage
	// Extra is text the inbox hook adds to what it shows on a turn event (the memory notice), set by the caller.
	Extra func(event string) string
}

func New(cfg Config, payload map[string]any) *Hook {
	return &Hook{Cfg: cfg.withDefaults(), Payload: payload, ID: Resolve(payload)}
}

func (h *Hook) lineage() Lineage {
	if h.lin == nil {
		l := h.Cfg.lineage(h.ID)
		h.lin = &l
	}
	return *h.lin
}

func (h *Hook) relineage() { h.lin = nil }

// ---------------------------------------------------------------- edits

var patchFile = regexp.MustCompile(`(?m)^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$`)

// EditPaths are the paths a Claude Code / Codex / Pi edit names (coord.hook_paths).
func EditPaths(payload map[string]any) []string {
	cwd := str(payload["cwd"])
	if cwd == "" {
		cwd = "."
	}
	var found []string
	patches := func(s string) {
		for _, m := range patchFile.FindAllStringSubmatch(s, -1) {
			if m[1] != "" {
				found = append(found, m[1])
			} else {
				found = append(found, m[2])
			}
		}
	}
	switch in := payload["tool_input"].(type) {
	case map[string]any:
		for _, k := range []string{"file_path", "notebook_path", "path"} {
			if v, ok := in[k].(string); ok && v != "" {
				found = append(found, v)
			}
		}
		if len(found) == 0 {
			for _, v := range in {
				if s, ok := v.(string); ok {
					patches(s)
				}
			}
		}
	case string:
		patches(in)
	}
	var out []string
	for _, p := range found {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if !filepath.IsAbs(p) {
			p = filepath.Join(cwd, p)
		}
		out = append(out, p)
	}
	return out
}

// Edit is the PreToolUse edit hook: ("block", line) under a live op, else WARNING lines for foreign leases.
// Every named path is leased to this agent and joins its writer set (advisory: the edit goes ahead).
func (h *Hook) Edit() (blocked bool, text string) {
	h.Cfg.Observe(h.ID, false, false, false)
	paths := EditPaths(h.Payload)
	for _, p := range paths { // a blocked edit never happens: nothing is claimed before this pass
		target := expandHome(p)
		if proj, ok := ProjectFor(target); ok {
			if line := h.opBlock(proj, realPath(target)); line != "" {
				return true, strings.Join(append([]string{"BLOCKED: " + line}, h.Notices()...), "\n")
			}
		}
	}
	var lines, unleased []string
	var why error
	for _, p := range paths {
		line, err := h.claim(p)
		if err != nil {
			unleased, why = append(unleased, p), err
			continue
		}
		if line != "" {
			lines = append(lines, "WARNING: "+line)
		}
	}
	if len(unleased) > 0 {
		lines = append(lines, fmt.Sprintf("WARNING: %v: %s not leased and not recorded as yours; the edit goes ahead, "+
			"and st commit refuses until the store answers", why, strings.Join(unleased, ", ")))
	}
	return false, strings.Join(lines, "\n")
}

func (h *Hook) opBlock(proj Project, real string) string {
	s, err := h.Cfg.store(proj.ID)
	if err != nil {
		return ""
	}
	marks, err := s.Active("hold", "op")
	if err != nil {
		return ""
	}
	for _, m := range marks {
		if m.Kind == "op" {
			if ignored(proj.Root, real) {
				return ""
			}
			return h.holderLine(proj.ID, m, proj.Root) + "; edits now invalidate it; work elsewhere, retry later"
		}
	}
	return ""
}

// claim leases one file to this agent (leases.claim + coord.claim_edit); a foreign lease gives one line. An
// error is a store that did not answer: the file is not leased.
func (h *Hook) claim(path string) (string, error) {
	target := expandHome(path)
	proj, ok := ProjectFor(target)
	if !ok {
		return "", nil
	}
	s, err := h.Cfg.store(proj.ID)
	if err != nil {
		return "", nil
	}
	real := filepath.Clean(realPath(target))
	lin := h.lineage()
	mine, anchor := lin.SelfIDs(h.ID), lin.MyAnchor()
	session := lin.SessionIDs(h.ID)
	now := stamp(time.Now())
	var conflict *Lease
	err = s.withLock(func() error {
		conflict = nil
		d := s.load()
		d.leases = s.purge(d.leases)
		for i := range d.leases {
			l := d.leases[i]
			if l.Kind == "file" && l.Matches(real) && !isMine(l, session, lin.Anchor) {
				conflict = &l
				break
			}
		}
		var own *Lease
		for i := range d.leases {
			l := &d.leases[i]
			if isMine(*l, mine, anchor) { // keep_alive: working here keeps my holds live too
				l.LastHeartbeat = now
				if l.Kind == "file" && l.Matches(real) {
					own = l
				}
			}
		}
		sensitive := h.ID.sensitive()
		if own == nil {
			l := Lease{LeaseID: newID(), AgentID: h.ID.AgentID, AgentSlug: h.ID.Slug, SessionID: h.ID.SessionID,
				Provider: h.ID.Provider, Globs: []string{real}, AcquiredAt: now, LastHeartbeat: now, Kind: "file",
				Sensitive: sensitive}
			if anchor != "" {
				l.Anchor = ptr(anchor)
			}
			d.leases = append(d.leases, l)
			own = &d.leases[len(d.leases)-1]
		}
		addWriter(d.writers, real, h.writerEntry("", ptr(own.Sensitive)))
		return s.save(d)
	})
	if err != nil {
		return "", err
	}
	if conflict == nil {
		return "", nil
	}
	return fmt.Sprintf("%s; edit allowed, both of you are now its writers and st commit refuses to sweep it; "+
		`tell them: st sessions send %s "<what changed>" --delivery handshake`,
		h.holderLine(proj.ID, *conflict, proj.Root), conflict.AgentID), nil
}

func (h *Hook) writerEntry(unknown string, sensitive *bool) map[string]any {
	lin := h.lineage()
	e := map[string]any{"agent_id": lin.RootKey(), "session_id": h.ID.SessionID, "anchor": nil,
		"at": stamp(time.Now())}
	if lin.Anchor != "" {
		e["anchor"] = lin.Anchor
	}
	if sensitive != nil {
		e["sensitive"] = *sensitive
	} else {
		e["sensitive"] = h.ID.sensitive()
	}
	if unknown != "" {
		e["agent_id"] = "unknown"
		e["reason"] = unknown
		e["by"] = h.ID.AgentID
	}
	return e
}

// ---------------------------------------------------------------- lines

func age(at string, now time.Time) string {
	t, ok := parseStamp(at)
	if !ok {
		return "?"
	}
	secs := int(now.Sub(t).Seconds())
	switch {
	case secs < 60:
		return fmt.Sprintf("%ds", secs)
	case secs < 3600:
		return fmt.Sprintf("%dm", secs/60)
	}
	return fmt.Sprintf("%dh", secs/3600)
}

func coarse(path, root string) string {
	if root != "" {
		rel, err := filepath.Rel(root, strings.TrimSuffix(path, "/**"))
		if err == nil && rel != ".." && !strings.HasPrefix(rel, "../") {
			if rel == "." {
				return "**"
			}
			return strings.SplitN(rel, "/", 2)[0] + "/**"
		}
	}
	return "**"
}

// holderLine names who holds what; opaque for sensitive holders (coord.holder_line).
func (h *Hook) holderLine(project string, l Lease, root string) string {
	now := time.Now().UTC()
	since := age(l.AcquiredAt, now)
	glob := ""
	if len(l.Globs) > 0 {
		glob = l.Globs[0]
	}
	if l.Sensitive {
		return fmt.Sprintf("%s: busy (%s) since %s · contact %s", project, coarse(glob, root), since, l.AgentID)
	}
	if l.Kind == "hold" || l.Kind == "op" {
		purpose := "-"
		if l.Purpose != nil && *l.Purpose != "" {
			purpose = *l.Purpose
		}
		return fmt.Sprintf("%s: %s %s by %s since %s%s", project, l.Kind, purpose, l.AgentID, since, h.conflictSuffix(l))
	}
	rel := glob
	if root != "" && strings.HasPrefix(rel, root+"/") {
		rel = rel[len(root)+1:]
	}
	return fmt.Sprintf("%s: %s leased by %s (idle %s)%s", project, rel, l.AgentID, age(l.LastHeartbeat, now), h.conflictSuffix(l))
}

// Notices are the actionable coordination lines shown with a BLOCKED edit (coord.notices).
func (h *Hook) Notices() []string {
	out := h.Cfg.Observe(h.ID, false, false, true)
	h.relineage()
	lin := h.lineage()
	mine := lin.SelfIDs(h.ID)
	addressed := func(to string) bool { return h.addresses(to, mine, lin.doc) }
	out = append(out, h.popNotes(addressed)...)
	now := time.Now().UTC()
	var lines []string
	_ = h.Cfg.withCoordLock(func() error {
		lines = nil
		d := h.Cfg.loadDoc()
		msgs := h.ledger(d, now)
		changed := false
		var toMe []string
		for _, r := range msgs {
			if str(r["state"]) == "open" && addressed(str(r["to"])) {
				toMe = append(toMe, str(r["id"]))
			}
		}
		if len(toMe) > 0 {
			ids := toMe
			if len(ids) > 3 {
				ids = ids[:3]
			}
			lines = append(lines, fmt.Sprintf("INBOX %d request(s) %s awaiting your ack: st sessions inbox", len(toMe), strings.Join(ids, ",")))
		}
		unacked := time.Duration(h.Cfg.UnackedMinutes) * time.Minute
		for _, r := range msgs {
			if !mine[str(r["from"])] {
				continue
			}
			state := str(r["state"])
			if state == "acked" && !truthy(r["ack_seen"]) {
				intent := pyStr(r["intent"])
				if truthy(r["eta_min"]) {
					intent += fmt.Sprintf(" %sm", str(r["eta_min"]))
				}
				lines = append(lines, fmt.Sprintf("ACK %s %s from %s; close: st sessions confirm %s", str(r["id"]), intent, pyStr(r["acked_by"]), str(r["id"])))
				r["ack_seen"] = true
				changed = true
			} else if state == "open" && !truthy(r["surfaced_at"]) && !truthy(r["intent"]) {
				if created, ok := parseStamp(str(r["created"])); ok && now.Sub(created) >= unacked {
					lines = append(lines, fmt.Sprintf("UNACKED %s -> %s (%s); escalate or route around", str(r["id"]), str(r["to"]), age(str(r["created"]), now)))
					r["surfaced_at"] = stamp(now)
					changed = true
				}
			}
		}
		if changed {
			all := make([]any, len(msgs))
			for i, r := range msgs {
				all[i] = r
			}
			d["messages"] = all
			return h.Cfg.saveDoc(d)
		}
		return nil
	})
	return append(out, lines...)
}

// ledger is the live handshake rows: 24 h, with lapsed eta acks reopened (coord._load_ledger).
func (h *Hook) ledger(d map[string]any, now time.Time) []map[string]any {
	var kept []map[string]any
	for _, r := range list(d, "messages") {
		created, ok := parseStamp(str(r["created"]))
		if !ok || now.Sub(created) > 24*time.Hour {
			continue
		}
		kept = append(kept, r)
		if str(r["state"]) == "acked" && str(r["intent"]) == "eta" && r["eta_min"] != nil {
			acked, ok := parseStamp(str(r["acked_at"]))
			if mins, isNum := r["eta_min"].(float64); ok && isNum && !now.Before(acked.Add(time.Duration(mins)*time.Minute)) {
				r["state"] = "open"
			}
		}
	}
	return kept
}

func (h *Hook) addresses(to string, family map[string]bool, d map[string]any) bool {
	if to == "" {
		return false
	}
	if to == h.ID.AgentID || (len(to) >= 13 && strings.HasPrefix(h.ID.SessionID, to)) || family[to] {
		return true
	}
	if len(to) < 13 || len(family) == 0 {
		return false
	}
	ids := rows(d, "identities")
	for i := range family {
		if strings.HasPrefix(str(ids[i]["session"]), to) {
			return true
		}
	}
	return false
}

func (h *Hook) popNotes(isMe func(string) bool) []string {
	var out []string
	now := time.Now().UTC()
	ttl := time.Duration(h.Cfg.NoteHours) * time.Hour
	_ = h.Cfg.withCoordLock(func() error {
		out = nil
		d := h.Cfg.loadDoc()
		var kept []any
		for _, n := range list(d, "notes") {
			if isMe(str(n["to"])) {
				out = append(out, str(n["text"]))
			} else if fresh(n["created"], ttl, now) {
				kept = append(kept, n)
			}
		}
		if len(out) == 0 {
			return nil
		}
		if kept == nil {
			kept = []any{}
		}
		d["notes"] = kept
		return h.Cfg.saveDoc(d)
	})
	return out
}

// ---------------------------------------------------------------- session start

// SessionStart registers the identity on its anchor; one line when a reset left work open (coord.session_start
// without the startup brief, which the caller adds).
func (h *Hook) SessionStart() []string {
	source := str(h.Payload["source"])
	if source == "" {
		source = str(h.Payload["reason"])
	}
	subagent := truthy(h.Payload["agent_id"]) || source == "resume" || source == "compact"
	lines := h.Cfg.Observe(h.ID, true, subagent, true)
	if !truthy(h.Payload["agent_id"]) {
		h.Cfg.MarkMain(h.ID)
		widget := h.ID.env["AICO_WIDGET_ID"]
		if widget == "" {
			widget = widgetFor(h.ID.Anchor)
		}
		tool := map[string]string{"claude_code": "claude-code", "codex_cli": "codex", "pi": "pi"}[h.ID.Provider]
		if widget != "" && tool != "" {
			_, _ = tetherCall("PUT", "/v1/history/owner", map[string]any{"session": widget, "nativeId": h.ID.SessionID, "tool": tool}, nil)
		}
	}
	return lines
}
