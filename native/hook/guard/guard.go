// Package guard is the PreToolUse policy of aico-hook: it refuses direct
// publication, hook tampering and a small set of irreversible commands, with
// the same decisions and reason texts as SummitFlow's publication hook. The
// rules (word lists, paths, patterns, reason texts) are data in guard.json.
package guard

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// Result is the guard's answer for one PreToolUse payload.
type Result struct {
	Deny   bool
	Reason string // deny reason shown to the agent
	// Fault is set when the irreversible-command check returned an error and the
	// command was allowed anyway; one line, for the caller to tell the agent.
	Fault string
}

// Evaluate judges one decoded PreToolUse payload. Malformed input, any failure of the publication check, a panic
// anywhere, a command over the size or nesting bounds and an evaluation past the deadline are denials (fail
// closed). Only an error the irreversible check returns (it cannot read the working directory) allows the
// command, reported in Fault, as SummitFlow's hook did: that error would otherwise block every shell.
func (r *Rules) Evaluate(payload map[string]any) Result {
	done := make(chan Result, 1)
	go func() {
		defer func() {
			if recover() != nil {
				done <- Result{Deny: true, Reason: r.reasons.evaluationError}
			}
		}()
		done <- r.evaluate(payload)
	}()
	timer := time.NewTimer(r.deadline)
	defer timer.Stop()
	select {
	case res := <-done:
		return res
	case <-timer.C:
		// The evaluation goroutine is abandoned; aico-hook exits right after answering.
		return Result{Deny: true, Reason: r.reasons.tooSlow}
	}
}

func (r *Rules) evaluate(payload map[string]any) Result {
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
	d, err = r.evaluateIrreversible(command, cwd, 0)
	if err != nil {
		return Result{Fault: fmt.Sprintf("irreversible-command check failed (%v); command allowed unchecked", err)}
	}
	if d.blocked {
		return Result{Deny: true, Reason: d.message}
	}
	return Result{}
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
	if len(text) > r.maxBytes {
		return decision{true, r.reasons.tooLarge}, "", nil
	}
	return r.evaluatePublication(text, 0), text, nil
}

// tooDeep is the denial for a nested command past the nesting bound.
func (r *Rules) tooDeep(depth int) (decision, bool) {
	if depth > r.maxDepth {
		return decision{true, r.reasons.tooDeep}, true
	}
	return decision{}, false
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
