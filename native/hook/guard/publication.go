package guard

import (
	"strings"
	"unicode/utf8"
)

// decision is a CommandGuardDecision: whether the command is refused and why.
type decision struct {
	blocked bool
	message string
}

func allow() decision { return decision{} }

func (r *Rules) blockedPublication() decision {
	return decision{true, r.reasons.publication}
}

func (r *Rules) blockedHookDisable() decision {
	return decision{true, r.reasons.hookDisable}
}

// --- wrappers ---------------------------------------------------------------

func isAssignment(t string) bool {
	if t == "" || !(t[0] == '_' || (t[0]|0x20 >= 'a' && t[0]|0x20 <= 'z')) {
		return false
	}
	i := 1
	for i < len(t) && (t[i] == '_' || (t[i] >= '0' && t[i] <= '9') || (t[i]|0x20 >= 'a' && t[i]|0x20 <= 'z')) {
		i++
	}
	if i >= len(t) || t[i] != '=' {
		return false
	}
	// "^...=.*$": "." stops at a newline, "$" also matches before one final newline.
	return !strings.Contains(strings.TrimSuffix(t[i+1:], "\n"), "\n")
}

func (r *Rules) skipUVOptions(tokens []string, index int) []string {
	for index < len(tokens) && strings.HasPrefix(tokens[index], "-") {
		opt := tokens[index]
		index++
		if opt == "--" {
			break
		}
		if r.uvValueOptions.has(opt) {
			index++
		}
	}
	if index > len(tokens) {
		index = len(tokens)
	}
	return tokens[index:]
}

// uvCommand is the command `uv [opts] run|tool run [opts] CMD` runs; ok is false for other uv subcommands.
func (r *Rules) uvCommand(tokens []string) ([]string, bool) {
	rest := r.skipUVOptions(tokens, 1)
	if len(rest) > 0 && rest[0] == "run" {
		return r.skipUVOptions(rest, 1), true
	}
	if len(rest) > 0 && rest[0] == "tool" {
		rest = r.skipUVOptions(rest, 1)
		if len(rest) > 0 && rest[0] == "run" {
			return r.skipUVOptions(rest, 1), true
		}
	}
	return nil, false
}

// unwrapSegment strips env/sudo/exec/uv/nice-style wrappers and leading assignments.
func (r *Rules) unwrapSegment(segment []string) []string {
	tokens := segment
	idx := 0
	for idx < len(tokens) && isAssignment(tokens[idx]) {
		idx++
	}
	tokens = tokens[idx:]
	for len(tokens) > 0 {
		lead := pyCasefold(pathName(tokens[0]))
		switch {
		case lead == "env" || lead == "sudo":
			i := 1
			for i < len(tokens) {
				t := tokens[i]
				if t == "--" {
					i++
					break
				}
				value := r.envValueOptions
				if lead == "sudo" {
					value = r.sudoValueOptions
				}
				if value.has(t) && i+1 < len(tokens) {
					i += 2
				} else if strings.HasPrefix(t, "-") || isAssignment(t) {
					i++
				} else {
					break
				}
			}
			tokens = tokens[i:]
		case r.commandWrappers.has(lead):
			tokens = tokens[1:]
		case lead == "exec":
			i := 1
			for i < len(tokens) && strings.HasPrefix(tokens[i], "-") {
				opt := tokens[i]
				i++
				if opt == "--" {
					break
				}
				if strings.HasSuffix(opt, "a") && i < len(tokens) {
					i++
				}
			}
			tokens = tokens[i:]
		case lead == "uv" || lead == "uvx":
			if lead == "uvx" {
				tokens = r.skipUVOptions(tokens, 1)
			} else {
				rest, ok := r.uvCommand(tokens)
				if !ok {
					return tokens
				}
				tokens = rest
			}
		case r.optionWrappers.has(lead):
			i := 1
			for i < len(tokens) && strings.HasPrefix(tokens[i], "-") {
				opt := tokens[i]
				i++
				if (opt == "-n" || opt == "--adjustment" || opt == "-s" || opt == "--signal" || opt == "-k" || opt == "--kill-after") && i < len(tokens) {
					i++
				}
			}
			if lead == "timeout" && i < len(tokens) {
				i++ // timeout DURATION COMMAND: skip the positional duration
			}
			tokens = tokens[i:]
		default:
			return tokens
		}
	}
	return tokens
}

// unwrap also follows shell keywords (`if x; then git ...`) and xargs.
func (r *Rules) unwrap(segment []string) []string {
	args := r.unwrapSegment(segment)
	for len(args) > 0 && (r.keywords.has(args[0]) || exeName(args[0]) == "xargs") {
		if r.keywords.has(args[0]) {
			args = r.unwrapSegment(args[1:])
			continue
		}
		index := 1
		for index < len(args) && strings.HasPrefix(args[index], "-") {
			if r.xargsValueOptions.has(args[index]) {
				index += 2
			} else {
				index++
			}
		}
		if index > len(args) {
			index = len(args)
		}
		args = r.unwrapSegment(args[index:])
	}
	return args
}

// --- segmentation -----------------------------------------------------------

// splitShellSegments is the fallback split on ; && || | when quoting is broken.
func splitShellSegments(command string) [][]string {
	tokens, err := newShlexer(command, ";&|", " \t\r\n", true).all()
	if err != nil {
		return [][]string{{command}}
	}
	var segments [][]string
	var current []string
	for _, t := range tokens {
		if t == ";" || t == "&&" || t == "||" || t == "|" {
			if len(current) > 0 {
				segments = append(segments, current)
			}
			current = nil
		} else {
			current = append(current, t)
		}
	}
	if len(current) > 0 {
		segments = append(segments, current)
	}
	return segments
}

func onlySeparators(t string) bool {
	if t == "" {
		return false
	}
	for _, c := range t {
		if !strings.ContainsRune(";&|\n", c) {
			return false
		}
	}
	return true
}

// segments splits on ; & && || | and unquoted newlines and strips ( { ) } grouping.
func segments(command string) [][]string {
	tokens, err := newShlexer(command, ";&|\n", " \t\r", true).all()
	if err != nil {
		return splitShellSegments(command)
	}
	var parts [][]string
	var current []string
	for _, t := range tokens {
		if onlySeparators(t) {
			if len(current) > 0 {
				parts = append(parts, current)
			}
			current = nil
			continue
		}
		current = append(current, t)
	}
	if len(current) > 0 {
		parts = append(parts, current)
	}
	var cleaned [][]string
	for _, segment := range parts {
		for len(segment) > 0 && (segment[0] == "(" || segment[0] == "{" || segment[0] == "!") {
			segment = segment[1:]
		}
		if len(segment) == 0 {
			continue
		}
		seg := append([]string{}, segment...)
		seg[0] = strings.TrimLeft(seg[0], "({")
		seg[len(seg)-1] = strings.TrimRight(seg[len(seg)-1], ")}")
		var kept []string
		for _, t := range seg {
			if t != "" {
				kept = append(kept, t)
			}
		}
		if len(kept) == 0 {
			kept = seg
		}
		cleaned = append(cleaned, kept)
	}
	return cleaned
}

func shellExecArgs(args []string) (string, bool) {
	for idx, arg := range args {
		if arg == "-c" && idx+1 < len(args) {
			return args[idx+1], true
		}
		if strings.HasPrefix(arg, "-") && strings.Contains(arg[1:], "c") && idx+1 < len(args) {
			return args[idx+1], true
		}
	}
	return "", false
}

// nestedCommand is the command string a `bash -c` or `eval` segment runs.
func nestedCommand(executable string, args []string) (string, bool) {
	if executable == "eval" {
		joined := strings.Join(args[1:], " ")
		return joined, joined != ""
	}
	s, ok := shellExecArgs(args[1:])
	return s, ok && s != ""
}

func sshRemoteCommand(valueLetters string, args []string) (string, bool) {
	index := 1
	for index < len(args) && strings.HasPrefix(args[index], "-") {
		token := args[index]
		index++
		if token == "--" {
			break
		}
		runes := []rune(token)
		for position := 1; position < len(runes); position++ {
			if strings.ContainsRune(valueLetters, runes[position]) {
				if position == len(runes)-1 {
					index++ // value is the next argument
				}
				break
			}
		}
	}
	if index+1 >= len(args) {
		return "", false
	}
	return strings.Join(args[index+1:], " "), true
}

func (r *Rules) substitutions(command string) []string {
	var out []string
	for _, m := range r.substitution.FindAllStringSubmatch(command, -1) {
		switch {
		case m[1] != "":
			out = append(out, m[1])
		default:
			out = append(out, m[2])
		}
	}
	return out
}

// --- heredocs ---------------------------------------------------------------

type heredocMatch struct {
	start, end int
	dash       bool
	delimiter  string
	unquoted   bool // delimiter given bare, so the shell expands $(...) in the body
}

func (r *Rules) heredocOperators(line string) []heredocMatch {
	var out []heredocMatch
	pos := 0
	for pos <= len(line) {
		loc := r.heredocOperator.FindStringSubmatchIndex(line[pos:])
		if loc == nil {
			break
		}
		start := pos + loc[0]
		if start > 0 {
			prev, _ := utf8.DecodeLastRuneInString(line[:start])
			if prev == '<' || pyIsWord(prev) {
				pos = start + 1
				continue
			}
		}
		group := func(i int) string {
			if loc[2*i] < 0 {
				return ""
			}
			return line[pos+loc[2*i] : pos+loc[2*i+1]]
		}
		m := heredocMatch{start: start, end: pos + loc[1], dash: group(1) != ""}
		switch {
		case group(2) != "":
			m.delimiter = group(2)
		case group(3) != "":
			m.delimiter = group(3)
		default:
			m.delimiter = group(4)
			m.unquoted = group(4) != "" && !strings.Contains(line[m.start:m.end], `\`)
		}
		out = append(out, m)
		pos = m.end
	}
	return out
}

// splitHeredocs removes heredoc bodies and returns (command, shell bodies, data bodies).
//
// A body written to a file by cat/tee is inert data and is dropped. A body fed
// to a shell (`bash <<EOF` or `cat <<EOF | sh`) is returned for evaluation as
// commands; any other consumer's body is returned as data.
func (r *Rules) splitHeredocs(command string) (string, []string, []string) {
	lines := strings.Split(command, "\n")
	var kept, shellBodies, dataBodies []string
	index := 0
	for index < len(lines) {
		line := lines[index]
		kept = append(kept, line)
		index++
		operators := r.heredocOperators(line)
		if len(operators) == 0 {
			continue
		}
		kind := r.heredocConsumer(line, operators[0])
		for _, m := range operators {
			var body []string
			for index < len(lines) {
				candidate := lines[index]
				index++
				if m.dash {
					candidate = strings.TrimLeft(candidate, "\t")
				}
				if candidate == m.delimiter {
					kept = append(kept, lines[index-1])
					break
				}
				body = append(body, lines[index-1])
			}
			text := strings.Join(body, "\n")
			if m.unquoted {
				// Unquoted delimiter: the shell still expands $(...) in the body.
				shellBodies = append(shellBodies, r.substitutions(text)...)
			}
			switch kind {
			case "shell":
				shellBodies = append(shellBodies, text)
			case "other":
				dataBodies = append(dataBodies, text)
			}
		}
	}
	return strings.Join(kept, "\n"), shellBodies, dataBodies
}

func lastPiece(pieces []string) string { return pieces[len(pieces)-1] }

func (r *Rules) heredocConsumer(line string, m heredocMatch) string {
	before := lastPiece(r.consumerBoundary.Split(line[:m.start], -1))
	after := line[m.end:]
	pipeline := r.pipelineBoundary.Split(after, -1)[0]
	words, err := shlexSplit(before)
	if err != nil {
		return "other"
	}
	args := r.unwrap(words)
	executable := ""
	if len(args) > 0 {
		executable = exeName(args[0])
	}
	var downstream []string
	for _, part := range strings.Split(pipeline, "|")[1:] {
		downstream = append(downstream, pyStrip(part))
	}
	for _, part := range downstream {
		pw, err := shlexSplit(part)
		if err != nil {
			return "shell"
		}
		piped := r.unwrap(pw)
		if len(piped) > 0 && r.shellExecutables.has(exeName(piped[0])) {
			return "shell"
		}
	}
	if r.shellExecutables.has(executable) {
		if _, ok := shellExecArgs(args[1:]); !ok {
			return "shell"
		}
	}
	if executable == "ssh" {
		remote, ok := sshRemoteCommand(r.sshValueLetters, args)
		var remoteArgs []string
		if ok {
			remoteArgs = pyFields(remote)
		}
		hasC := false
		for _, a := range remoteArgs {
			if a == "-c" {
				hasC = true
			}
		}
		// `ssh host <<EOF` and `ssh host bash <<EOF` run the body as remote commands.
		if len(remoteArgs) == 0 || (r.shellExecutables.has(exeName(remoteArgs[0])) && !hasC) {
			return "shell"
		}
	}
	if r.dataSinks.has(executable) {
		segment := before + " " + strings.Split(pipeline, "|")[0]
		var writesFile bool
		if executable == "cat" {
			writesFile = strings.Contains(segment, ">")
		} else {
			for _, a := range args[1:] {
				if !strings.HasPrefix(a, "-") {
					writesFile = true
					break
				}
			}
		}
		inert := writesFile || (executable == "cat" && r.inertOutput(line[:m.start]))
		if inert && len(downstream) == 0 {
			return "data"
		}
	}
	return "other"
}

// inertOutput is true when `cat <<EOF` output is printed or captured as an
// argument (e.g. `git commit -m "$(cat <<EOF`), not run by a shell or eval.
func (r *Rules) inertOutput(prefix string) bool {
	cut := strings.LastIndex(prefix, "$(")
	if c := strings.LastIndex(prefix, "`"); c > cut {
		cut = c
	}
	if cut < 0 {
		return true
	}
	outer := lastPiece(r.prefixBoundary.Split(prefix[:cut], -1))
	outer = strings.ReplaceAll(strings.ReplaceAll(outer, `"`, " "), "'", " ")
	words := map[string]bool{}
	for _, w := range pyFields(outer) {
		words[exeName(w)] = true
	}
	// An empty outer command means the substitution itself is the command.
	if len(words) == 0 {
		return false
	}
	for w := range words {
		if r.shellExecutables.has(w) || r.nestedInertWords.has(w) {
			return false
		}
	}
	return true
}

// --- publication policy -----------------------------------------------------

func hasOption(args, short, long []string) bool {
	for _, arg := range args {
		for _, s := range short {
			if arg == s || (strings.HasPrefix(arg, s) && !strings.HasPrefix(arg, "--")) {
				return true
			}
		}
		for _, l := range long {
			if arg == l || strings.HasPrefix(arg, l+"=") {
				return true
			}
		}
	}
	return false
}

func containsStr(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func (r *Rules) publicationEndpoint(text string) bool {
	text = regexText(text, false)
	for _, re := range r.endpoints {
		if re.MatchString(text) {
			return true
		}
	}
	return false
}

func (r *Rules) mentionsGraphQLMutation(text string) bool {
	for _, w := range r.graphqlWords {
		if !strings.Contains(text, w) {
			return false
		}
	}
	return true
}

func (r *Rules) searchDisable(text string) bool {
	return r.disable.MatchString(regexText(text, true))
}

// evaluatePublication rejects ordinary direct publication without redirecting
// local or read commands. An accidental-bypass guard, not a security boundary.
func (r *Rules) evaluatePublication(command string) decision {
	command, shellBodies, dataBodies := r.splitHeredocs(command)
	// Heredoc data for non-shell consumers is not parsed as commands, but
	// hook-disable text in it stays refused.
	for _, body := range dataBodies {
		if r.searchDisable(body) {
			return r.blockedHookDisable()
		}
	}
	for _, nested := range append(shellBodies, r.substitutions(command)...) {
		if d := r.evaluatePublication(nested); d.blocked {
			return d
		}
	}
	for _, segment := range segments(command) {
		args := r.unwrap(segment)
		if len(args) == 0 {
			continue
		}
		executable := exeName(args[0])
		if r.readOnly.has(executable) {
			continue
		}
		if r.searchDisable(shlexJoin(segment)) {
			return r.blockedHookDisable()
		}
		if executable == "git" && containsStr(args, "config") && r.setsHooksPath(args) {
			return r.blockedHookDisable()
		}
		if r.shellExecutables.has(executable) || executable == "eval" {
			if nested, ok := nestedCommand(executable, args); ok {
				if d := r.evaluatePublication(nested); d.blocked {
					return d
				}
			}
		}
		if executable == "git" {
			index := 1
			for index < len(args) && strings.HasPrefix(args[index], "-") {
				if r.gitGlobalWithValue.has(args[index]) {
					index += 2
				} else {
					index++
				}
			}
			if index < len(args) && r.gitPublish.has(args[index]) {
				return r.blockedPublication()
			}
		}
		// Retired tools must still not bypass publication protection when installed.
		if executable == "jj" && containsStr(args[1:], "push") {
			return r.blockedPublication()
		}
		if executable == "gh" && len(args) > 2 && r.ghBlocked(args) {
			return r.blockedPublication()
		}
		if r.httpClients.has(executable) && len(args) > 1 {
			// Direct GitHub REST/GraphQL calls skip the pre-push verifier entirely.
			text := pyLower(shlexJoin(args[1:]))
			if r.githubAPI.MatchString(regexText(text, false)) {
				mutation := r.mutatingMethod.MatchString(regexText(shlexJoin(args), true))
				for _, arg := range args[1:] {
					if r.mutatingVerbs.has(pyUpper(arg)) {
						mutation = true
					}
				}
				mutation = mutation || hasOption(args[1:], r.httpBodyShort, r.httpBodyLong)
				if (mutation && r.publicationEndpoint(text)) || r.mentionsGraphQLMutation(text) {
					return r.blockedPublication()
				}
			}
		}
	}
	return allow()
}

// setsHooksPath is `git config ... core.hookspath ...` without a read-only flag.
func (r *Rules) setsHooksPath(args []string) bool {
	found := false
	for _, arg := range args {
		if pyLower(arg) == r.hookConfigKey {
			found = true
		}
	}
	if !found {
		return false
	}
	for _, flag := range r.configReadFlags {
		if containsStr(args, flag) {
			return false
		}
	}
	return true
}

func (r *Rules) ghBlocked(args []string) bool {
	blocked := (args[1] == "pr" && args[2] == "merge") ||
		(args[1] == "release" && r.ghReleaseActions.has(args[2])) ||
		(args[1] == "repo" && r.ghRepoActions.has(args[2])) ||
		(args[1] == "repo" && args[2] == "edit" && containsStr(args, r.ghVisibilityFlag))
	if args[1] == "api" {
		text := pyLower(shlexJoin(args[2:]))
		mutation := hasOption(args[2:], r.ghFieldShort, r.ghFieldLong)
		mutation = mutation || r.mutatingMethod.MatchString(regexText(shlexJoin(args), true))
		blocked = blocked || (mutation && r.publicationEndpoint(text)) || r.mentionsGraphQLMutation(text)
	}
	return blocked
}
