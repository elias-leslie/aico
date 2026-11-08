package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"

	"aico/hook/guard"
	"aico/hook/lease"
)

// aico-hook agy EVENT: Antigravity's command hooks (~/.gemini/config/hooks.json), one event per call. Its payload
// is its own JSON (toolCall, conversationId, workspacePaths); this turns it into the Claude-style payload the guard
// and leases read, adds the leash, and answers in agy's form: {"decision":"ask"} or {"decision":"deny","reason":...}.
//
// agy treats a hook that fails (non-zero exit, bad JSON, timeout, not found) as "go ahead" (seen live, agy 1.5.3).
// So only a printed deny stops a tool, and on any fault here the answer for a tool call is a deny. A missing binary
// or hooks.json can't answer at all: Tether checks both before it starts an agy session (agy.ts).
//
// "ask" leaves the call to agy's own permissions: a session's skip-permissions flag runs it, the deny rules of a
// one-shot `agy -p` still stop it. An empty answer doesn't mean that: agy -p refuses the tool (seen live, agy 1.5.3).

// agyTool maps agy's tool names to the names the guard and lease hook know.
var agyTool = map[string]string{"run_command": "Bash", "write_file": "Write", "edit_file": "Edit"}

const agyDeadlineNote = "aico-hook could not check this call"

const agyGoAhead = `{"decision":"ask"}`

func agyMain(args []string) int {
	event := ""
	if len(args) > 0 {
		event = args[0]
	}
	raw, _ := io.ReadAll(os.Stdin)
	var in map[string]any
	_ = json.Unmarshal(raw, &in)
	fmt.Println(agyAnswer(event, in))
	return 0
}

func agyAnswer(event string, in map[string]any) (answer string) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "aico-hook agy crashed: %v\n%s", r, debug.Stack())
			answer = "{}"
			if event == "PreToolUse" {
				answer = agyDeny(agyDeadlineNote + fmt.Sprintf(" (it crashed: %v), so it was refused. Tell the owner.", r))
			}
		}
	}()
	switch event {
	case "PreToolUse":
		return agyPreTool(in)
	case "PostToolUse":
		if in != nil && agyLaunched() {
			agyDispatch("PostToolUse", in)
		}
	case "SessionStart":
		if in != nil && agyLaunched() {
			return agyInject(agyStart(in))
		}
	case "PreInvocation":
		if in != nil && agyLaunched() {
			return agyInject(agyInbox(in))
		}
	}
	return "{}"
}

func agyDeny(reason string) string {
	return mustJSON(map[string]any{"decision": "deny", "reason": reason})
}

func agyInject(text string) string {
	if text == "" {
		return "{}"
	}
	return mustJSON(map[string]any{"injectSteps": []any{map[string]any{"systemMessage": map[string]any{"systemMessage": text}}}})
}

// agyPayload is the Claude-style payload for one agy call. A file tool's path reaches the lease hook as file_path.
func agyPayload(event string, in map[string]any) map[string]any {
	out := map[string]any{"hook_event_name": event, "session_id": str(in["conversationId"]), "cwd": agyCwd(in),
		"transcript_path": str(in["transcriptPath"])}
	call, _ := in["toolCall"].(map[string]any)
	if call == nil {
		return out
	}
	name := str(call["name"])
	args, _ := call["args"].(map[string]any)
	input := map[string]any{}
	if command, ok := args["CommandLine"]; ok {
		input["command"] = command
	}
	if path := str(args["Path"]); path != "" {
		input["file_path"] = path
	}
	if mapped, ok := agyTool[name]; ok {
		name = mapped
	}
	out["tool_name"], out["tool_input"] = name, input
	return out
}

// agyCwd is where a shell command starts: the call's own Cwd, else agy's first folder (it works in that one).
func agyCwd(in map[string]any) string {
	if call, _ := in["toolCall"].(map[string]any); call != nil {
		if args, _ := call["args"].(map[string]any); args != nil {
			if cwd := str(args["Cwd"]); cwd != "" {
				return cwd
			}
		}
	}
	if roots := agyRoots(in); len(roots) > 0 {
		return roots[0]
	}
	cwd, _ := os.Getwd()
	return cwd
}

func agyRoots(in map[string]any) []string {
	list, _ := in["workspacePaths"].([]any)
	var out []string
	for _, v := range list {
		if s := str(v); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// agyPreTool: the leash, then the guard and leases. A lease warning can't be shown on an allowed call in agy's
// form, so an edit of a file another agent is working on is refused instead, which is the safer way round here.
func agyPreTool(in map[string]any) string {
	if in == nil {
		return agyDeny(agyDeadlineNote + " (its input wasn't readable), so it was refused. Tell the owner.")
	}
	rules, err := loadRules()
	if err != nil {
		return agyDeny(fmt.Sprintf("%s (guard rules: %v), so it was refused. Tell the owner.", agyDeadlineNote, err))
	}
	leash, err := guard.LoadLeash(filepath.Join(dataDir(), "leash.json"), rules)
	if err != nil {
		return agyDeny(fmt.Sprintf("%s (limits: %v), so it was refused. Tell the owner.", agyDeadlineNote, err))
	}
	if why := leash.Check(agyCall(in)); why != "" {
		return agyDeny(why)
	}
	payload := agyPayload("PreToolUse", in)
	raw, _ := json.Marshal(payload)
	out := handle("agy", "PreToolUse", payload, raw)
	if out.Deny != "" {
		return agyDeny(out.Deny)
	}
	if name := str(payload["tool_name"]); name == "Write" || name == "Edit" {
		for _, line := range out.Context {
			return agyDeny(line)
		}
	}
	return agyGoAhead
}

func agyCall(in map[string]any) guard.Call {
	call, _ := in["toolCall"].(map[string]any)
	args, _ := call["args"].(map[string]any)
	name := str(call["name"])
	return guard.Call{Tool: name, Command: str(args["CommandLine"]), Path: str(args["Path"]),
		Writes: name == "write_file" || name == "edit_file", Cwd: agyCwd(in), Roots: agyRoots(in)}
}

func agyDispatch(event string, in map[string]any) {
	payload := agyPayload(event, in)
	raw, _ := json.Marshal(payload)
	handle("agy", event, payload, raw)
}

// agyLaunched: this agy is the one Tether started for a session, not an `agy -p` a session or job runs. It's the
// same check as the launch's context marker: AICO_CONTEXT_PID is this hook's parent or one of its few parents.
func agyLaunched() bool {
	want, err := strconv.Atoi(os.Getenv("AICO_CONTEXT_PID"))
	if err != nil || want <= 1 || os.Getenv("AICO_CONTEXT_DELIVERED") == "" {
		return false
	}
	pid := os.Getppid()
	for hop := 0; hop < 3 && pid > 1; hop++ {
		if pid == want {
			return true
		}
		stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err != nil {
			return false
		}
		text := string(stat)
		fields := strings.Fields(text[strings.LastIndex(text, ")")+1:])
		if len(fields) < 2 {
			return false
		}
		if pid, err = strconv.Atoi(fields[1]); err != nil {
			return false
		}
	}
	return false
}

// agyDelivered is the context the launch wrote for this session (delivery.ts, kind hook).
func agyDelivered() string {
	dir := os.Getenv("AICO_DATA_DIR")
	if dir == "" && os.Getenv("AICO_WEB_DB") != "" {
		dir = filepath.Dir(os.Getenv("AICO_WEB_DB"))
	}
	if dir == "" {
		dir = os.Getenv("XDG_STATE_HOME")
		if dir == "" {
			dir = expand("~/.local/state")
		}
		dir = filepath.Join(dir, "aico")
	}
	body, err := os.ReadFile(filepath.Join(dir, "deliveries", os.Getenv("AICO_WIDGET_ID"), "AGENTS.md"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(body))
}

// agyStart registers the agent (so st sessions send reaches it) and hands over its instructions.
func agyStart(in map[string]any) string {
	parts := []string{agyDelivered()}
	payload := agyPayload("SessionStart", in)
	raw, _ := json.Marshal(payload)
	if out := handle("agy", "SessionStart", payload, raw); len(out.Context) > 0 {
		parts = append(parts, out.Context...)
	}
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

// agyInbox is what's waiting for this agent, shown before each model call: handshakes and ride-along lines.
func agyInbox(in map[string]any) string {
	cfg, err := loadConfig(dataDir())
	if err != nil {
		return ""
	}
	lease.SetBudget(started, cfg.Lease.StoreBudget())
	payload := agyPayload("UserPromptSubmit", in)
	h := lease.New(cfg.Lease, payload)
	h.Extra = func(event string) string { return memoryNotice(cfg, "antigravity", h.ID.AgentID, payload) }
	context, _ := h.InboxHook("turn", "antigravity")
	return context
}

// agyHooks is the hook set `aico-hook agy-install` writes: Aico's entry in agy's shared hooks.json. Timeouts sit
// well above the guard's own deadline (2 s); a timeout lets the tool run, so the guard must answer first.
func agyHooks(binary string) map[string]any {
	one := func(event string, seconds int) map[string]any {
		return map[string]any{"type": "command", "command": binary + " agy " + event, "timeout": seconds}
	}
	return map[string]any{
		"SessionStart":  []any{one("SessionStart", 20)},
		"PreInvocation": []any{one("PreInvocation", 5)},
		"PreToolUse":    []any{map[string]any{"matcher": "*", "hooks": []any{one("PreToolUse", 15)}}},
		"PostToolUse":   []any{map[string]any{"matcher": "*", "hooks": []any{one("PostToolUse", 5)}}},
	}
}

// agyInstall puts Aico's entry in ~/.gemini/config/hooks.json, leaving any other named hook as it is.
func agyInstall() int {
	path := expand("~/.gemini/config/hooks.json")
	doc := map[string]any{}
	if raw, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(raw))) > 0 {
		if err := json.Unmarshal(raw, &doc); err != nil {
			return fail("%s isn't JSON (%v); left as it is", path, err)
		}
	}
	doc["aico"] = agyHooks("~/.local/bin/aico-hook")
	body, _ := json.MarshalIndent(doc, "", "  ")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fail("%v", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(body, '\n'), 0o644); err != nil {
		return fail("%v", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fail("%v", err)
	}
	return 0
}
