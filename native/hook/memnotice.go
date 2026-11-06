package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// The memory notice: tells an agent, once, when memory pressure killed a process in its pane, stopped the pane
// or warned about it. host-steward's memctl owns the record (~/.local/state/host-steward/memory-events.jsonl,
// schema v1); this reads it directly and only renders it for the agent. It replaces SummitFlow's coord_memory.py and keeps its per-agent state files
// (<runtime>/st-coord-inbox/mem-<agent>.json), so notices already shown stay shown.
//
// Hot path (every hook call): /proc/self/cgroup, the pane's memory.events oom_kill counter, a stat of the record
// file and the agent's small state file. The record is read only when the counter or the record changed. An agent
// starts from what is there at its first hook (SessionStart, SubagentStart); a resumed session hears the last day.

const (
	memResumeLookback = 86400 // a resumed session hears about the last day
	memHeartbeatFresh = 60
	memStateTTL       = 2 * 86400
	memMaxLines       = 6
	memLockWait       = 1500 * time.Millisecond
	memQuietSlack     = 15 // memctl writes a kernel kill's record from its next tick, so its time can trail the counter
)

var memNoticeKinds = map[string]bool{"kill": true, "warning": true, "pane-stopped": true, "agent-hog": true}
var memGuardKillers = map[string]bool{"tether": true, "memctl": true} // tool-job kills, not the kernel
var memReason = map[string]string{
	"tether":          "the workstation was critically low on memory",
	"memctl":          "the workstation was critically low on memory",
	"kernel-pane-cap": "{pane} reached its memory limit",
	"kernel-cgroup":   "a shared memory limit was reached",
	"kernel-global":   "the workstation ran out of memory",
	"oomd":            "memory pressure stayed too high",
}
var memKiller = map[string]string{"tether": "Tether's memory guard", "memctl": "memctl", "oomd": "systemd-oomd"}

// memPaths are the files a notice reads; tests point them at fixtures.
type memPaths struct {
	stateDir   string
	procCgroup string
	cgroupRoot string
	events     string
	heartbeat  string
}

func defaultMemPaths() memPaths {
	home, _ := os.UserHomeDir()
	runtime := os.Getenv("XDG_RUNTIME_DIR")
	if runtime == "" {
		runtime = "/tmp"
	}
	state := os.Getenv("XDG_STATE_HOME")
	if state == "" {
		state = filepath.Join(home, ".local/state")
	}
	return memPaths{
		stateDir:   filepath.Join(runtime, "st-coord-inbox"),
		procCgroup: "/proc/self/cgroup",
		cgroupRoot: "/sys/fs/cgroup",
		events:     filepath.Join(state, "host-steward/memory-events.jsonl"),
		heartbeat:  filepath.Join(runtime, "host-steward/memctl.json"),
	}
}

type memState struct {
	Scope   string             `json:"scope"`
	Counter *int               `json:"counter"`
	Sig     []int64            `json:"sig"`
	Since   float64            `json:"since"`
	Seen    map[string]float64 `json:"seen"`
	Quiet   map[string]float64 `json:"quiet"`
}

// memoryNotice is this agent's notice for the hook payload, or "" (also on any fault).
func memoryNotice(cfg *Config, provider string, agentID string, payload map[string]any) string {
	subagent := ""
	if provider == "claude_code" {
		subagent, _ = payload["agent_id"].(string)
	}
	agent := agentID
	if subagent != "" {
		agent += "/" + subagent
	}
	event, _ := payload["hook_event_name"].(string)
	source, _ := payload["source"].(string)
	resumed := event == "SessionStart" && source == "resume"
	text, _ := memoryCheck(agent, resumed, defaultMemPaths(), time.Now())
	return text
}

func ownPane(p memPaths) (scope, cgroup string, ok bool) {
	raw, err := os.ReadFile(p.procCgroup)
	if err != nil {
		return "", "", false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "0::") {
			continue
		}
		var parts []string
		for _, s := range strings.Split(strings.TrimSpace(line[3:]), "/") {
			if s != "" {
				parts = append(parts, s)
			}
		}
		for i := len(parts) - 1; i >= 0; i-- {
			if strings.HasPrefix(parts[i], "tmux-spawn-") && strings.HasSuffix(parts[i], ".scope") {
				return parts[i], filepath.Join(append([]string{p.cgroupRoot}, parts[:i+1]...)...), true
			}
		}
	}
	return "", "", false
}

func oomKills(cgroup string) *int {
	raw, err := os.ReadFile(filepath.Join(cgroup, "memory.events"))
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(raw), "\n") {
		name, value, _ := strings.Cut(line, " ")
		if name == "oom_kill" {
			if n, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
				return &n
			}
		}
	}
	return nil
}

func fileSig(path string) []int64 {
	st, err := os.Stat(path)
	if err != nil {
		return nil
	}
	ino := int64(0)
	if s, ok := st.Sys().(*syscall.Stat_t); ok {
		ino = int64(s.Ino)
	}
	return []int64{ino, st.Size()}
}

func sameSig(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sameCounter(a, b *int) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
}

func loadMemState(path string) *memState {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var s memState
	if json.Unmarshal(raw, &s) != nil || s.Seen == nil || s.Quiet == nil {
		return nil
	}
	return &s
}

func writeMemState(path string, s *memState) {
	raw, err := json.Marshal(s)
	if err != nil {
		return
	}
	tmp := fmt.Sprintf("%s.%d.tmp", strings.TrimSuffix(path, ".json"), os.Getpid())
	if os.WriteFile(tmp, raw, 0o644) == nil {
		_ = os.Rename(tmp, path)
	}
}

func memUnchanged(s *memState, scope string, counter *int, sig []int64) bool {
	return s != nil && s.Scope == scope && sameCounter(s.Counter, counter) && sameSig(s.Sig, sig)
}

// memoryCheck returns the notice text for agent (one state per agent and per subagent) when its pane has news.
// The state is saved as the text is returned: the hook prints it right after.
func memoryCheck(agent string, resumed bool, p memPaths, now time.Time) (string, bool) {
	scope, cgroup, ok := ownPane(p)
	if !ok {
		return "", false
	}
	counter, sig := oomKills(cgroup), fileSig(p.events)
	safe := strings.Map(func(r rune) rune {
		if r == '-' || r == '_' || r == '.' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' {
			return r
		}
		return '_'
	}, agent)
	statePath := filepath.Join(p.stateDir, "mem-"+safe+".json")
	if !resumed && memUnchanged(loadMemState(statePath), scope, counter, sig) {
		return "", false
	}
	if os.MkdirAll(p.stateDir, 0o755) != nil {
		return "", false
	}
	lock, err := os.OpenFile(filepath.Join(p.stateDir, "mem.lock"), os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return "", false
	}
	defer lock.Close() // closing releases the flock
	deadline := time.Now().Add(memLockWait)
	for syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		if time.Now().After(deadline) {
			return "", false // another hook is busy past any hook's budget: the change is still there next time
		}
		time.Sleep(50 * time.Millisecond)
	}
	state := loadMemState(statePath)
	if !resumed && memUnchanged(state, scope, counter, sig) {
		return "", false
	}
	if state == nil { // a new agent: drop the states of ones long gone
		old, _ := filepath.Glob(filepath.Join(p.stateDir, "mem-*.json"))
		for _, f := range old {
			if st, err := os.Stat(f); err == nil && now.Sub(st.ModTime()).Seconds() > memStateTTL {
				_ = os.Remove(f)
			}
		}
	}
	lines, kills, next := memCollect(state, scope, counter, sig, resumed, p, float64(now.UnixNano())/1e9)
	writeMemState(statePath, next)
	if len(lines) == 0 {
		return "", false
	}
	return memRender(lines, kills), true
}

func memCollect(state *memState, scope string, counter *int, sig []int64, resumed bool, p memPaths, now float64) ([]string, bool, *memState) {
	fresh := state == nil
	if state == nil { // first call for this agent: what happened before is not its news
		state = &memState{Scope: scope, Counter: counter, Sig: sig, Since: now, Seen: map[string]float64{}, Quiet: map[string]float64{}}
	}
	if resumed {
		state.Since = math.Min(state.Since, now-memResumeLookback)
	}
	if state.Scope != scope { // resumed into a new pane: its counter starts fresh
		state.Scope, state.Counter = scope, counter
	}
	since := math.Max(state.Since, now-memResumeLookback)
	seen, quiet := map[string]float64{}, map[string]float64{}
	for k, v := range state.Seen {
		if v >= since {
			seen[k] = v
		}
	}
	for k, v := range state.Quiet {
		if v >= since {
			quiet[k] = v
		}
	}
	delta := 0
	if counter != nil && state.Counter != nil && *counter > *state.Counter {
		delta = *counter - *state.Counter
	}
	ask := resumed || (!fresh && (!sameSig(sig, state.Sig) || delta > 0))
	var lines []string
	kills := false
	toldHere := 0
	if ask {
		for _, r := range memRecords(p, scope, since) {
			ts := num(r["ts"])
			key := fmt.Sprintf("%s:%s:%s:%s", memStr(r["kind"]), memNum(r["ts"]), memNum(r["pid"]), memStr(r["scope"]))
			if _, dup := seen[key]; dup || ts < since {
				continue
			}
			seen[key] = ts
			kind, killer := memStr(r["kind"]), memStr(r["killer"])
			if !memNoticeKinds[kind] {
				continue
			}
			kernelKill := kind == "kill" && !memGuardKillers[killer]
			recScope := memStr(r["scope"])
			if q, ok := quiet[recScope]; kernelKill && ok && ts <= q+memQuietSlack {
				continue // already told from the counter
			}
			if kernelKill && recScope == scope {
				toldHere += max(int(num(r["count"])), 1)
			}
			kills = kills || kind == "kill"
			lines = append(lines, memLine(r, scope))
		}
	}
	if delta > toldHere {
		lines = append(lines, memCounterLine(delta-toldHere, now, memctlAlive(p, now)))
		quiet[scope] = now
		kills = true
	}
	state.Counter, state.Sig, state.Since, state.Seen, state.Quiet = counter, sig, since, seen, quiet
	return lines, kills, state
}

// memRecords is this pane's records (and an earlier pane of the same Tether session) newer than since, oldest
// first, read from the record file and the one it rotated to.
func memRecords(p memPaths, scope string, since float64) []map[string]any {
	var all []map[string]any
	for _, path := range []string{p.events + ".1", p.events} {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(raw), "\n") {
			var r map[string]any
			if json.Unmarshal([]byte(line), &r) == nil && num(r["ts"]) > since {
				all = append(all, r)
			}
		}
	}
	sort.SliceStable(all, func(a, b int) bool { return num(all[a]["ts"]) < num(all[b]["ts"]) })
	sessions := map[string]bool{} // the Tether sessions that ran in this pane
	for _, r := range all {
		if id := memStr(r["tether_session_id"]); memStr(r["scope"]) == scope && id != "" && id != "None" {
			sessions[id] = true
		}
	}
	var mine []map[string]any
	for _, r := range all {
		if memStr(r["scope"]) == scope || sessions[memStr(r["tether_session_id"])] {
			mine = append(mine, r)
		}
	}
	return mine
}

func memctlAlive(p memPaths, now float64) bool {
	st, err := os.Stat(p.heartbeat)
	return err == nil && now-float64(st.ModTime().UnixNano())/1e9 < memHeartbeatFresh
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

func memStr(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return memNum(v)
}

// memNum renders a JSON number the way Python's str() did (1793978484.956 stays, 12.0 stays "12.0", ints plain),
// so keys stay compatible with the state files already written.
func memNum(v any) string {
	f, ok := v.(float64)
	if !ok {
		if v == nil {
			return "None"
		}
		return fmt.Sprint(v)
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e15 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

func memSize(v any) string {
	n := num(v)
	switch {
	case n <= 0:
		return ""
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GiB", n/(1<<30))
	}
	return fmt.Sprintf("%.0f MiB", n/(1<<20))
}

func memClock(ts float64) string {
	return time.Unix(int64(ts), 0).Format("15:04")
}

func memWho(r map[string]any, pane string) string {
	cmd := strings.Join(strings.Fields(memStr(r["cmdline_head"])), " ")
	if runes := []rune(cmd); len(runes) > 80 {
		cmd = string(runes[:77]) + "..."
	}
	var inner []string
	if pid := num(r["pid"]); pid != 0 {
		inner = append(inner, fmt.Sprintf("pid %d", int(pid)))
	}
	if cmd != "" {
		inner = append(inner, "`"+cmd+"`")
	}
	name := memStr(r["comm"])
	if name == "" {
		name = "a process"
	}
	who := name
	if len(inner) > 0 {
		who = fmt.Sprintf("%s (%s)", name, strings.Join(inner, ", "))
	}
	owner := "this session's agent"
	if pane == "this pane" {
		owner = "this pane's agent"
	}
	if memStr(r["class"]) == "agent" {
		return owner + ", " + who
	}
	return who
}

func plural(n int) string {
	if n != 1 {
		return "es"
	}
	return ""
}

func memLine(r map[string]any, scope string) string {
	at, kind, killer := memClock(num(r["ts"])), memStr(r["kind"]), memStr(r["killer"])
	pane := "the pane this session ran in before"
	if memStr(r["scope"]) == scope {
		pane = "this pane"
	}
	size := memSize(r["bytes"])
	switch kind {
	case "kill":
		actor, ok := memKiller[killer]
		if !ok {
			actor = "the kernel"
		}
		var victim string
		if num(r["pid"]) != 0 {
			victim = memWho(r, pane)
			if size != "" {
				victim += ", " + size
			}
		} else {
			count := max(int(num(r["count"])), 1)
			victim = fmt.Sprintf("%d process%s in %s", count, plural(count), pane)
		}
		job := ""
		if members := int(num(r["members"])); memGuardKillers[killer] && members > 1 {
			job = fmt.Sprintf(", and the rest of its tool job (%d processes in all)", members)
		}
		reason, ok := memReason[killer]
		if !ok {
			reason = "memory ran out"
		}
		return fmt.Sprintf("%s %s killed %s%s; %s.", at, actor, victim, job, strings.ReplaceAll(reason, "{pane}", pane))
	case "pane-stopped":
		return fmt.Sprintf("%s %s stopped as a whole after that kill, and its agent with it. This session was resumed "+
			"afterwards: check git status and your notes before you continue.", at, pane)
	case "agent-hog":
		s := size
		if s == "" {
			s = "size unknown"
		}
		return fmt.Sprintf("%s memory is critical and %s is the biggest user (%s). Tether does not kill agents, but the "+
			"kernel will if memory runs out: save your notes now, compact, and keep big outputs out of your context.",
			at, memWho(r, pane), s)
	}
	most := size
	if most == "" {
		most = "the most"
	}
	var what string
	switch {
	case memStr(r["class"]) == "agent":
		what = fmt.Sprintf("%s uses %s. Save notes and compact soon; keep big outputs out of your context.", memWho(r, pane), most)
	case num(r["pid"]) != 0:
		what = fmt.Sprintf("%s uses %s. If it is yours, finish or shrink it before Tether has to kill it.", memWho(r, pane), most)
	default:
		what = fmt.Sprintf("it uses %s. Avoid starting more big jobs here for now.", most)
	}
	return fmt.Sprintf("%s memory is getting low on the workstation and %s is growing fastest: %s", at, pane, what)
}

func memCounterLine(count int, now float64, alive bool) string {
	where := fmt.Sprintf("memctl is not running, so details are only in `journalctl -k --since %s`", memClock(now-120))
	if alive {
		where = "memctl adds the details to the memory record within a minute"
	}
	return fmt.Sprintf("%s the kernel killed %d process%s in this pane for memory; %s.", memClock(now), count, plural(count), where)
}

func memRender(lines []string, kills bool) string {
	if len(lines) > memMaxLines {
		lines = append([]string{fmt.Sprintf("%d earlier events in the memory record.", len(lines)-memMaxLines+1)},
			lines[len(lines)-memMaxLines+1:]...)
	}
	text := append([]string{"Memory notice for this pane (information only; the process may be yours or a subagent's):"}, lines...)
	if kills {
		text = append(text, "A command that ended early (exit 137, or a pipeline with missing output) was killed this way; "+
			"rerun it smaller or later.")
	}
	return strings.Join(text, "\n")
}
