package lease

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var nativeAgentID = regexp.MustCompile(`(?i)(?:agentId|agent_id):\s*([A-Za-z0-9_-]+)`)
var nativeOutput = regexp.MustCompile(`(?m)(?:output_file|outputFile):\s*(/[^\r\n]+)`)

// RecordAgent keeps launch/completion metadata only, in the same Tether document as coordination.
// Missing completion is unfinished, never evidence that an agent should be stopped or redriven.
func (h *Hook) RecordAgent() {
	event, tool := str(h.Payload["hook_event_name"]), str(h.Payload["tool_name"])
	if event != "SubagentStart" && event != "SubagentStop" && tool != "Agent" && tool != "Task" {
		return
	}
	input, _ := h.Payload["tool_input"].(map[string]any)
	response, _ := h.Payload["tool_response"].(map[string]any)
	id := str(h.Payload["agent_id"])
	if tool == "Agent" || tool == "Task" {
		id = str(response["agentId"])
		if id == "" {
			id = str(response["agent_id"])
		}
		if id == "" {
			if m := nativeAgentID.FindStringSubmatch(str(h.Payload["tool_response"])); len(m) > 1 {
				id = m[1]
			}
		}
	}
	call := str(h.Payload["tool_use_id"])
	if id == "" {
		id = call
	}
	if id == "" {
		return
	}
	transcript := str(h.Payload["agent_transcript_path"])
	for _, field := range []string{"outputFile", "output_file", "transcript_path"} {
		if p := str(response[field]); p != "" {
			transcript = p
		}
	}
	if transcript == "" {
		if m := nativeOutput.FindStringSubmatch(str(h.Payload["tool_response"])); len(m) > 1 {
			transcript = strings.TrimSpace(m[1])
		}
	}
	_ = h.Cfg.withCoordLock(func() error {
		doc := h.Cfg.loadDoc()
		children := rows(doc, "native_children")
		key := h.ID.SessionID + "/" + id
		row := children[key]
		if row == nil {
			row = map[string]any{"id": id, "parent_session": h.ID.SessionID, "started": stamp(time.Now())}
		}
		if call != "" && call != id {
			if earlier := children[h.ID.SessionID+"/"+call]; earlier != nil {
				row["started"] = earlier["started"]
			}
			delete(children, h.ID.SessionID+"/"+call)
		}
		widget := h.ID.env["AICO_WIDGET_ID"]
		if widget == "" {
			widget = widgetFor(h.ID.Anchor)
		}
		row["widget"] = widget
		if kind := str(input["subagent_type"]); kind != "" {
			row["agent_type"] = kind
		}
		if kind := str(h.Payload["agent_type"]); kind != "" {
			row["agent_type"] = kind
		}
		if filepath.IsAbs(transcript) {
			row["transcript"] = filepath.Clean(transcript)
		}
		if event == "SubagentStop" || event == "PostToolUseFailure" || (event == "PostToolUse" && !truthy(input["run_in_background"]) && str(response["status"]) != "async_launched") {
			row["finished"] = stamp(time.Now())
		}
		children[key] = row
		doc["native_children"] = toAny(children)
		return h.Cfg.saveDoc(doc)
	})
}

func (h *Hook) UnfinishedChildren() []string {
	var out []string
	children := rows(h.Cfg.loadDoc(), "native_children")
	widget := h.ID.env["AICO_WIDGET_ID"]
	if widget == "" {
		widget = widgetFor(h.ID.Anchor)
	}
	for _, key := range sortedKeysOfSessions(children) {
		child := children[key]
		if (str(child["parent_session"]) != h.ID.SessionID && (widget == "" || str(child["widget"]) != widget)) || str(child["finished"]) != "" {
			continue
		}
		changed := "transcript last write unknown"
		if stat, err := os.Stat(str(child["transcript"])); err == nil {
			changed = "transcript last write " + age(stamp(stat.ModTime()), time.Now()) + " ago"
		}
		out = append(out, fmt.Sprintf("Native child %s (%s) started but has no completion notice; %s. Silence does not prove it ended.", str(child["id"]), str(child["agent_type"]), changed))
	}
	return out
}
