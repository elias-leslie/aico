// Package lease is the coordination side of aico-hook: edit leases, writer sets,
// shell-write attribution and the identity registry, on the stores `st lease`,
// `st sessions` and `st commit` read (~/.summitflow/leases, SummitFlow
// cli/lib/leases.py and coord_lineage.py) until M10a moves them. Field names,
// file names, locks and timestamps stay as SummitFlow writes them.
package lease

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// Config is the decided part of the coordination policy (data/hook.json "lease").
type Config struct {
	Dir             string `json:"dir"`               // default ~/.summitflow/leases; ST_LEASES_DIR overrides
	IdleTTLMinutes  int    `json:"idle_ttl_minutes"`  // a file/hold lease idle this long is released
	ActiveMinutes   int    `json:"active_minutes"`    // reserved: st's ACTIVE_WINDOW
	RegistryHours   int    `json:"registry_hours"`    // identity rows kept this long after last use
	NoteHours       int    `json:"note_hours"`        // peer reset notes kept this long
	UnackedMinutes  int    `json:"unacked_minutes"`   // a request unanswered this long surfaces once to its sender
	SnapshotMaxMins int    `json:"snapshot_max_mins"` // stale shell snapshots are removed after this
	RegistrySaveSec int    `json:"registry_save_sec"` // registry rows are rewritten at most this often
}

// withDefaults puts st's values in place of a missing, zero or negative window: with a zero idle TTL every lease
// would count as stale and the next save would delete other agents' leases (likewise registry rows and notes).
func (c Config) withDefaults() Config {
	for _, f := range []struct {
		v   *int
		def int
	}{{&c.IdleTTLMinutes, 30}, {&c.ActiveMinutes, 10}, {&c.RegistryHours, 24}, {&c.NoteHours, 24},
		{&c.UnackedMinutes, 10}, {&c.SnapshotMaxMins, 120}, {&c.RegistrySaveSec, 60}} {
		if *f.v <= 0 {
			*f.v = f.def
		}
	}
	return c
}

func (c Config) idleTTL() time.Duration { return time.Duration(c.IdleTTLMinutes) * time.Minute }

// Dir is where the stores live.
func (c Config) dir() string {
	if v := os.Getenv("ST_LEASES_DIR"); v != "" {
		return v
	}
	if c.Dir != "" {
		return expandHome(c.Dir)
	}
	return filepath.Join(home(), ".summitflow", "leases")
}

func home() string {
	if h := os.Getenv("HOME"); h != "" {
		return h
	}
	h, _ := os.UserHomeDir()
	return h
}

func expandHome(p string) string {
	if p == "~" {
		return home()
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home(), p[2:])
	}
	return p
}

// Lease is one row of <project>.json, in leases.py's dataclass field order.
type Lease struct {
	LeaseID       string   `json:"lease_id"`
	AgentID       string   `json:"agent_id"`
	AgentSlug     string   `json:"agent_slug"`
	SessionID     string   `json:"session_id"`
	Provider      string   `json:"provider"`
	Globs         []string `json:"globs"`
	TaskID        *string  `json:"task_id"`
	AcquiredAt    string   `json:"acquired_at"`
	LastHeartbeat string   `json:"last_heartbeat"`
	TakenOverBy   *string  `json:"taken_over_by"`
	Kind          string   `json:"kind"`
	Purpose       *string  `json:"purpose"`
	PID           *int     `json:"pid"`
	PIDStart      *string  `json:"pid_start"`
	Sensitive     bool     `json:"sensitive"`
	Anchor        *string  `json:"anchor"`
}

var leaseFields = map[string]bool{
	"lease_id": true, "agent_id": true, "agent_slug": true, "session_id": true, "provider": true, "globs": true,
	"task_id": true, "acquired_at": true, "last_heartbeat": true, "taken_over_by": true, "kind": true,
	"purpose": true, "pid": true, "pid_start": true, "sensitive": true, "anchor": true,
}
var requiredFields = []string{"lease_id", "agent_id", "agent_slug", "session_id", "provider", "globs", "task_id",
	"acquired_at", "last_heartbeat"}

func (l *Lease) anchor() string {
	if l.Anchor == nil {
		return ""
	}
	return *l.Anchor
}

func (l *Lease) stale(now time.Time, ttl time.Duration) bool {
	if l.Kind == "op" {
		start := ""
		if l.PIDStart != nil {
			start = *l.PIDStart
		}
		return l.PID == nil || !processAlive(*l.PID, start)
	}
	hb, ok := parseStamp(l.LastHeartbeat)
	return !ok || now.Sub(hb) > ttl
}

// Matches is fnmatch(path, glob) or fnmatch(path, glob/**) for any glob, as leases.py does.
func (l *Lease) Matches(path string) bool {
	for _, g := range l.Globs {
		if fnmatch(path, g) || fnmatch(path, strings.TrimRight(g, "/")+"/**") {
			return true
		}
	}
	return false
}

// fnmatch is Python's fnmatch.fnmatchcase: * and ? cross "/", [seq] and [!seq] are classes.
func fnmatch(name, pattern string) bool {
	re, err := regexp.Compile(translate(pattern))
	return err == nil && re.MatchString(name)
}

func translate(pat string) string {
	var b strings.Builder
	b.WriteString(`(?s)^`)
	for i := 0; i < len(pat); {
		c := pat[i]
		i++
		switch c {
		case '*':
			b.WriteString(`.*`)
			for i < len(pat) && pat[i] == '*' {
				i++
			}
		case '?':
			b.WriteString(`.`)
		case '[':
			j := i
			if j < len(pat) && pat[j] == '!' {
				j++
			}
			if j < len(pat) && pat[j] == ']' {
				j++
			}
			for j < len(pat) && pat[j] != ']' {
				j++
			}
			if j >= len(pat) {
				b.WriteString(`\[`)
				continue
			}
			stuff := pat[i:j]
			i = j + 1
			stuff = strings.ReplaceAll(stuff, `\`, `\\`)
			if strings.HasPrefix(stuff, "!") {
				stuff = "^" + stuff[1:]
			} else if strings.HasPrefix(stuff, "^") {
				stuff = `\` + stuff
			}
			b.WriteString("[" + stuff + "]")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString(`$`)
	return b.String()
}

// Store is one project's lease file, read and written under its flock.
type Store struct {
	cfg     Config
	project string
}

var projectID = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)

func (c Config) store(project string) (*Store, error) {
	if !projectID.MatchString(project) {
		return nil, fmt.Errorf("invalid project id: %q", project)
	}
	return &Store{cfg: c.withDefaults(), project: project}, nil
}

func (s *Store) path(suffix string) string { return filepath.Join(s.cfg.dir(), s.project+suffix) }

// withLock runs fn under the project's exclusive flock (leases._lock).
func (s *Store) withLock(fn func() error) error { return lockFile(s.path(".lock"), fn) }

func lockFile(path string, fn func() error) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN) //nolint:errcheck
	return fn()
}

// Writers maps an absolute path to its writer entries ({agent_id, session_id, anchor, at, sensitive[, reason, by]}).
type Writers map[string][]map[string]any

type doc struct {
	leases  []Lease
	writers Writers
}

func (s *Store) read() map[string]json.RawMessage {
	raw, err := os.ReadFile(s.path(".json"))
	if err != nil {
		return map[string]json.RawMessage{}
	}
	var out map[string]json.RawMessage
	if json.Unmarshal(raw, &out) != nil || out == nil {
		return map[string]json.RawMessage{}
	}
	return out
}

func (s *Store) load() doc {
	raw := s.read()
	var d doc
	var items []map[string]json.RawMessage
	_ = json.Unmarshal(raw["leases"], &items)
	for _, item := range items {
		if !validLease(item) {
			continue
		}
		buf, _ := json.Marshal(item)
		var l Lease
		if json.Unmarshal(buf, &l) == nil {
			if l.Kind == "" {
				l.Kind = "file"
			}
			d.leases = append(d.leases, l)
		}
	}
	d.writers = loadWriters(raw, s.cfg)
	return d
}

func validLease(item map[string]json.RawMessage) bool {
	for k := range item {
		if !leaseFields[k] {
			return false // Lease(**item) raises TypeError: leases.py skips the row
		}
	}
	for _, k := range requiredFields {
		if _, ok := item[k]; !ok {
			return false
		}
	}
	return true
}

func loadWriters(raw map[string]json.RawMessage, _ Config) Writers {
	out := Writers{}
	var w map[string][]any
	_ = json.Unmarshal(raw["writers"], &w)
	for path, entries := range w {
		for _, e := range entries {
			if m, ok := e.(map[string]any); ok && truthy(m["agent_id"]) {
				out[path] = append(out[path], m)
			}
		}
	}
	// Legacy last-writer records ("touches") fold into the writer sets for 24 h.
	var touches map[string]any
	_ = json.Unmarshal(raw["touches"], &touches)
	now := time.Now().UTC()
	for path, t := range touches {
		m, ok := t.(map[string]any)
		if !ok || !truthy(m["agent_id"]) {
			continue
		}
		if at, ok := parseStamp(str(m["at"])); ok && now.Sub(at) <= 24*time.Hour {
			addWriter(out, path, m)
		}
	}
	for path, entries := range out {
		if len(entries) == 0 {
			delete(out, path)
		}
	}
	return out
}

func addWriter(w Writers, path string, entry map[string]any) {
	kept := w[path][:0:0]
	for _, e := range w[path] {
		if str(e["agent_id"]) != str(entry["agent_id"]) {
			kept = append(kept, e)
		}
	}
	w[path] = append(kept, entry)
}

// save writes the leases and the writer sets, as leases._save (caller holds the lock).
func (s *Store) save(d doc) error {
	leases := d.leases
	if leases == nil {
		leases = []Lease{}
	}
	out := struct {
		Leases  []Lease `json:"leases"`
		Writers Writers `json:"writers,omitempty"`
	}{leases, d.writers}
	buf, err := marshal(out, "  ")
	if err != nil {
		return err
	}
	return replaceFile(s.path(".json"), s.path(".tmp"), buf)
}

func marshal(v any, indent string) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", indent)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

func replaceFile(path, tmp string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Store) purge(leases []Lease) []Lease {
	now := time.Now().UTC()
	out := leases[:0:0]
	for _, l := range leases {
		if !l.stale(now, s.cfg.idleTTL()) {
			out = append(out, l)
		}
	}
	return out
}

// Active returns the live leases of the given kinds, purging stale rows (leases.list_active).
func (s *Store) Active(kinds ...string) ([]Lease, error) {
	var out []Lease
	err := s.withLock(func() error {
		d := s.load()
		live := s.purge(d.leases)
		if len(live) != len(d.leases) {
			d.leases = live
			if err := s.save(d); err != nil {
				return err
			}
		}
		for _, l := range live {
			for _, k := range kinds {
				if l.Kind == k {
					out = append(out, l)
					break
				}
			}
		}
		return nil
	})
	return out, err
}

// allProjects lists the project stores (leases.all_projects).
func (c Config) allProjects() []string {
	entries, _ := os.ReadDir(c.dir())
	var out []string
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".json") && !strings.HasPrefix(name, "_") {
			out = append(out, strings.TrimSuffix(name, ".json"))
		}
	}
	return out
}

// ---------------------------------------------------------------- time, procs, helpers

const isoLayout = "2006-01-02T15:04:05.000000-07:00"

func stamp(t time.Time) string { return t.UTC().Format(isoLayout) }

func parseStamp(s string) (time.Time, bool) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, true
	}
	if t, err := time.Parse("2006-01-02T15:04:05.999999999", s); err == nil {
		return t.UTC(), true
	}
	return time.Time{}, false
}

// processStart is the kernel start tick of pid (/proc/<pid>/stat field 22).
func processStart(pid int) (string, bool) {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", false
	}
	s := string(raw)
	i := strings.LastIndex(s, ")")
	if i < 0 {
		return "", false
	}
	f := strings.Fields(s[i+1:])
	if len(f) < 20 {
		return "", false
	}
	return f[19], true
}

func processAlive(pid int, start string) bool {
	if pid <= 0 {
		return false
	}
	got, ok := processStart(pid)
	return ok && got == start
}

func newID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}

func str(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "True"
		}
		return "False"
	case float64:
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprint(x)
	}
	return fmt.Sprint(v)
}

func ptr[T any](v T) *T { return &v }

var errNoProject = errors.New("no project")
