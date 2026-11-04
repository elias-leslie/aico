package lease

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The `aico lease` verbs: the same leases the edit hook writes (st lease's semantics, leases.py), run by the
// agent's own hook identity (New with an empty payload resolves it from the harness process and environment).

// CLIProject is the project a verb acts on: ST_PROJECT_ID, else the one owning the current directory; root is
// what relative globs resolve against.
func CLIProject() (Project, error) {
	cwd, _ := os.Getwd()
	here, ok := ProjectFor(cwd)
	if id := os.Getenv("ST_PROJECT_ID"); id != "" {
		if ok && here.ID == id {
			return here, nil
		}
		return Project{ID: id, Root: here.Root}, nil
	}
	if !ok {
		return Project{}, fmt.Errorf("No project detected. Run inside a registered project or set ST_PROJECT_ID.")
	}
	return here, nil
}

func projectPath(path, root string) string {
	if root != "" && !filepath.IsAbs(path) {
		path = filepath.Join(root, path)
	}
	return filepath.Clean(path)
}

func (h *Hook) storeFor(project string) (*Store, error) { return h.Cfg.store(project) }

// self is who this agent is for ownership: its ids and the harness anchor that ties its context resets together.
func (h *Hook) self() (mine map[string]bool, anchor string) {
	lin := h.lineage()
	return lin.SelfIDs(h.ID), lin.MyAnchor()
}

// Acquire leases globs to this agent, or extends the lease it already has on that glob set.
func (h *Hook) Acquire(project, root string, globs []string, task string) (Lease, error) {
	s, err := h.storeFor(project)
	if err != nil {
		return Lease{}, err
	}
	for i, g := range globs {
		globs[i] = projectPath(g, root)
	}
	_, anchor := h.self()
	now := stamp(time.Now())
	var out Lease
	err = s.withLock(func() error {
		d := s.load()
		d.leases = s.purge(d.leases)
		for i := range d.leases {
			l := &d.leases[i]
			if l.Kind == "file" && l.AgentID == h.ID.AgentID && sameSet(l.Globs, globs) {
				l.LastHeartbeat = now
				if task != "" && l.TaskID == nil {
					l.TaskID = ptr(task)
				}
				out = *l
				return s.save(d)
			}
		}
		out = Lease{LeaseID: newID(), AgentID: h.ID.AgentID, AgentSlug: h.ID.Slug, SessionID: h.ID.SessionID,
			Provider: h.ID.Provider, Globs: globs, AcquiredAt: now, LastHeartbeat: now, Kind: "file"}
		if task != "" {
			out.TaskID = ptr(task)
		}
		if anchor != "" {
			out.Anchor = ptr(anchor)
		}
		d.leases = append(d.leases, out)
		return s.save(d)
	})
	return out, err
}

func sameSet(a, b []string) bool {
	m := map[string]bool{}
	for _, x := range a {
		m[x] = true
	}
	n := map[string]bool{}
	for _, x := range b {
		n[x] = true
	}
	if len(m) != len(n) {
		return false
	}
	for k := range m {
		if !n[k] {
			return false
		}
	}
	return true
}

// Hold marks the whole repo with a coarse purpose (a "hold": others' commit, publish and rebuild need an ack).
func (h *Hook) Hold(project, root, purpose string) (Lease, error) {
	s, err := h.storeFor(project)
	if err != nil {
		return Lease{}, err
	}
	if len(purpose) > 40 {
		purpose = purpose[:40]
	}
	mine, anchor := h.self()
	now := stamp(time.Now())
	l := Lease{LeaseID: newID(), AgentID: h.ID.AgentID, AgentSlug: h.ID.Slug, SessionID: h.ID.SessionID,
		Provider: h.ID.Provider, Globs: []string{strings.TrimRight(filepath.Clean(root), "/") + "/**"},
		AcquiredAt: now, LastHeartbeat: now, Kind: "hold", Purpose: ptr(purpose), Sensitive: h.ID.sensitive()}
	if anchor != "" {
		l.Anchor = ptr(anchor)
	}
	return l, s.withLock(func() error {
		d := s.load()
		var keep []Lease
		for _, x := range s.purge(d.leases) {
			if !(x.Kind == "hold" && isMine(x, mine, anchor)) {
				keep = append(keep, x)
			}
		}
		d.leases = append(keep, l)
		return s.save(d)
	})
}

// Heartbeat touches this agent's leases and returns how many.
func (h *Hook) Heartbeat(project string) (int, error) {
	s, err := h.storeFor(project)
	if err != nil {
		return 0, err
	}
	mine, anchor := h.self()
	now := stamp(time.Now())
	n := 0
	err = s.withLock(func() error {
		d := s.load()
		d.leases = s.purge(d.leases)
		for i := range d.leases {
			if isMine(d.leases[i], mine, anchor) {
				d.leases[i].LastHeartbeat = now
				n++
			}
		}
		return s.save(d)
	})
	return n, err
}

// Release drops this agent's leases: all (glob ""), one lease id, or one glob (only that glob of a multi-glob
// lease). It returns the count released; an op lease belongs to the process that holds it and stays.
func (h *Hook) Release(project, root, glob string, all bool) (int, error) {
	s, err := h.storeFor(project)
	if err != nil {
		return 0, err
	}
	mine, anchor := h.self()
	n := 0
	err = s.withLock(func() error {
		d := s.load()
		live := s.purge(d.leases)
		before := len(live)
		if all {
			var keep []Lease
			for _, l := range live {
				if !(l.Kind != "op" && isMine(l, mine, anchor)) {
					keep = append(keep, l)
				}
			}
			d.leases, n = keep, before-len(keep)
			return s.save(d)
		}
		for _, l := range live {
			if l.LeaseID == glob && l.Kind != "op" && isMine(l, mine, anchor) {
				var keep []Lease
				for _, x := range live {
					if x.LeaseID != glob {
						keep = append(keep, x)
					}
				}
				d.leases, n = keep, 1
				return s.save(d)
			}
		}
		target := projectPath(glob, root)
		var keep []Lease
		for _, l := range live {
			if isMine(l, mine, anchor) && contains(l.Globs, target) {
				n++
				var rest []string
				for _, g := range l.Globs {
					if g != target {
						rest = append(rest, g)
					}
				}
				l.Globs = rest
				if len(rest) == 0 {
					continue
				}
			}
			keep = append(keep, l)
		}
		d.leases = keep
		return s.save(d)
	})
	return n, err
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// Take claims a path from whoever holds it: their file leases on it go, then it is leased to this agent and
// its dirty change is adopted (other writers no longer block this agent's commit of it).
func (h *Hook) Take(project, root, path string) (Lease, error) {
	s, err := h.storeFor(project)
	if err != nil {
		return Lease{}, err
	}
	path = projectPath(path, root)
	mine, anchor := h.self()
	err = s.withLock(func() error {
		d := s.load()
		var keep []Lease
		for _, l := range s.purge(d.leases) {
			if l.Kind != "op" && l.Matches(path) && !isMine(l, mine, anchor) {
				continue
			}
			keep = append(keep, l)
		}
		d.leases = keep
		return s.save(d)
	})
	if err != nil {
		return Lease{}, err
	}
	l, err := h.Acquire(project, "", []string{path}, "")
	if err != nil {
		return l, err
	}
	return l, s.withLock(func() error {
		d := s.load()
		for i := range d.leases {
			if d.leases[i].LeaseID == l.LeaseID {
				d.leases[i].TakenOverBy = ptr(h.ID.AgentID)
			}
		}
		if d.writers == nil {
			d.writers = Writers{}
		}
		d.writers[path] = []map[string]any{h.writerEntry("", nil)}
		return s.save(d)
	})
}

// Listed is one live lease in `aico lease --list`: the pulse line for a file lease, the holder line for a mark.
func (h *Hook) Listed(project string, kinds ...string) ([]string, error) {
	s, err := h.storeFor(project)
	if err != nil {
		return nil, err
	}
	live, err := s.Active(kinds...)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, l := range live {
		out = append(out, h.LeaseLine(project, l, ""))
	}
	return out, nil
}

// LeaseLine: "agent · lease:'globs' · task:id · idle:2m" for a file lease, else the holder line.
func (h *Hook) LeaseLine(project string, l Lease, root string) string {
	if l.Kind != "file" {
		return h.holderLine(project, l, root)
	}
	task := "--"
	if l.TaskID != nil && *l.TaskID != "" {
		task = *l.TaskID
	}
	return fmt.Sprintf("%s · lease:'%s' · task:%s · idle:%s", l.AgentID, strings.Join(l.Globs, ", "), task,
		age(l.LastHeartbeat, time.Now().UTC()))
}

// SystemLines is one holder line per live hold, op or file lease across projects (st lease --list --all).
func (h *Hook) SystemLines() []string {
	names := h.Cfg.allProjects()
	sort.Strings(names)
	var out []string
	for _, name := range names {
		s, err := h.storeFor(name)
		if err != nil {
			continue
		}
		live, err := s.Active("op", "hold", "file")
		if err != nil {
			continue
		}
		for _, l := range live {
			out = append(out, h.holderLine(name, l, ""))
		}
	}
	return out
}

// Check claims a path before a write the edit hook does not see: "BLOCKED: ..." under a live op, "WARNING: ..."
// for another agent's lease, else "".
func (h *Hook) Check(path string) (blocked bool, line string) {
	if b, text := (&Hook{Cfg: h.Cfg, Payload: map[string]any{"tool_input": map[string]any{"file_path": path}}, ID: h.ID}).Edit(); b || text != "" {
		return b, text
	}
	return false, ""
}

// SelfIDs are the agent ids this agent answers to (its own and those of earlier contexts in the same harness).
func (h *Hook) SelfIDs() map[string]bool { m, _ := h.self(); return m }
