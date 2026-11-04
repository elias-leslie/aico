// Package guard is the PreToolUse policy of aico-hook: it refuses direct
// publication, hook tampering and a small set of irreversible commands, with
// the same decisions and reason texts as SummitFlow's publication hook. The
// rules (word lists, paths, patterns, reason texts) are data in guard.json.
package guard

import (
	"errors"
	"fmt"
	"strings"
)

// Result is the guard's answer for one PreToolUse payload.
type Result struct {
	Deny   bool
	Reason string // deny reason shown to the agent
	// Fault is set when the irreversible-command check broke and the command
	// was allowed anyway (that check fails open); one line, for the caller to tell the agent.
	Fault string
}

// Evaluate judges one decoded PreToolUse payload. Malformed input and any
// failure of the publication check are denials (fail closed); a failure of the
// irreversible check allows the command and reports itself in Fault.
func (r *Rules) Evaluate(payload map[string]any) (res Result) {
	defer func() {
		if recover() != nil {
			res = Result{Deny: true, Reason: r.reasons.evaluationError}
		}
	}()
	d, command, err := r.evaluatePayload(payload)
	if err != nil {
		return Result{Deny: true, Reason: r.reasons.evaluationError}
	}
	if d.blocked {
		return Result{Deny: true, Reason: d.message}
	}
	if command == "" {
		return Result{}
	}
	cwd, _ := payload["cwd"].(string)
	return r.irreversible(command, cwd)
}

// evaluatePayload is the publication check. It returns the shell command to
// run the irreversible check on ("" when the payload carries none).
func (r *Rules) evaluatePayload(payload map[string]any) (decision, string, error) {
	toolInput, ok := payload["tool_input"].(map[string]any)
	if !ok {
		return decision{}, "", errors.New("Missing tool input")
	}
	tool := ""
	if v, present := payload["tool_name"]; present {
		tool = pyLower(pyStr(v))
	}
	command, present := toolInput["command"]
	if !present {
		command = toolInput["cmd"]
	}
	if list, isList := command.([]any); isList {
		if words, allStrings := stringList(list); allStrings {
			command = shlexJoin(words)
		}
	}
	if command == nil {
		// Non-shell hooks may match GitHub connector tools directly.
		for _, w := range r.connectorMutations {
			if strings.Contains(tool, w) {
				return r.blockedPublication(), "", nil
			}
		}
		for _, w := range r.shellTools {
			if strings.Contains(tool, w) {
				return decision{}, "", errors.New("Missing shell command")
			}
		}
		return allow(), "", nil
	}
	text, isStr := command.(string)
	if !isStr || pyStrip(text) == "" {
		return decision{}, "", errors.New("Invalid command")
	}
	return r.evaluatePublication(text), text, nil
}

func stringList(list []any) ([]string, bool) {
	words := make([]string, len(list))
	for i, item := range list {
		s, ok := item.(string)
		if !ok {
			return nil, false
		}
		words[i] = s
	}
	return words, true
}

// irreversible runs the fail-open check for a command that passed publication.
func (r *Rules) irreversible(command, cwd string) (res Result) {
	defer func() {
		if p := recover(); p != nil {
			res = Result{Fault: fmt.Sprintf("irreversible-command check failed (%v); command allowed unchecked", p)}
		}
	}()
	d, err := r.evaluateIrreversible(command, cwd)
	if err != nil {
		return Result{Fault: fmt.Sprintf("irreversible-command check failed (%v); command allowed unchecked", err)}
	}
	if d.blocked {
		return Result{Deny: true, Reason: d.message}
	}
	return Result{}
}

// pyStr is str(value) for the substring tests on tool_name: strings as they
// are, containers by the strings inside them.
func pyStr(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, it := range x {
			parts[i] = pyStr(it)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case map[string]any:
		parts := make([]string, 0, len(x))
		for k, it := range x {
			parts = append(parts, k+": "+pyStr(it))
		}
		return "{" + strings.Join(parts, ", ") + "}"
	default:
		return fmt.Sprint(x)
	}
}
