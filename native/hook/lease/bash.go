package lease

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Shell writes: bash-pre snapshots the dirty files of the cwd repo (and sibling repos the command names);
// bash-post diffs the snapshot, joins the written paths' writer sets and warns once when the command wrote a
// file another agent leased before it started. Snapshot files live in $XDG_RUNTIME_DIR/st-lease-bash in
// the format SummitFlow's lease-hook writes, so both can see each other's running shells during the swap.

func snapDir() string {
	base := os.Getenv("XDG_RUNTIME_DIR")
	if base == "" {
		base = "/tmp"
	}
	return filepath.Join(base, "st-lease-bash")
}

// sanitize is `tr -c 'A-Za-z0-9_.-' '_'`, byte by byte.
func sanitize(s string) string {
	b := []byte(s)
	for i, c := range b {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '.' || c == '-') {
			b[i] = '_'
		}
	}
	return string(b)
}

func (h *Hook) snapKey() (key, ownPrefix, cwd string) {
	sid := str(h.Payload["session_id"])
	tid := str(h.Payload["tool_use_id"])
	if tid == "" {
		tid = str(h.Payload["toolCallId"])
	}
	cwd = str(h.Payload["cwd"])
	if in, ok := h.Payload["tool_input"].(map[string]any); ok {
		if workdir := str(in["workdir"]); workdir != "" {
			if filepath.IsAbs(workdir) {
				cwd = workdir
			} else {
				cwd = filepath.Join(cwd, workdir)
			}
		}
	}
	return sanitize(sid + "-" + tid), sanitize(sid + "-"), cwd
}

// Literal output destinations of the first simple command. Stop at shell control syntax and
// never infer a path from expansions or a heredoc body. Other writes remain snapshot-attributed.
func shellOutputs(payload map[string]any, cwd string) []string {
	in, _ := payload["tool_input"].(map[string]any)
	command := str(in["command"])
	if command == "" {
		command = str(in["cmd"])
	}
	words := strings.Fields(command)
	if len(words) == 0 {
		return nil
	}
	switch words[0] {
	case "[[", "if", "while", "until", "for", "case", "select", "function":
		return nil
	}
	var out []string
	quote := byte(0)
	for i := 0; i < len(command); i++ {
		c := command[i]
		if c == '\\' && quote != '\'' {
			i++
			continue
		}
		if quote != 0 {
			if c == quote {
				quote = 0
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			continue
		}
		if c == '#' && (i == 0 || strings.ContainsRune(" \t", rune(command[i-1]))) {
			break
		}
		if strings.ContainsRune(";&|(){}\n", rune(c)) {
			break
		}
		if c != '>' {
			continue
		}
		for i+1 < len(command) && command[i+1] == '>' {
			i++
		}
		start := i + 1
		for start < len(command) && (command[start] == ' ' || command[start] == '\t') {
			start++
		}
		if start == len(command) || strings.ContainsRune("&|", rune(command[start])) {
			break
		}
		end, q := start, byte(0)
		for end < len(command) {
			c = command[end]
			if c == '\\' && q != '\'' {
				end += 2
				continue
			}
			if q != 0 {
				if c == q {
					q = 0
				}
			} else if c == '\'' || c == '"' {
				q = c
			} else if strings.ContainsRune(" \t\r\n;&|(){}<>", rune(c)) {
				break
			}
			end++
		}
		if end > len(command) {
			break
		}
		raw := command[start:end]
		if words, ok := shlexSplit(raw); ok && len(words) == 1 && words[0] != "" && !strings.ContainsAny(raw, "$`*?[~#") {
			path := words[0]
			if !filepath.IsAbs(path) {
				path = filepath.Join(cwd, path)
			}
			out = append(out, path)
		}
		i = end - 1
	}
	return out
}

// gateCommand: the shell command only runs the repo gate (`st|aico check` or `st|aico commit`), optionally after `cd DIR &&`, env assignments or
// `time`, with its output sent to `2>&1` and a tail, head, grep or cat. These write only the caller's own files (the formatter and generated
// writes stay within its paths), so any other file that changes while they run is another agent's concurrent
// edit, never this command's write: no snapshot, so no overlap line and no writer-set entry.
func gateCommand(payload map[string]any) bool {
	in, _ := payload["tool_input"].(map[string]any)
	c, _ := in["command"].(string)
	if c == "" {
		c, _ = in["cmd"].(string)
	}
	argv, ok := shlexSplit(c)
	if !ok {
		return false
	}
	if len(argv) > 3 && argv[0] == "cd" && argv[2] == "&&" {
		argv = argv[3:]
	}
	for len(argv) > 0 && envAssign.MatchString(argv[0]) {
		argv = argv[1:]
	}
	if len(argv) > 0 && argv[0] == "time" {
		argv = argv[1:]
	}
	n := 0
	switch {
	case len(argv) >= 2 && (argv[0] == "st" && (argv[1] == "check" || argv[1] == "commit") ||
		argv[0] == "aico" && (argv[1] == "check" || argv[1] == "commit")):
		n = 2
	default:
		return false
	}
	rest := argv[n:]
	for len(rest) > 0 && !shellOp.MatchString(rest[0]) {
		rest = rest[1:]
	}
	if len(rest) >= 3 && rest[0] == "2>" && rest[1] == "&" && rest[2] == "1" {
		rest = rest[3:]
	}
	if len(rest) >= 2 && rest[0] == "|" && (rest[1] == "tail" || rest[1] == "head" || rest[1] == "grep" || rest[1] == "cat") {
		rest = rest[2:]
		for len(rest) > 0 && !shellOp.MatchString(rest[0]) {
			rest = rest[1:]
		}
	}
	return len(rest) == 0
}

var envAssign = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)

// shellOp is a token shlexSplit made of shell punctuation, or a redirection (a quoted argument is never split up).
var shellOp = regexp.MustCompile(`^(?:[;&|()\n]+|\d*[<>].*)$`)

// snapshot is "<mtime> <abs path>" per present dirty file of repo top and "D <abs path>" per deleted path.
func snapshot(top string) []string {
	out, err := exec.Command("git", "-C", top, "status", "--porcelain=v1", "-z", "--untracked-files=all").Output()
	if err != nil && len(out) == 0 {
		return nil
	}
	recs := strings.Split(string(out), "\x00")
	var lines []string
	exists := func(p string) bool { _, err := os.Lstat(p); return err == nil }
	for i := 0; i < len(recs); i++ {
		rec := recs[i]
		if rec == "" {
			continue
		}
		if rec[0] == 'R' || rec[0] == 'C' {
			if i+1 < len(recs) {
				i++
				if src := recs[i]; rec[0] == 'R' && !exists(filepath.Join(top, src)) {
					lines = append(lines, "D "+top+"/"+src)
				}
			}
		}
		if len(rec) <= 3 {
			continue
		}
		p := top + "/" + rec[3:]
		fi, err := os.Lstat(p)
		if err != nil {
			lines = append(lines, "D "+p)
			continue
		}
		lines = append(lines, fi.ModTime().UTC().Format("2006-01-02T15:04:05.000000000-0700")+" "+p)
	}
	return lines
}

// BashPre records the snapshot for this tool call (pure bookkeeping: never output).
func (h *Hook) BashPre(raw []byte) {
	key, _, cwd := h.snapKey()
	if cwd == "" || gateCommand(h.Payload) {
		return
	}
	// A literal shell destination carries the same intent as a Write tool. Recording it before
	// concurrent snapshots lets each shell retain its own files without claiming the other's.
	for _, path := range shellOutputs(h.Payload, cwd) {
		intent := &Hook{Cfg: h.Cfg, ID: h.ID, Payload: map[string]any{"tool_input": map[string]any{"file_path": path}}}
		intent.Edit()
	}
	dir := snapDir()
	if os.MkdirAll(dir, 0o755) != nil {
		return
	}
	var tops []string
	if top, _, ok := toplevel(cwd); ok {
		tops = append(tops, top)
		// Sibling repos the command names by absolute path (cd /x/other, git -C /x/other): their writes are unknown.
		parent := filepath.Dir(top)
		re := regexp.MustCompile(regexp.QuoteMeta(parent) + `/[A-Za-z0-9._-]+`)
		seen := map[string]bool{}
		for _, m := range re.FindAllString(string(raw), -1) {
			if seen[m] {
				continue
			}
			seen[m] = true
			if m != top {
				if _, err := os.Stat(m + "/.git"); err == nil {
					tops = append(tops, m)
				}
			}
		}
		sort.Strings(tops[1:])
	}
	bg := 0
	if regexp.MustCompile(`"run_in_background"\s*:\s*true`).Match(raw) {
		bg = 1
	}
	var snap []string
	for _, t := range tops {
		snap = append(snap, snapshot(t)...)
	}
	sort.Strings(snap)
	var b bytes.Buffer
	fmt.Fprintf(&b, "%s\n%d %d\n", time.Now().UTC().Format("2006-01-02T15:04:05.000000+00:00"), bg, len(tops))
	for _, t := range tops {
		b.WriteString(t + "\n")
	}
	for _, l := range snap {
		b.WriteString(l + "\n")
	}
	_ = os.WriteFile(filepath.Join(dir, key), b.Bytes(), 0o644)
	cutoff := time.Now().Add(-time.Duration(h.Cfg.SnapshotMaxMins) * time.Minute)
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if fi, err := e.Info(); err == nil && fi.Mode().IsRegular() && fi.ModTime().Before(cutoff) {
				_ = os.Remove(filepath.Join(dir, e.Name()))
			}
		}
	}
}

func readSnap(path string) (since string, bg string, tops []string, lines []string, ok bool) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	if !sc.Scan() {
		return
	}
	since = sc.Text()
	if !sc.Scan() {
		return
	}
	head := strings.Fields(sc.Text())
	n := 0
	if len(head) == 2 {
		bg = head[0]
		n, _ = strconv.Atoi(head[1])
	}
	for i := 0; i < n && sc.Scan(); i++ {
		tops = append(tops, sc.Text())
	}
	for sc.Scan() {
		if t := sc.Text(); t != "" {
			lines = append(lines, t)
		}
	}
	return since, bg, tops, lines, true
}

// BashPost diffs the snapshot and returns the OVERLAP line, or "".
func (h *Hook) BashPost() string {
	key, ownPrefix, cwd := h.snapKey()
	if cwd == "" {
		return ""
	}
	dir := snapDir()
	path := filepath.Join(dir, key)
	since, bg, tops, before, ok := readSnap(path)
	_ = os.Remove(path)
	if !ok || len(tops) == 0 {
		return ""
	}
	var after []string
	for _, t := range tops {
		after = append(after, snapshot(t)...)
	}
	had := map[string]bool{}
	for _, l := range before {
		had[l] = true
	}
	var written []string
	for _, l := range after {
		if !had[l] {
			_, p, _ := strings.Cut(l, " ")
			written = append(written, p)
		}
	}
	if len(written) == 0 {
		return ""
	}
	top := tops[0]
	// Another session's foreground shell still running in this repo writes files this diff cannot tell from ours.
	concurrent := false
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ownPrefix) || strings.HasPrefix(e.Name(), ".") || !e.Type().IsRegular() {
				continue
			}
			_, obg, otops, _, ok := readSnap(filepath.Join(dir, e.Name()))
			if !ok || obg != "0" {
				continue
			}
			for _, t := range otops {
				if t == top {
					concurrent = true
				}
			}
			if concurrent {
				break
			}
		}
	}
	var own, other, dirty []string
	for _, p := range written {
		if strings.HasPrefix(p, top+"/") {
			own = append(own, p)
		} else {
			other = append(other, p)
		}
	}
	for _, l := range after {
		if _, p, _ := strings.Cut(l, " "); strings.HasPrefix(p, top+"/") {
			dirty = append(dirty, p)
		}
	}
	start, ok := parseStamp(since)
	if !ok {
		return ""
	}
	line := ""
	if !concurrent {
		line = h.shellWriteWarning(own, start)
	}
	h.recordShellWrites(own, other, start, bg == "1", concurrent, dirty)
	return line
}

type group struct {
	project Project
	paths   []string
	reason  string
}

// recordShellWrites joins the writer sets of paths a shell command wrote (coord.record_shell_writes): own
// writes for this session (or unknown when backgrounded or concurrent), other repos' writes as unknown; the
// cwd repo's writer sets of paths no longer dirty are dropped.
func (h *Hook) recordShellWrites(written, other []string, since time.Time, background, concurrent bool, dirty []string) {
	dirtySet := map[string]bool{}
	for _, p := range dirty {
		dirtySet[realPath(p)] = true
	}
	ownReason := ""
	if background {
		ownReason = "background"
	} else if concurrent {
		ownReason = "concurrent"
	}
	var order []string
	groups := map[string]*group{}
	for _, set := range []struct {
		paths  []string
		reason string
	}{{written, ownReason}, {other, "other-repo"}} {
		for _, p := range set.paths {
			proj, ok := ProjectFor(p)
			if !ok {
				continue
			}
			k := proj.ID + "\x00" + set.reason
			if groups[k] == nil {
				groups[k] = &group{project: proj, reason: set.reason}
				order = append(order, k)
			}
			groups[k].paths = append(groups[k].paths, realPath(p))
		}
	}
	pruned := map[string]bool{}
	for _, k := range order {
		g := groups[k]
		prune := g.reason != "other-repo" && !pruned[g.project.ID]
		root := ""
		if prune {
			root = realPath(g.project.Root)
			pruned[g.project.ID] = true
		}
		h.recordWrites(g.project.ID, g.paths, since, g.reason, prune, dirtySet, root)
	}
}

func (h *Hook) recordWrites(project string, paths []string, since time.Time, unknown string, prune bool, dirty map[string]bool, root string) {
	s, err := h.Cfg.store(project)
	if err != nil {
		return
	}
	lin := h.lineage()
	mine, anchor := lin.SessionIDs(h.ID), lin.Anchor
	leaseMine, leaseAnchor := lin.SelfIDs(h.ID), lin.MyAnchor()
	entry := h.writerEntry(unknown, nil)
	concurrent := entry
	if unknown == "" {
		concurrent = h.writerEntry("concurrent", nil)
	}
	atOrAfter := func(v string) bool { t, ok := parseStamp(v); return ok && !t.Before(since) }
	_ = s.withLock(func() error {
		d := s.load()
		d.leases = s.purge(d.leases)
		if prune && root != "" {
			prefix := strings.TrimRight(root, "/") + "/"
			for p := range d.writers {
				if strings.HasPrefix(p, prefix) && !dirty[p] {
					delete(d.writers, p)
				}
			}
		}
		for _, p := range paths {
			chosen := entry
			// A completed overlapping shell may have disappeared from the snapshot directory.
			// Its named post-write record already accounts for this file's current modification.
			accounted := false
			if fi, err := os.Lstat(p); err == nil {
				for _, e := range d.writers[p] {
					at, ok := parseStamp(str(e["at"]))
					if ok && str(e["agent_id"]) != "unknown" && !isOwnWriter(e, mine, anchor) && !at.Before(since) && !at.Before(fi.ModTime()) {
						accounted = true
					}
				}
			}
			if accounted {
				continue
			}
			if unknown == "concurrent" {
				own, foreign := false, false
				for _, l := range d.leases {
					if l.Kind != "file" || !l.Matches(p) {
						continue
					}
					if isMine(l, leaseMine, leaseAnchor) {
						own = true
					} else {
						foreign = true
					}
				}
				if foreign && !own {
					continue
				}
				if own && !foreign {
					chosen = h.writerEntry("", nil)
				}
			}
			clash := false
			for _, e := range d.writers[p] {
				if !isOwnWriter(e, mine, anchor) && atOrAfter(str(e["at"])) {
					clash = true
				}
			}
			for _, l := range d.leases {
				if l.Kind == "file" && l.Matches(p) && !isMine(l, leaseMine, leaseAnchor) && atOrAfter(l.AcquiredAt) {
					clash = true
				}
			}
			if clash {
				addWriter(d.writers, p, clone(concurrent))
			} else {
				addWriter(d.writers, p, clone(chosen))
			}
		}
		return s.save(d)
	})
}

func clone(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// shellWriteWarning: one line when the command wrote a path another agent leased before it started.
func (h *Hook) shellWriteWarning(paths []string, since time.Time) string {
	var order []string
	byRepo := map[string]*group{}
	for _, p := range paths {
		proj, ok := ProjectFor(p)
		if !ok {
			continue
		}
		if byRepo[proj.ID] == nil {
			byRepo[proj.ID] = &group{project: proj}
			order = append(order, proj.ID)
		}
		byRepo[proj.ID].paths = append(byRepo[proj.ID].paths, realPath(p))
	}
	lin := h.lineage()
	mine, anchor := lin.SessionIDs(h.ID), lin.Anchor
	for _, id := range order {
		g := byRepo[id]
		s, err := h.Cfg.store(id)
		if err != nil {
			continue
		}
		live, _ := s.Active("file")
		for _, l := range live {
			if isMine(l, mine, anchor) {
				continue
			}
			hb, ok := parseStamp(l.LastHeartbeat)
			if !ok || !hb.Before(since) {
				continue
			}
			for _, p := range g.paths {
				if l.Matches(p) {
					return fmt.Sprintf(`OVERLAP: this shell command wrote %s; tell them: st sessions send %s "<what changed>" --delivery handshake`,
						h.holderLine(id, l, g.project.Root), l.AgentID)
				}
			}
		}
	}
	return ""
}

// ---------------------------------------------------------------- GitHub 403

const patDenied = "Resource not accessible by personal access token"

// GitHubPATDenied is the hook event when a shell call that ran gh / git push failed with GitHub's
// fine-grained-PAT 403 in its error channel (coord.github_pat_denied_event), else "".
func GitHubPATDenied(payload map[string]any) string {
	var commands []string
	if in, ok := payload["tool_input"].(map[string]any); ok {
		switch c := in["command"].(type) {
		case string:
			commands = []string{c}
		case []any:
			argv := make([]string, len(c))
			for i, a := range c {
				argv[i] = str(a)
			}
			commands = append(commands, shlexJoin(argv))
			if len(argv) > 0 {
				commands = append(commands, argv[len(argv)-1])
			}
		}
	}
	hit := false
	for _, c := range commands {
		hit = hit || invokesGitHub(c)
	}
	if !hit {
		return ""
	}
	channels := []any{payload["error"]}
	if resp, ok := payload["tool_response"].(map[string]any); ok {
		channels = append(channels, resp["stderr"])
	} else {
		channels = append(channels, payload["tool_response"])
	}
	for _, ch := range channels {
		if s, ok := ch.(string); ok && strings.Contains(s, patDenied) {
			if ev := str(payload["hook_event_name"]); ev != "" {
				return ev
			}
			return "PostToolUse"
		}
	}
	return ""
}

var assignment = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
var commandPrefixes = map[string]bool{"env": true, "command": true, "exec": true, "time": true, "timeout": true,
	"nice": true, "nohup": true, "sudo": true, "xargs": true}

// invokesGitHub: the command runs gh or git push, not merely quotes them.
func invokesGitHub(command string) bool {
	tokens, ok := shlexSplit(command)
	if !ok {
		return false
	}
	atStart, gitArgs, skip := true, false, false
	for _, tok := range tokens {
		if tok != "" && strings.Trim(tok, ";&|()\n$`") == "" {
			atStart, gitArgs = true, false
			continue
		}
		if atStart {
			name := tok[strings.LastIndex(tok, "/")+1:]
			if assignment.MatchString(tok) || commandPrefixes[name] || strings.HasPrefix(tok, "-") || isDigits(tok) {
				continue
			}
			if name == "gh" {
				return true
			}
			atStart, gitArgs, skip = false, name == "git", false
			continue
		}
		if gitArgs {
			switch {
			case skip:
				skip = false
			case tok == "-C" || tok == "-c":
				skip = true
			case !strings.HasPrefix(tok, "-"):
				if tok == "push" {
					return true
				}
				gitArgs = false
			}
		}
	}
	return false
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// shlexSplit is Python's shlex.shlex(posix=True, punctuation_chars=";&|()\n") with whitespace " \t\r",
// whitespace_split and '#' comments; false where shlex raises ValueError.
func shlexSplit(s string) ([]string, bool) {
	const punct = ";&|()\n"
	var out []string
	var tok strings.Builder
	quoted := false
	state := ' '
	escaped := 'a'
	in := []rune(s)
	flush := func() {
		if tok.Len() > 0 || quoted {
			out = append(out, tok.String())
		}
		tok.Reset()
		quoted = false
	}
	for i := 0; i <= len(in); i++ {
		var c rune
		eof := i == len(in)
		if !eof {
			c = in[i]
		}
		switch state {
		case ' ', 'a', 'c':
			if eof {
				flush()
				return out, true
			}
			isWS := c == ' ' || c == '\t' || c == '\r'
			isPunct := strings.ContainsRune(punct, c)
			switch {
			case state == 'c' && isPunct:
				tok.WriteRune(c)
			case state == 'c':
				flush()
				state = ' '
				i-- // re-read
			case isWS:
				if state != ' ' {
					flush()
					state = ' '
				}
			case c == '#':
				for i < len(in) && in[i] != '\n' {
					i++
				}
				if state != ' ' {
					flush()
					state = ' '
				}
			case c == '\\':
				escaped, state = 'a', '\\'
			case c == '\'' || c == '"':
				if state == ' ' {
					tok.Reset()
				}
				state = c
			case isPunct:
				if state == 'a' {
					flush()
				}
				tok.WriteRune(c)
				state = 'c'
			default:
				tok.WriteRune(c)
				state = 'a'
			}
		case '\'', '"':
			if eof {
				return nil, false
			}
			quoted = true
			switch {
			case c == state:
				state = 'a'
			case state == '"' && c == '\\':
				escaped, state = '"', '\\'
			default:
				tok.WriteRune(c)
			}
		case '\\':
			if eof {
				return nil, false
			}
			if escaped == '"' && c != '\\' && c != '"' {
				tok.WriteRune('\\')
			}
			tok.WriteRune(c)
			state = escaped
		}
	}
	return out, true
}

var unsafeShell = regexp.MustCompile(`[^\w@%+=:,./-]`)

func shlexJoin(argv []string) string {
	q := make([]string, len(argv))
	for i, a := range argv {
		switch {
		case a == "":
			q[i] = "''"
		case !unsafeShell.MatchString(a):
			q[i] = a
		default:
			q[i] = "'" + strings.ReplaceAll(a, "'", `'"'"'`) + "'"
		}
	}
	return strings.Join(q, " ")
}
