package lease

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Identity is who this hook call acts for (leases.identify_agent after coord.adopt_hook_identity).
type Identity struct {
	AgentID   string
	Slug      string
	SessionID string
	Provider  string // the lease row's provider label (claude_code, codex_cli, pi, st, ...)
	Anchor    string // nearest harness process "<pid>:<start>", "" when none
	Harness   string // that process's provider (claude_code, codex, pi, antigravity), "" when none
	env       map[string]string
}

var harnessComms = map[string]string{"claude": "claude_code", "codex": "codex", "pi": "pi", "agy": "antigravity"}
var familyPrefix = map[string]string{"claude_code": "cc:", "codex": "codex:", "pi": "pi:", "antigravity": "agy:"}
var sessionEnv = map[string]string{
	"claude_code": "CLAUDE_CODE_SESSION_ID", "codex": "CODEX_THREAD_ID", "pi": "PI_SESSION_ID",
	"antigravity": "ANTIGRAVITY_CONVERSATION_ID",
}
var identityEnv = []string{"CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID",
	"PI_SESSION_ID", "ANTIGRAVITY_CONVERSATION_ID"}

const rootHandlePrefix = "aico-root-"

var (
	validSession = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	validSlug    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	uuid7        = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// ShortID is six distinguishing chars: a UUIDv7's random tail, otherwise its head.
func ShortID(sid string) string {
	sid = strings.TrimPrefix(sid, rootHandlePrefix)
	if uuid7.MatchString(sid) {
		return sid[len(sid)-6:]
	}
	if len(sid) > 6 {
		return sid[:6]
	}
	return sid
}

// Resolve adopts the event's native identity (Codex worker agent_id, else session_id) and identifies the agent.
func Resolve(payload map[string]any) Identity {
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			env[k] = v
		}
	}
	anchor, provider := harness(env)
	id := Identity{Anchor: anchor, Harness: provider, env: env}
	sid := str(payload["session_id"])
	if sid == "" {
		sid = str(payload["conversationId"])
	}
	stSid := env["ST_SESSION_ID"]
	if sid != "" && (stSid == "" || strings.HasPrefix(stSid, rootHandlePrefix)) {
		p := provider
		if p == "" {
			if str(payload["tool_name"]) == "apply_patch" || strings.Contains(str(payload["transcript_path"]), "/.codex/") {
				p = "codex"
			} else {
				p = "claude_code"
			}
		}
		if p == "codex" && truthy(payload["agent_id"]) {
			sid = str(payload["agent_id"])
		}
		for _, k := range identityEnv {
			delete(env, k)
		}
		key := sessionEnv[p]
		if key == "" {
			key = "CLAUDE_CODE_SESSION_ID"
		}
		env[key] = sid
	}
	id.AgentID, id.Slug, id.SessionID, id.Provider = identify(env, provider)
	return id
}

func identify(env map[string]string, harnessProvider string) (string, string, string, string) {
	session := func(key string) string {
		if v := env[key]; validSession.MatchString(v) {
			return v
		}
		return ""
	}
	st := session("ST_SESSION_ID")
	if st != "" && !strings.HasPrefix(st, rootHandlePrefix) {
		return "st:" + ShortID(st), "st", st, "st"
	}
	own := map[string][4]string{
		"claude_code": {"CLAUDE_CODE_SESSION_ID", "cc", "claude-code", "claude_code"},
		"codex":       {"CODEX_THREAD_ID", "codex", "codex", "codex_cli"},
		"pi":          {"PI_SESSION_ID", "pi", "pi", "pi"},
		"antigravity": {"ANTIGRAVITY_CONVERSATION_ID", "agy", "antigravity", "antigravity"},
	}
	if o, ok := own[harnessProvider]; ok {
		if sid := session(o[0]); sid != "" {
			return o[1] + ":" + ShortID(sid), o[2], sid, o[3]
		}
	}
	first := func(keys ...string) string {
		for _, k := range keys {
			if v := session(k); v != "" {
				return v
			}
		}
		return ""
	}
	if sid := first("CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"); sid != "" {
		return "cc:" + ShortID(sid), "claude-code", sid, "claude_code"
	}
	if sid := first("CODEX_SESSION_ID", "CODEX_THREAD_ID"); sid != "" {
		return "codex:" + ShortID(sid), "codex", sid, "codex_cli"
	}
	if slug, sid := env["AGENT_HUB_AGENT_SLUG"], session("AGENT_HUB_SESSION_ID"); slug != "" && validSlug.MatchString(slug) && sid != "" {
		return slug + ":" + ShortID(sid), slug, sid, "agent_hub_specialist"
	}
	if sid := session("PI_SESSION_ID"); sid != "" {
		return "pi:" + ShortID(sid), "pi", sid, "pi"
	}
	if sid := session("ANTIGRAVITY_CONVERSATION_ID"); sid != "" {
		return "agy:" + ShortID(sid), "antigravity", sid, "antigravity"
	}
	if st != "" {
		return "st:" + ShortID(st), "st", st, "st"
	}
	if pane := env["TMUX_PANE"]; pane != "" {
		return "tmux:" + strings.TrimLeft(pane, "%"), "tmux", pane, "unknown"
	}
	pid := strconv.Itoa(os.Getpid())
	return "pid:" + pid, "pid", pid, "unknown"
}

// ---------------------------------------------------------------- harness anchor

func harness(env map[string]string) (string, string) {
	if v, ok := env["ST_COORD_ANCHOR"]; ok {
		return v, env["ST_COORD_HARNESS"]
	}
	pid := os.Getpid()
	for range 40 {
		if pid <= 1 {
			return "", ""
		}
		comm, ppid, start, ok := procStat(pid)
		if !ok {
			return "", ""
		}
		if p := harnessProvider(pid, comm); p != "" {
			if sharedHost(pid) {
				return "", ""
			}
			return fmt.Sprintf("%d:%s", pid, start), p
		}
		pid = ppid
	}
	return "", ""
}

func procStat(pid int) (string, int, string, bool) {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", 0, "", false
	}
	s := string(raw)
	open, end := strings.Index(s, "("), strings.LastIndex(s, ")")
	if open < 0 || end < open {
		return "", 0, "", false
	}
	f := strings.Fields(s[end+1:])
	if len(f) < 20 {
		return "", 0, "", false
	}
	ppid, _ := strconv.Atoi(f[1])
	return s[open+1 : end], ppid, f[19], true
}

// harnessProvider: a harness's comm, or a Claude Code background job's versioned binary (.../claude/versions/<v>).
func harnessProvider(pid int, comm string) string {
	if p, ok := harnessComms[comm]; ok {
		return p
	}
	exe, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return ""
	}
	dir := filepath.Dir(exe)
	if filepath.Base(dir) != "versions" {
		return ""
	}
	return harnessComms[filepath.Base(filepath.Dir(dir))]
}

// sharedHost: a daemon hosting unrelated threads (app-server, exec-server, pty host, spare) is no agent.
func sharedHost(pid int) bool {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return true
	}
	args := strings.Split(string(raw), "\x00")
	for _, a := range args[1:] {
		if strings.HasSuffix(a, "-server") || strings.HasSuffix(a, "-host") || strings.HasSuffix(a, "bg-spare") || a == "daemon" {
			return true
		}
	}
	return false
}

func anchorAlive(anchor string) bool {
	pid, start, ok := strings.Cut(anchor, ":")
	if !ok {
		return false
	}
	n, err := strconv.Atoi(pid)
	return err == nil && n >= 0 && processAlive(n, start)
}

// ---------------------------------------------------------------- registry (_coord.json)

func (c Config) coordPath() string { return filepath.Join(c.dir(), "_coord.json") }

func (c Config) loadDoc() map[string]any {
	raw, err := os.ReadFile(c.coordPath())
	if err != nil {
		return map[string]any{}
	}
	var d map[string]any
	if json.Unmarshal(raw, &d) != nil || d == nil {
		return map[string]any{}
	}
	return d
}

func (c Config) saveDoc(d map[string]any) error {
	buf, err := marshal(d, " ")
	if err != nil {
		return err
	}
	return replaceFile(c.coordPath(), filepath.Join(c.dir(), fmt.Sprintf("_coord.%d.tmp", os.Getpid())), buf)
}

func (c Config) withCoordLock(fn func() error) error {
	return lockFile(filepath.Join(c.dir(), "_coord.lock"), fn)
}

func rows(d map[string]any, key string) map[string]map[string]any {
	out := map[string]map[string]any{}
	if m, ok := d[key].(map[string]any); ok {
		for k, v := range m {
			if row, ok := v.(map[string]any); ok {
				out[k] = row
			}
		}
	}
	return out
}

func list(d map[string]any, key string) []map[string]any {
	var out []map[string]any
	if l, ok := d[key].([]any); ok {
		for _, v := range l {
			if row, ok := v.(map[string]any); ok {
				out = append(out, row)
			}
		}
	}
	return out
}

func fresh(v any, ttl time.Duration, now time.Time) bool {
	t, ok := parseStamp(str(v))
	return ok && now.Sub(t) <= ttl
}

// Lineage is this identity's family on its live harness process (leases._lineage).
type Lineage struct {
	AgentID string
	Anchor  string // "" when no live anchor
	Family  map[string]bool
	Mains   map[string]bool
	Child   bool
	doc     map[string]any
}

func (c Config) lineage(id Identity) Lineage {
	l := Lineage{AgentID: id.AgentID, Family: map[string]bool{}, Mains: map[string]bool{}}
	l.doc = c.loadDoc()
	l.Anchor = c.currentAnchor(id, l.doc)
	if l.Anchor == "" {
		return l
	}
	for aid, row := range rows(l.doc, "identities") {
		if str(row["anchor"]) == l.Anchor {
			l.Family[aid] = true
			if truthy(row["main"]) {
				l.Mains[aid] = true
			}
		}
	}
	if len(l.Mains) == 0 {
		for k := range l.Family {
			l.Mains[k] = true
		}
		return l
	}
	l.Child = !l.Mains[id.AgentID]
	return l
}

func (c Config) currentAnchor(id Identity, d map[string]any) string {
	if id.Anchor != "" {
		if anchorAlive(id.Anchor) {
			return id.Anchor
		}
		return ""
	}
	if row, ok := rows(d, "identities")[id.AgentID]; ok {
		if a := str(row["anchor"]); anchorAlive(a) {
			return a
		}
	}
	return ""
}

func (id Identity) tmux(ids map[string]bool) map[string]bool {
	if pane := id.env["TMUX_PANE"]; pane != "" {
		ids["tmux:"+strings.TrimLeft(pane, "%")] = true
	}
	return ids
}

// SelfIDs are the lease owners I act for; MyAnchor stamps and matches my leases ("" for a child thread).
func (l Lineage) SelfIDs(id Identity) map[string]bool {
	out := map[string]bool{l.AgentID: true}
	if !l.Child {
		for k := range l.Mains {
			out[k] = true
		}
	}
	return id.tmux(out)
}

func (l Lineage) MyAnchor() string {
	if l.Child {
		return ""
	}
	return l.Anchor
}

// SessionIDs is my whole session for writer attribution: child threads and resets included.
func (l Lineage) SessionIDs(id Identity) map[string]bool {
	out := map[string]bool{l.AgentID: true}
	for k := range l.Family {
		out[k] = true
	}
	return id.tmux(out)
}

// RootKey is the writer key: a child thread records under its process's latest main-thread key.
func (l Lineage) RootKey() string {
	if !l.Child {
		return l.AgentID
	}
	ids := rows(l.doc, "identities")
	best, bestLast := l.AgentID, ""
	keys := sortedKeys(l.Mains)
	for _, aid := range keys {
		last := str(ids[aid]["last"])
		if best == l.AgentID || last > bestLast {
			best, bestLast = aid, last
		}
	}
	return best
}

func isMine(le Lease, mine map[string]bool, anchor string) bool {
	return mine[le.AgentID] || (anchor != "" && le.anchor() == anchor)
}

func isOwnWriter(e map[string]any, mine map[string]bool, anchor string) bool {
	if str(e["agent_id"]) == "unknown" {
		return false
	}
	return mine[str(e["agent_id"])] || (anchor != "" && str(e["anchor"]) == anchor)
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ---------------------------------------------------------------- observe

// Observe registers this identity on its anchor (coord_lineage.observe). On a reset (or lazily, except for
// Codex) a new identity on a live anchor is a successor: it gets one "continuing ..." line and each peer with an
// open exchange gets one "context reset" note. With emit the line is returned; otherwise it waits on the row.
func (c Config) Observe(id Identity, reset, subagent, emit bool) []string {
	if id.Anchor == "" {
		return nil
	}
	expected, known := familyPrefix[id.Harness]
	ok := false
	if known {
		ok = strings.HasPrefix(id.AgentID, expected)
	} else {
		for _, p := range familyPrefix {
			ok = ok || strings.HasPrefix(id.AgentID, p)
		}
	}
	if !ok {
		return nil // an id inherited from another harness never joins this process's family
	}
	now := time.Now().UTC()
	at := stamp(now)
	var out []string
	_ = c.withCoordLock(func() error {
		d := c.loadDoc()
		ids := c.pruneIdentities(rows(d, "identities"), now)
		if mine, ok := ids[id.AgentID]; ok {
			if str(mine["anchor"]) != id.Anchor {
				return nil // live on another process: never move it
			}
			mine["last"] = at
			var pending any
			if emit {
				pending = mine["notice"]
				delete(mine, "notice")
			}
			d["identities"] = toAny(ids)
			if truthy(pending) || !fresh(mine["saved"], time.Duration(c.RegistrySaveSec)*time.Second, now) {
				mine["saved"] = at
				_ = c.saveDoc(d)
			}
			if truthy(pending) {
				out = []string{str(pending)}
			}
			return nil
		}
		var preds []string
		for aid, row := range ids {
			if str(row["anchor"]) == id.Anchor && aid != id.AgentID {
				preds = append(preds, aid)
			}
		}
		sort.SliceStable(preds, func(i, j int) bool { return str(ids[preds[i]]["last"]) < str(ids[preds[j]]["last"]) })
		prov := id.Harness
		if prov == "" {
			prov = id.Provider
		}
		ids[id.AgentID] = map[string]any{"anchor": id.Anchor, "session": id.SessionID, "provider": prov,
			"first": at, "last": at, "saved": at}
		d["identities"] = toAny(ids)
		codex := id.Harness == "codex" || id.Provider == "codex_cli"
		line := ""
		if len(preds) > 0 && !subagent && (reset || !codex) {
			set := map[string]bool{}
			for _, p := range preds {
				set[p] = true
			}
			latest := preds[len(preds)-1]
			line = c.continuingLine(latest, set, d)
			c.notePeers(d, id.AgentID, set, latest, now)
			if line != "" && !emit {
				ids[id.AgentID]["notice"] = line
			}
		}
		_ = c.saveDoc(d)
		if line != "" && emit {
			out = []string{line}
		}
		return nil
	})
	return out
}

func toAny(m map[string]map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func (c Config) pruneIdentities(ids map[string]map[string]any, now time.Time) map[string]map[string]any {
	alive := map[string]bool{}
	kept := map[string]map[string]any{}
	ttl := time.Duration(c.RegistryHours) * time.Hour
	for aid, row := range ids {
		a := str(row["anchor"])
		if _, seen := alive[a]; !seen {
			alive[a] = anchorAlive(a)
		}
		if alive[a] && fresh(row["last"], ttl, now) {
			kept[aid] = row
		}
	}
	return kept
}

func (c Config) continuingLine(latest string, preds map[string]bool, d map[string]any) string {
	var parts, holds []string
	files := map[string]int{}
	for _, project := range c.allProjects() {
		s, err := c.store(project)
		if err != nil {
			continue
		}
		live, err := s.Active("hold", "file", "op")
		if err != nil {
			continue
		}
		for _, l := range live {
			if !preds[l.AgentID] {
				continue
			}
			switch l.Kind {
			case "hold":
				holds = append(holds, project)
			case "file":
				files[project]++
			}
		}
	}
	if len(holds) > 0 {
		parts = append(parts, "holds "+strings.Join(uniqueSorted(holds), ","))
	}
	if len(files) > 0 {
		var fs []string
		for _, p := range sortedKeysInt(files) {
			fs = append(fs, fmt.Sprintf("%s(%d)", p, files[p]))
		}
		parts = append(parts, "leased files "+strings.Join(fs, ","))
	}
	for _, row := range list(d, "messages") {
		state := str(row["state"])
		if state == "closed" || state == "fyi" {
			continue
		}
		if preds[str(row["from"])] {
			if state == "open" {
				parts = append(parts, fmt.Sprintf("awaiting ack from %s on %s", pyStr(row["to"]), pyStr(row["id"])))
			} else {
				parts = append(parts, fmt.Sprintf("ack %s from %s on %s to confirm", pyStr(row["intent"]), pyStr(row["acked_by"]), pyStr(row["id"])))
			}
		} else if state == "open" && toAnyOf(row["to"], preds, d) {
			parts = append(parts, fmt.Sprintf("request %s from %s awaits your ack", pyStr(row["id"]), pyStr(row["from"])))
		}
	}
	if len(parts) == 0 {
		return ""
	}
	shown := parts
	if len(parts) > 4 {
		shown = append(append([]string{}, parts[:4]...), fmt.Sprintf("+%d more: st sessions inbox", len(parts)-4))
	}
	return fmt.Sprintf("continuing %s: %s", latest, strings.Join(shown, "; "))
}

// pyStr renders a value as a Python f-string would (None for a missing key).
func pyStr(v any) string {
	if v == nil {
		return "None"
	}
	return str(v)
}

func uniqueSorted(in []string) []string {
	set := map[string]bool{}
	for _, s := range in {
		set[s] = true
	}
	return sortedKeys(set)
}

func sortedKeysInt(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func toAnyOf(to any, ids map[string]bool, d map[string]any) bool {
	t, ok := to.(string)
	if !ok || t == "" {
		return false
	}
	if ids[t] {
		return true
	}
	if len(t) < 13 {
		return false
	}
	idents := rows(d, "identities")
	for i := range ids {
		if strings.HasPrefix(str(idents[i]["session"]), t) {
			return true
		}
	}
	return false
}

func (c Config) notePeers(d map[string]any, successor string, preds map[string]bool, latest string, now time.Time) {
	peers := map[string]bool{}
	for _, row := range list(d, "messages") {
		state := str(row["state"])
		if state == "closed" || state == "fyi" {
			continue
		}
		if preds[str(row["from"])] && truthy(row["to"]) {
			if truthy(row["acked_by"]) {
				peers[str(row["acked_by"])] = true
			} else {
				peers[str(row["to"])] = true
			}
		} else if toAnyOf(row["to"], preds, d) && truthy(row["from"]) {
			peers[str(row["from"])] = true
		}
	}
	for p := range preds {
		delete(peers, p)
	}
	delete(peers, successor)
	ttl := time.Duration(c.NoteHours) * time.Hour
	var notes []any
	for _, n := range list(d, "notes") {
		if fresh(n["created"], ttl, now) {
			notes = append(notes, n)
		}
	}
	for _, peer := range sortedKeys(peers) {
		dup := false
		for _, n := range notes {
			m := n.(map[string]any)
			if str(m["to"]) == peer && str(m["about"]) == latest {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		notes = append(notes, map[string]any{"to": peer, "about": latest, "created": stamp(now),
			"text": fmt.Sprintf("%s context reset (now %s); resend full ask if pending", latest, successor)})
	}
	if notes == nil {
		notes = []any{}
	}
	d["notes"] = notes
}

// MarkMain records this identity as its harness process's main thread (SessionStart never fires for child threads).
func (c Config) MarkMain(id Identity) {
	_ = c.withCoordLock(func() error {
		d := c.loadDoc()
		ids, _ := d["identities"].(map[string]any)
		row, _ := ids[id.AgentID].(map[string]any)
		if row != nil && !truthy(row["main"]) {
			row["main"] = true
			return c.saveDoc(d)
		}
		return nil
	})
}
