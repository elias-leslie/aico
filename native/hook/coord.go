package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"aico/hook/lease"
)

// The coordination verbs and the inbox hook, run by the agent itself (never a guard decision, so every fault
// here is said plainly and fails open):
//
//	aico-hook lease [GLOB...] [--check P | --list [--all] | --take P | --release [GLOB] | --release-all |
//	                 --heartbeat | --hold PURPOSE] [--task ID]
//	aico-hook lease --foreign P...     JSON {path: [agent ids]} of the paths other sessions wrote (aico commit)
//	aico-hook lease --guard OP [--with-ack ID]   exit 1 with the holder line when another agent's hold or a live op
//	                                             refuses OP (commit, publish, rebuild, acceptance)
//	aico-hook lease --committed P...   a commit settled these paths: drop my leases on them and their writer sets
//	aico-hook sessions send TO TEXT [--fyi] [--source-key K] | ack ID yes|no|eta:MIN [NOTE] | confirm ID [--withdraw] | inbox
//	aico-hook inbox turn|stop|watch [codex|pi]   a hook event on stdin
//	aico-hook import-legacy [DIR]                carry SummitFlow's lease files into the store, once
//	aico-hook import-legacy --seen [DIR]         carry what its inbox hook had shown each agent (adds, never replaces)

func isCoordMode(m string) bool {
	return m == "lease" || m == "sessions" || m == "inbox" || m == "import-legacy"
}

func coordMain(mode string, args []string) int {
	switch mode {
	case "import-legacy":
		if len(args) > 0 && args[0] == "--seen" { // what the old inbox hook had shown, without touching the documents
			dir := filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), "st-coord-inbox")
			if len(args) > 1 {
				dir = args[1]
			}
			agents, err := lease.ImportLegacySeen(dir)
			if err != nil {
				return fail("seen import: %v", err)
			}
			fmt.Printf("imported seen state of %d agent(s): %s\n", len(agents), strings.Join(agents, ", "))
			return 0
		}
		dir := "~/.summitflow/leases"
		if len(args) > 0 {
			dir = args[0]
		}
		return importLegacy(dir)
	case "inbox":
		return inboxMain(args)
	}
	cfg, err := loadConfig(dataDir())
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR aico-hook could not read hook.json: %v\n", err)
		return 1
	}
	h := lease.New(cfg.Lease, nil)
	if mode == "lease" {
		return leaseMain(h, args)
	}
	return sessionsMain(h, args)
}

func fail(format string, a ...any) int {
	fmt.Fprintf(os.Stderr, "ERROR "+format+"\n", a...)
	return 2
}

func importLegacy(dir string) int {
	if strings.HasPrefix(dir, "~/") {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, dir[2:])
	}
	done, err := lease.ImportLegacy(dir)
	if err != nil {
		return fail("import stopped after %d file(s): %v", len(done), err)
	}
	fmt.Printf("imported %d document(s): %s\n", len(done), strings.Join(done, ", "))
	return 0
}

// ---------------------------------------------------------------- leases

func leaseMain(h *lease.Hook, args []string) int {
	var (
		globs                            []string
		check, take, hold, task          string
		guard, withAck                   string
		release                          *string
		list, all, releaseAll, heartbeat bool
		foreign, committed               bool
	)
	value := func(i *int, flag string) (string, bool) {
		if *i+1 >= len(args) {
			fmt.Fprintf(os.Stderr, "ERROR %s needs a value\n", flag)
			return "", false
		}
		*i++
		return args[*i], true
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		var ok = true
		switch a {
		case "--list":
			list = true
		case "--all":
			all = true
		case "--release-all":
			releaseAll = true
		case "--heartbeat":
			heartbeat = true
		case "--foreign":
			foreign = true
		case "--committed":
			committed = true
		case "--check":
			check, ok = value(&i, a)
		case "--guard":
			guard, ok = value(&i, a)
		case "--with-ack":
			withAck, ok = value(&i, a)
		case "--take":
			take, ok = value(&i, a)
		case "--hold":
			hold, ok = value(&i, a)
		case "--task", "-t":
			task, ok = value(&i, a)
		case "--release":
			var v string
			if v, ok = value(&i, a); ok {
				release = &v
			}
		default:
			if strings.HasPrefix(a, "--") {
				return fail("unknown option %s", a)
			}
			globs = append(globs, a)
		}
		if !ok {
			return 2
		}
	}
	if list && all {
		for _, l := range h.SystemLines() {
			fmt.Println(l)
		}
		return 0
	}
	p, err := lease.CLIProject()
	if err != nil {
		return fail("%v", err)
	}
	if foreign || committed {
		return settledMain(h, p, globs, committed)
	}
	if guard != "" {
		line, err := h.Guard(p.ID, p.Root, guard, withAck)
		if err != nil {
			return fail("%s: %s refused: %v; other agents' holds and ops are unknown", p.ID, guard, err)
		}
		if line != "" {
			fmt.Println(line)
			return 1
		}
		return 0
	}
	switch {
	case hold != "":
		l, err := h.Hold(p.ID, p.Root, hold)
		if err != nil {
			return fail("%v", err)
		}
		purpose := ""
		if l.Purpose != nil {
			purpose = *l.Purpose
		}
		fmt.Printf("Holding %s (%s) as %s; release this hold: st lease --release %s\n", p.ID, purpose, l.AgentID, l.LeaseID)
	case list:
		files, err := h.Listed(p.ID, "file")
		if err != nil {
			return fail("%v", err)
		}
		marks, _ := h.Listed(p.ID, "op", "hold")
		if len(files)+len(marks) == 0 {
			fmt.Println("No active leases.")
			return 0
		}
		for _, l := range append(files, marks...) {
			fmt.Println(l)
		}
	case check != "":
		path := check
		if !filepath.IsAbs(path) && p.Root != "" {
			path = filepath.Join(p.Root, path)
		}
		blocked, line := h.Check(path)
		if line != "" {
			word := "WARNING: "
			if blocked {
				word = "BLOCKED: "
			}
			fmt.Fprintln(os.Stderr, word+line)
		}
		if blocked {
			return 2
		}
	case take != "":
		l, err := h.Take(p.ID, p.Root, take)
		if err != nil {
			return fail("%v", err)
		}
		fmt.Printf("Took over %s. lease_id=%s\n", take, l.LeaseID)
	case releaseAll || release != nil:
		glob := ""
		if release != nil && !releaseAll {
			glob = *release
		}
		n, err := h.Release(p.ID, p.Root, glob, releaseAll)
		if err != nil {
			return fail("%v", err)
		}
		fmt.Printf("Released %d lease(s).\n", n)
	case heartbeat:
		n, err := h.Heartbeat(p.ID)
		if err != nil {
			return fail("%v", err)
		}
		fmt.Printf("Touched %d lease(s).\n", n)
	case len(globs) == 0:
		return fail("Provide globs to acquire, or use --list / --check / --take / --release.")
	default:
		for _, g := range globs {
			switch g {
			case "list", "check", "take", "release", "release-all", "heartbeat", "hold", "all":
				if _, err := os.Stat(filepath.Join(p.Root, g)); err != nil {
					return fail("st lease takes paths; for an action use --%s (e.g. st lease --list).", g)
				}
			}
		}
		l, err := h.Acquire(p.ID, p.Root, globs, task)
		if err != nil {
			return fail("%v", err)
		}
		fmt.Printf("Acquired lease %s on: %s\n", l.LeaseID, strings.Join(l.Globs, ", "))
	}
	return 0
}

// settledMain answers aico commit: --foreign before it (who else wrote these paths) and --committed after it.
// Paths are relative to the project root (or absolute) and keyed by their real path, as the writer sets are.
func settledMain(h *lease.Hook, p lease.Project, paths []string, committed bool) int {
	root := p.Root
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	abs := make([]string, len(paths))
	rel := map[string]string{}
	for i, path := range paths {
		if !filepath.IsAbs(path) {
			path = filepath.Join(root, path)
		}
		abs[i] = filepath.Clean(path)
		rel[abs[i]] = paths[i]
	}
	if committed {
		n, err := h.Committed(p.ID, abs)
		if err != nil {
			return fail("%v", err)
		}
		fmt.Printf("Released %d lease(s).\n", n)
		return 0
	}
	found, err := h.Foreign(p.ID, abs)
	if err != nil {
		return fail("%v", err)
	}
	out := map[string][]string{}
	for path, ids := range found {
		out[rel[path]] = ids
	}
	buf, _ := json.Marshal(out)
	fmt.Println(string(buf))
	return 0
}

// ---------------------------------------------------------------- handshakes

func sessionsMain(h *lease.Hook, args []string) int {
	if len(args) == 0 {
		return fail("usage: sessions send TO TEXT [--fyi] [--source-key K] | ack ID yes|no|eta:MIN [NOTE] | confirm ID [--withdraw] | inbox")
	}
	verb, rest := args[0], args[1:]
	var pos []string
	flags := map[string]string{}
	for i := 0; i < len(rest); i++ {
		a := rest[i]
		switch a {
		case "--fyi", "--withdraw":
			flags[a] = "1"
		case "--source-key", "--delivery", "--scope", "--requests":
			if i+1 >= len(rest) {
				return fail("%s needs a value", a)
			}
			i++
			flags[a] = rest[i]
		default:
			pos = append(pos, a)
		}
	}
	switch verb {
	case "may-disrupt":
		target := "host"
		if len(pos) > 1 {
			return fail("usage: sessions may-disrupt [TARGET] [--requests ID,ID]")
		}
		if len(pos) == 1 {
			target = pos[0]
		}
		result, err := json.Marshal(h.MayDisrupt(target, strings.Split(flags["--requests"], ",")))
		if err != nil {
			return fail("%v", err)
		}
		fmt.Println(string(result))
	case "send":
		return send(h, pos, flags)
	case "ack":
		return ack(h, pos)
	case "confirm":
		if len(pos) != 1 {
			return fail("usage: sessions confirm ID [--withdraw]")
		}
		withdraw := flags["--withdraw"] != ""
		if _, err := h.Confirm(pos[0], withdraw); err != nil {
			return fail("%v", err)
		}
		if withdraw {
			fmt.Println("withdrew " + pos[0])
			h.WithdrawStale(requestTarget(h, pos[0]))
		} else {
			fmt.Println("closed " + pos[0])
		}
	case "inbox":
		return inboxList(h)
	default:
		return fail("unknown sessions verb %q", verb)
	}
	return 0
}

// requestTarget is the recipient of request id ("" when unknown), for taking back its stale line.
func requestTarget(h *lease.Hook, id string) string {
	for _, r := range h.Rows() {
		if s, _ := r["id"].(string); s == id {
			to, _ := r["to"].(string)
			return to
		}
	}
	return ""
}

func send(h *lease.Hook, pos []string, flags map[string]string) int {
	if len(pos) == 1 && (pos[0] == "--help" || pos[0] == "-h") {
		fmt.Println("Usage: sessions send TO TEXT [--fyi] [--source-key K]")
		return 0
	}
	if len(pos) != 2 {
		return fail("usage: sessions send TO TEXT [--fyi] [--source-key K]")
	}
	if d := flags["--delivery"]; d != "" && d != "handshake" {
		return fail("aico sends handshakes only; fleet roots and native threads go through st sessions send --delivery %s", d)
	}
	to, text := pos[0], pos[1]
	fyi := flags["--fyi"] != ""
	project := ""
	if p, err := lease.CLIProject(); err == nil {
		project = p.ID
	}
	row, duplicate, err := h.Send(lease.SendOpts{To: to, Text: text, Project: project, SourceKey: flags["--source-key"], FYI: fyi})
	if err != nil {
		return fail("%v", err)
	}
	id, from, state := s(row["id"]), s(row["from"]), s(row["state"])
	if duplicate {
		why := "same open text"
		if k := flags["--source-key"]; k != "" && s(row["source_key"]) == k {
			why = "same source key"
		}
		fmt.Printf("existing %s -> %s (%s; state %s); not sent again. Track it with st sessions inbox\n", id, to, why, state)
		return 0
	}
	waited := "If you wait on the answer, arm st aico wait reply " + id + ": a yes otherwise may reach you without a wake"
	switch queued, werr := h.Wake(to, from, false); {
	case fyi:
		fmt.Printf("sent FYI %s -> %s; it does not wake anyone: the recipient's hook shows it on its next turn (or with the next message that does wake it). No ack or confirm needed\n", id, to)
	case queued != "":
		fmt.Printf("sent %s -> %s; Tether delivers a [Message] line to its window when it is idle, and its hook shows the request. Track seen/ack with st sessions inbox. %s\n", id, to, waited)
	default:
		fmt.Printf("sent %s -> %s; the recipient's hook shows it on its next turn or wakes it when idle. Track seen/ack with st sessions inbox. %s\n", id, to, waited)
		if werr != nil {
			fmt.Fprintf(os.Stderr, "WARNING Tether did not take the wake line (%v); the recipient's hook still shows the request\n", werr)
		}
	}
	if !h.KnownTarget(to) {
		live := strings.Join(h.LiveAgents(), ", ")
		if live == "" {
			live = "none"
		}
		fmt.Fprintf(os.Stderr, "WARNING %s is not a registered agent id (cc:/codex:/pi:/agy: id or 13+ char session prefix); it cannot see or ack this. Live agents: %s\n", to, live)
	}
	return 0
}

func ack(h *lease.Hook, pos []string) int {
	if len(pos) < 2 || len(pos) > 3 {
		return fail("usage: sessions ack ID yes|no|eta:MIN [NOTE]")
	}
	id, intent, note := pos[0], pos[1], ""
	if len(pos) == 3 {
		note = pos[2]
	}
	row, err := h.Ack(id, intent, note)
	if err != nil {
		return fail("%v", err)
	}
	fmt.Printf("acked %s %s\n", s(row["id"]), intent)
	lease.Nudge("reply", id)
	row = h.SettleBareAck(row)
	from := s(row["from"])
	queued, _ := h.Wake(from, s(row["acked_by"]), true)
	if closed, _ := row["auto_closed"].(bool); closed {
		suffix := ""
		if queued != "" {
			suffix = fmt.Sprintf("; %s gets it with its next message or turn, no wake", from)
		}
		fmt.Printf("closed %s: no confirm needed%s\n", id, suffix)
	} else if queued != "" {
		fmt.Printf("Tether delivers a [Message] line about the ack to %s\n", from)
	}
	return 0
}

func s(v any) string { str, _ := v.(string); return str }

// inboxList is `st sessions inbox`: the rows, then the notices the hook would add (acks to confirm, unanswered
// requests of mine, peer reset notes), as SummitFlow's inbox printed them.
func inboxList(h *lease.Hook) int {
	mine := h.SelfIDs()
	rows := h.Inbox()
	if err := lease.Unavailable(); err != nil {
		return fail("%v; requests are unknown, not none (is Tether running?)", err)
	}
	for _, r := range rows {
		state := s(r["state"])
		if state == "open" && mine[s(r["from"])] {
			if h.Surfaced(r) {
				state += "/seen"
			} else {
				state += "/unseen"
			}
		}
		detail := "-"
		if v := s(r["intent"]); v != "" {
			detail = v
		}
		if n, ok := r["eta_min"].(float64); ok && n > 0 {
			detail += fmt.Sprintf(" %dm", int(n))
		}
		if v := s(r["note"]); v != "" {
			detail += " (" + v + ")"
		}
		fmt.Printf("%s %s %s->%s %s | %s\n", s(r["id"]), state, s(r["from"]), s(r["to"]), detail, s(r["text"]))
	}
	for _, line := range h.Notices() {
		fmt.Println(line)
	}
	return 0
}

// ---------------------------------------------------------------- the inbox hook

func inboxMain(args []string) int {
	if len(args) == 0 {
		return fail("usage: inbox turn|stop|watch [codex|pi]")
	}
	mode, provider := args[0], "claude_code"
	if len(args) > 1 && (args[1] == "codex" || args[1] == "pi") {
		provider = args[1]
	}
	if mode == "watch" { // Tether delivers the [Message] line that watcher used to wake the agent with
		return 0
	}
	if mode != "turn" && mode != "stop" {
		return fail("unknown inbox mode %q", mode)
	}
	raw, _ := io.ReadAll(os.Stdin)
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil || payload == nil {
		return 0
	}
	defer func() { // not a safety gate: a fault is said on stderr and the turn goes on
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "aico-hook inbox crashed: %v\n", r)
		}
	}()
	cfg, err := loadConfig(dataDir())
	if err != nil {
		fmt.Fprintf(os.Stderr, "aico-hook inbox could not read hook.json: %v\n", err)
		return 0
	}
	lease.SetBudget(started, cfg.Lease.StoreBudget())
	h := lease.New(cfg.Lease, payload)
	h.Extra = func(event string) string { return memoryNotice(cfg, provider, h.ID.AgentID, payload) }
	context, block := h.InboxHook(mode, provider)
	switch {
	case block != "":
		fmt.Println(lease.StopJSON(block))
	case context != "":
		event := s(payload["hook_event_name"])
		if event == "" {
			event = "UserPromptSubmit"
		}
		fmt.Println(mustJSON(map[string]any{"hookSpecificOutput": map[string]any{
			"hookEventName": event, "additionalContext": context}}))
	}
	return 0
}
