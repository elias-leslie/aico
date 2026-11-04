package lease

import (
	"encoding/json"
	"sort"
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

// seenFor merges the seen sets of every id in the family.
func (h *Hook) seenFor(ids map[string]bool) seenSet {
	out := seenSet{}
	doc := readDoc(seenDoc)
	for id := range ids {
		var one seenSet
		if raw, ok := doc[id]; ok && json.Unmarshal(raw, &one) == nil {
			for k, v := range one {
				out[k] = v
			}
		}
	}
	return out
}

// markSeen records keys as shown to agent now, dropping day-old entries.
func markSeen(agent string, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	return withDocLock(seenDoc, func() error {
		doc := readDoc(seenDoc)
		out := map[string]any{}
		for a, raw := range doc {
			var set seenSet
			if json.Unmarshal(raw, &set) == nil {
				out[a] = set
			}
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
