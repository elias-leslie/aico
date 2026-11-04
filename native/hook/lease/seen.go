package lease

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// What each agent's hook has shown it already, content free: "<request id>:req", ":fyi", ":ack:<acked_at>".
// One document ("_seen"), {agent id: {key: epoch seconds}}, entries kept a day.

const (
	seenDoc  = "_seen"
	seenKeep = 24 * time.Hour
)

type seenSet map[string]float64

func (s seenSet) has(key string) bool { _, ok := s[key]; return ok }

func loadSeen(agent string) seenSet {
	out := seenSet{}
	if raw, ok := readDoc(seenDoc)[agent]; ok {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}

// seenFor merges the seen sets of every id in the family. When the store does not answer it is an error, not an
// empty set: the caller then shows nothing this turn rather than everything again.
func (h *Hook) seenFor(ids map[string]bool) (seenSet, error) {
	out := seenSet{}
	doc, err := loadDocErr(seenDoc)
	if err != nil {
		return nil, err
	}
	for id := range ids {
		var one seenSet
		if raw, ok := doc[id]; ok && json.Unmarshal(raw, &one) == nil {
			for k, v := range one {
				out[k] = v
			}
		}
	}
	return out, nil
}

// seenDocument is the "_seen" document as {agent: set}, read inside a change (an error when it cannot be read).
func seenDocument() (map[string]any, error) {
	doc, err := loadDocErr(seenDoc)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	for a, raw := range doc {
		var set seenSet
		if json.Unmarshal(raw, &set) == nil {
			out[a] = set
		}
	}
	return out, nil
}

// markSeen records keys as shown to agent now, dropping day-old entries.
func markSeen(agent string, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	return updateDoc(seenDoc, func() error {
		out, err := seenDocument()
		if err != nil {
			return err
		}
		set, _ := out[agent].(seenSet)
		if set == nil {
			set = seenSet{}
			out[agent] = set
		}
		now := float64(time.Now().UnixNano()) / 1e9
		for _, k := range keys {
			set[k] = now
		}
		cutoff := now - seenKeep.Seconds()
		for a, v := range out {
			s := v.(seenSet)
			for k, t := range s {
				if t < cutoff {
					delete(s, k)
				}
			}
			if len(s) == 0 {
				delete(out, a)
			}
		}
		return writeDoc(seenDoc, out)
	})
}

// seenKeys is for tests and pulse: the keys an agent has seen, sorted.
func seenKeys(agent string) []string {
	var out []string
	for k := range loadSeen(agent) {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ImportLegacySeen carries what SummitFlow's inbox hook had shown each agent (<dir>/<agent>.seen.json, the
// agent id with ":" written "_") into the "_seen" document, keeping the later time per key, so items an agent
// has already seen are not shown again after the cutover. It returns the agents imported.
func ImportLegacySeen(dir string) ([]string, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.seen.json"))
	if err != nil {
		return nil, err
	}
	var done []string
	err = updateDoc(seenDoc, func() error {
		done = nil
		out, err := seenDocument()
		if err != nil {
			return err
		}
		cutoff := float64(time.Now().Add(-seenKeep).UnixNano()) / 1e9
		for _, f := range files {
			raw, err := os.ReadFile(f)
			if err != nil {
				continue
			}
			var old seenSet
			if json.Unmarshal(raw, &old) != nil {
				continue
			}
			agent := strings.TrimSuffix(filepath.Base(f), ".seen.json")
			if prefix, rest, ok := strings.Cut(agent, "_"); ok {
				agent = prefix + ":" + rest
			}
			set, _ := out[agent].(seenSet)
			if set == nil {
				set = seenSet{}
				out[agent] = set
			}
			for k, t := range old {
				if t >= cutoff && t > set[k] {
					set[k] = t
				}
			}
			done = append(done, agent)
		}
		return writeDoc(seenDoc, out)
	})
	return done, err
}
