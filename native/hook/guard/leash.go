package guard

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// The leash: what an agent that nobody is watching may not do, on top of the publication and
// irreversible-command guard. The rules are data/leash.json; this file only applies them. It walks a
// command the way the guard does (nested shells, substitutions, `cd`), and judges each tool's paths.

type leashFile struct {
	Refusal         string              `json:"refusal"`
	AllowedTools    []string            `json:"allowed_tools"`
	ToolRefused     string              `json:"tool_refused"`
	AskTool         string              `json:"ask_tool"`
	AskRefused      string              `json:"ask_refused"`
	PathRefused     string              `json:"path_refused"`
	OutsideRefused  string              `json:"outside_refused"`
	UnknownRefused  string              `json:"unknown_target_refused"`
	RootRefused     string              `json:"root_refused"`
	WriteExtraRoots []string            `json:"write_extra_roots"`
	NullTargets     []string            `json:"null_targets"`
	DeniedPaths     []leashPath         `json:"denied_paths"`
	DeniedText      []leashText         `json:"denied_text"`
	DeniedCode      []leashText         `json:"denied_code"`
	MessageCommands [][]string          `json:"message_commands"`
	OptionTargets   map[string][]string `json:"option_targets"`
	WideCommands    []string            `json:"wide_commands"`
	WideRoots       []string            `json:"wide_roots"`
	WideRefused     string              `json:"wide_refused"`
	ScriptRunners   []string            `json:"script_runners"`
	ScriptReadBytes int64               `json:"script_read_bytes"`
	ValueOptions    map[string][]string `json:"value_options"`
	AllowedCommands [][]string          `json:"allowed_commands"`
	DeniedCommands  []leashCommand      `json:"denied_commands"`
	Mutators        map[string]string   `json:"mutators"`
	Deleters        []string            `json:"deleters"`
}

type leashPath struct {
	Path string `json:"path"`
	Why  string `json:"why"`
	re   *regexp.Regexp
}

type leashText struct {
	Pattern string `json:"pattern"`
	Why     string `json:"why"`
	re      *regexp.Regexp
}

type leashCommand struct {
	Argv   []string `json:"argv"`
	Option string   `json:"option"` // only with this option
	Why    string   `json:"why"`
}

// Leash is data/leash.json, compiled.
type Leash struct {
	f       leashFile
	tools   set
	runners set
	nulls   set
	delete  set
	rules   *Rules
}

// LoadLeash reads data/leash.json; the guard's rules give it the shell parsing.
func LoadLeash(path string, rules *Rules) (*Leash, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f leashFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("leash.json: %w", err)
	}
	if len(f.AllowedTools) == 0 || len(f.DeniedCommands) == 0 || f.Refusal == "" {
		return nil, fmt.Errorf("leash.json: allowed_tools, denied_commands and refusal are required")
	}
	for _, texts := range [][]leashText{f.DeniedText, f.DeniedCode} {
		for i := range texts {
			if texts[i].re, err = regexp.Compile(texts[i].Pattern); err != nil {
				return nil, fmt.Errorf("leash.json denied text: %w", err)
			}
		}
	}
	// A closed path counts as a whole path in text, not as part of a longer one (`docs/mnt/x`).
	for i := range f.DeniedPaths {
		f.DeniedPaths[i].re = regexp.MustCompile(`(^|[\s'"=:(<>,])` +
			regexp.QuoteMeta(normPath(expandUser(f.DeniedPaths[i].Path))) + `($|[/\s'";|&)*,])`)
	}
	return &Leash{f: f, tools: toSet(f.AllowedTools), runners: toSet(f.ScriptRunners),
		nulls: toSet(f.NullTargets), delete: toSet(f.Deleters), rules: rules}, nil
}

// Call is one tool call as the leash sees it.
type Call struct {
	Tool    string   // the tool's own name
	Command string   // a shell tool's command
	Path    string   // a file tool's path
	Writes  bool     // the file tool changes Path
	Cwd     string   // where a shell command starts
	Roots   []string // the session's folders: changes stay in these
}

func (l *Leash) refuse(why string) string { return strings.ReplaceAll(l.f.Refusal, "{why}", why) }

// Check is the refusal for one call, or "" when the leash has nothing against it.
func (l *Leash) Check(c Call) string {
	if c.Tool == l.f.AskTool {
		return l.refuse(strings.ReplaceAll(l.f.AskRefused, "{tool}", c.Tool))
	}
	if !l.tools.has(c.Tool) {
		return l.refuse(strings.ReplaceAll(l.f.ToolRefused, "{tool}", c.Tool))
	}
	roots := l.roots(c)
	if c.Command != "" {
		cwd := normPath(expandUser(c.Cwd))
		if why := l.closedWhy(cwd); why != "" {
			return l.refuse(why)
		}
		if why := l.walk(c.Command, cwd, roots, 0); why != "" {
			return l.refuse(why)
		}
		return ""
	}
	if c.Path == "" {
		return ""
	}
	target := normPath(joinPath(c.Cwd, expandUser(c.Path)))
	if why := l.textWhy(target); why != "" {
		return l.refuse(why)
	}
	if c.Writes {
		if !inRoots(target, roots) {
			return l.refuse(strings.ReplaceAll(l.f.OutsideRefused, "{path}", c.Path))
		}
	}
	return ""
}

func (l *Leash) roots(c Call) []string {
	var out []string
	for _, r := range append(append([]string{}, c.Roots...), l.f.WriteExtraRoots...) {
		out = append(out, normPath(expandUser(r)))
	}
	return out
}

func inRoots(target string, roots []string) bool {
	for _, r := range roots {
		if under(target, r) {
			return true
		}
	}
	return false
}

// homeWords spells the home folder the ways a command might before the text is searched.
func homeWords(text string) string {
	home := expandUser("~")
	for _, word := range []string{"${HOME}", "$HOME"} {
		text = strings.ReplaceAll(text, word, home)
	}
	return regexp.MustCompile(`(^|[\s=:'"(<>])~/`).ReplaceAllString(text, "${1}"+home+"/")
}

// textWhy finds a path or pattern the leash closes anywhere in the text, so a quoted script counts too.
func (l *Leash) textWhy(text string) string {
	if text == "" {
		return ""
	}
	spelled := homeWords(text)
	for _, p := range l.f.DeniedPaths {
		if p.re.MatchString(spelled) {
			return strings.ReplaceAll(l.f.PathRefused, "{why}", p.Why)
		}
	}
	for _, t := range l.f.DeniedText {
		if t.re.MatchString(spelled) {
			return t.Why
		}
	}
	return ""
}

// codeWhy finds what a program would do when run: only code that runs counts, not text that mentions it.
func (l *Leash) codeWhy(text string) string {
	for _, t := range l.f.DeniedCode {
		if t.re.MatchString(text) {
			return t.Why
		}
	}
	return ""
}

// closedWhy is the reason a resolved path is closed, as against one a text merely mentions.
func (l *Leash) closedWhy(path string) string {
	for _, p := range l.f.DeniedPaths {
		if under(path, normPath(expandUser(p.Path))) {
			return strings.ReplaceAll(l.f.PathRefused, "{why}", p.Why)
		}
	}
	return ""
}

// relativeWhy resolves each relative word against where the command runs: `cat .ssh/id_ed25519` after `cd ~`.
func (l *Leash) relativeWhy(args []string, cwd string) string {
	if cwd == unknownCwd {
		return ""
	}
	for _, a := range args[1:] {
		if a == "" || strings.HasPrefix(a, "-") || strings.HasPrefix(a, "/") || strings.HasPrefix(a, "~") {
			continue
		}
		if why := l.closedWhy(normPath(joinPath(cwd, a))); why != "" {
			return why
		}
	}
	return ""
}

// wideWhy: a search or size scan of a whole disk or home slows every session on this machine.
func (l *Leash) wideWhy(exe string, args []string, cwd string) string {
	if !toSet(l.f.WideCommands).has(exe) || cwd == unknownCwd {
		return ""
	}
	for _, a := range args[1:] {
		if strings.HasPrefix(a, "-") {
			continue
		}
		target := normPath(joinPath(cwd, expandUser(a)))
		for _, wide := range l.f.WideRoots {
			if target == normPath(expandUser(wide)) {
				return strings.ReplaceAll(l.f.WideRefused, "{path}", a)
			}
		}
	}
	return ""
}

// message is a command whose arguments are words for people: a commit subject can say `.env`.
func (l *Leash) message(args []string) bool {
	if len(args) == 0 {
		return false
	}
	exe := exeName(args[0])
	words := l.words(exe, args[1:])
	for _, m := range l.f.MessageCommands {
		if hasPrefix(exe, words, m) {
			return true
		}
	}
	return false
}

// maskSingleQuoted blanks single-quoted text, where the shell substitutes nothing.
func maskSingleQuoted(command string) string {
	out := []byte(command)
	inSingle, inDouble := false, false
	for i := 0; i < len(out); i++ {
		switch c := out[i]; {
		case inSingle && c == '\'':
			inSingle = false
		case inSingle:
			out[i] = ' '
		case c == '\\':
			i++
		case c == '"':
			inDouble = !inDouble
		case c == '\'' && !inDouble:
			inSingle = true
		}
	}
	return string(out)
}

// unknownCwd marks a command whose folder can't be told any more (`cd "$X"`, `popd`).
const unknownCwd = "\x00"

// walk judges every command a shell line would run: nested shells, substitutions and heredoc bodies, `cd` followed.
func (l *Leash) walk(command, cwd string, roots []string, depth int) string {
	if _, over := l.rules.tooDeep(depth); over {
		return "the command nests too deep to check."
	}
	command, shellBodies, dataBodies := l.rules.splitHeredocs(command)
	for _, nested := range append(shellBodies, l.rules.substitutions(maskSingleQuoted(command))...) {
		if why := l.walk(nested, cwd, roots, depth+1); why != "" {
			return why
		}
	}
	for _, body := range dataBodies {
		if why := l.textWhy(body); why != "" {
			return why
		}
		if why := l.codeWhy(body); why != "" {
			return why
		}
	}
	for _, segment := range segments(command) {
		if !l.message(segment) {
			if why := l.textWhy(strings.Join(segment, " ")); why != "" {
				return why
			}
		}
		// Each wrapper in turn counts (`sudo`, `timeout 5 sudo`), and what it runs.
		for _, args := range l.layers(segment) {
			if why := l.commandWhy(args); why != "" {
				return why
			}
		}
		if why := l.xargsWhy(segment); why != "" {
			return why
		}
		if why := l.redirectWhy(segment, cwd, roots); why != "" {
			return why
		}
		args := l.rules.unwrap(segment)
		if len(args) == 0 {
			continue
		}
		exe := exeName(args[0])
		if exe == "popd" {
			cwd = unknownCwd
			continue
		}
		if exe == "cd" || exe == "pushd" {
			target := "~"
			for _, a := range args[1:] {
				if !strings.HasPrefix(a, "-") {
					target = a
					break
				}
			}
			switch {
			case strings.Contains(target, "$") || strings.Contains(target, "`") || cwd == unknownCwd:
				cwd = unknownCwd
			default:
				cwd = normPath(joinPath(cwd, expandUser(target)))
				if why := l.closedWhy(cwd); why != "" {
					return why
				}
			}
			continue
		}
		if why := l.relativeWhy(args, cwd); why != "" {
			return why
		}
		if why := l.wideWhy(exe, args, cwd); why != "" {
			return why
		}
		if l.rules.shellExecutables.has(exe) || exe == "eval" {
			if nested, ok := nestedCommand(exe, args); ok {
				if why := l.walk(nested, cwd, roots, depth+1); why != "" {
					return why
				}
				continue
			}
		}
		if why := l.scriptWhy(exe, args, cwd, roots, depth); why != "" {
			return why
		}
		if why := l.targetsWhy(exe, args, cwd, roots); why != "" {
			return why
		}
	}
	return ""
}

// layers is a segment as written plus each step of unwrapping it, so a wrapper can't hide what it runs.
func (l *Leash) layers(segment []string) [][]string {
	out := [][]string{segment}
	if inner := l.rules.unwrap(segment); len(inner) > 0 && len(inner) != len(segment) {
		out = append(out, inner)
	}
	// xargs and find -exec hand the rest of the line to a program. Only in command position: `rg -n timeout docs` runs no timeout.
	if len(segment) == 0 {
		return out
	}
	follow := func(i int) {
		for j := i + 1; j < len(segment); j++ {
			if !strings.HasPrefix(segment[j], "-") {
				out = append(out, segment[j:])
				return
			}
		}
	}
	switch first := exeName(segment[0]); first {
	case "xargs", "parallel", "watch", "env", "time", "timeout", "nice":
		follow(0)
	case "find":
		for i, word := range segment {
			if word == "-exec" || word == "-execdir" || word == "-ok" {
				follow(i)
			}
		}
	}
	return out
}

// xargsWhy: what xargs changes comes from its input, so nothing can say where it lands.
func (l *Leash) xargsWhy(segment []string) string {
	if len(segment) == 0 || (exeName(segment[0]) != "xargs" && exeName(segment[0]) != "parallel") {
		return ""
	}
	for _, word := range segment[1:] {
		if _, changes := l.f.Mutators[exeName(word)]; changes {
			return strings.ReplaceAll(l.f.UnknownRefused, "{path}", word)
		}
	}
	return ""
}

// commandWhy applies allowed_commands then denied_commands to one argv.
func (l *Leash) commandWhy(args []string) string {
	if len(args) == 0 {
		return ""
	}
	exe := exeName(args[0])
	words := l.words(exe, args[1:])
	for _, allowed := range l.f.AllowedCommands {
		if hasPrefix(exe, words, allowed) {
			return ""
		}
	}
	for _, rule := range l.f.DeniedCommands {
		if rule.Argv[0] == "find" && exe == "find" && len(rule.Argv) == 2 {
			for _, a := range args[1:] {
				if a == rule.Argv[1] {
					return rule.Why
				}
			}
			continue
		}
		if hasPrefix(exe, words, rule.Argv) && (rule.Option == "" || toSet(args).has(rule.Option)) {
			return rule.Why
		}
	}
	return ""
}

// words is a command's arguments without its options, skipping the values of the options that take one.
func (l *Leash) words(exe string, args []string) []string {
	takes := toSet(l.f.ValueOptions[exe])
	var out []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") {
			if takes.has(a) {
				i++
			}
			continue
		}
		out = append(out, exeName(a))
	}
	return out
}

func hasPrefix(exe string, words, rule []string) bool {
	if len(rule) == 0 || rule[0] != exe || len(rule)-1 > len(words) {
		return false
	}
	for i, w := range rule[1:] {
		if words[i] != w {
			return false
		}
	}
	return true
}

// scriptWhy judges a script a command runs: `python3 x.py` or `./x.sh` hides what it does from everything above.
// A shell script's lines are walked like the command line; other code is searched.
func (l *Leash) scriptWhy(exe string, args []string, cwd string, roots []string, depth int) string {
	file := ""
	switch {
	case exe == "source" || args[0] == ".":
		if len(args) > 1 {
			file = args[1]
		}
	case l.runners.has(exe):
		if why := l.codeWhy(strings.Join(args[1:], " ")); why != "" {
			return why
		}
		for _, a := range args[1:] {
			if !strings.HasPrefix(a, "-") {
				file = a
				break
			}
		}
	case strings.Contains(args[0], "/"):
		file = args[0]
	}
	if file == "" || (cwd == unknownCwd && !strings.HasPrefix(file, "/")) {
		return ""
	}
	f, err := os.Open(joinPath(cwd, expandUser(file)))
	if err != nil {
		return ""
	}
	defer f.Close()
	raw := make([]byte, l.f.ScriptReadBytes)
	n, _ := f.Read(raw)
	body := string(raw[:n])
	shebang, _, _ := strings.Cut(body, "\n")
	hashBang := strings.HasPrefix(shebang, "#!")
	if strings.Contains(args[0], "/") && !hashBang {
		return "" // a built program, not a script
	}
	shell := exe == "source" || args[0] == "." || l.rules.shellExecutables.has(exe)
	if hashBang && !shell {
		for _, word := range strings.FieldsFunc(shebang[2:], func(c rune) bool { return c == ' ' || c == '/' }) {
			shell = shell || l.rules.shellExecutables.has(word)
		}
	}
	if why := l.textWhy(body); why != "" {
		return why
	}
	if shell {
		return l.walk(body, cwd, roots, depth+1)
	}
	return l.codeWhy(body)
}

// targetsWhy checks where a changing command points: inside the session's folders, and never the project itself.
func (l *Leash) targetsWhy(exe string, args []string, cwd string, roots []string) string {
	mode := l.f.Mutators[exe]
	var plain []string
	for i, a := range args[1:] {
		for _, option := range l.f.OptionTargets[exe] {
			target, inline := strings.CutPrefix(a, option+"=")
			if !inline && a == option && i+2 < len(args) {
				target, inline = args[i+2], true
			}
			if inline {
				if why := l.targetWhy(target, cwd, roots, false); why != "" {
					return why
				}
			}
		}
		if redirection.MatchString(a) {
			break
		}
		if !strings.HasPrefix(a, "-") {
			plain = append(plain, a)
		}
		if strings.HasPrefix(a, "of=") && exe == "dd" {
			plain, mode = []string{strings.TrimPrefix(a, "of=")}, "all"
			break
		}
	}
	if exe == "sed" || exe == "perl" {
		for _, a := range args[1:] {
			if inPlace.MatchString(a) || strings.HasPrefix(a, "--in-place") {
				mode = "last"
			}
		}
	}
	if mode == "" || len(plain) == 0 {
		return ""
	}
	if mode == "last" {
		plain = plain[len(plain)-1:]
	}
	for i, p := range plain {
		// What a mv moves leaves its place; where it lands doesn't (`mv sub/a.txt .`).
		deleting := l.delete.has(exe) && !(exe == "mv" && i == len(plain)-1 && len(plain) > 1)
		if why := l.targetWhy(p, cwd, roots, deleting); why != "" {
			return why
		}
	}
	return ""
}

var (
	redirection = regexp.MustCompile(`^\d*&?>`)
	inPlace     = regexp.MustCompile(`^-[a-zA-Z]*i`)
	allWildcard = regexp.MustCompile(`^[*?.]+$`)
)

func (l *Leash) targetWhy(p, cwd string, roots []string, deleting bool) string {
	if strings.ContainsAny(p, "$`") || (cwd == unknownCwd && !strings.HasPrefix(p, "/") && !strings.HasPrefix(p, "~")) {
		return strings.ReplaceAll(l.f.UnknownRefused, "{path}", p)
	}
	target := normPath(joinPath(cwd, expandUser(p)))
	if l.nulls.has(target) {
		return ""
	}
	// A wildcard's fixed start says where it can land. `rm *` empties the project; `rm *.log` is a tidy-up.
	tidy := false
	if i := strings.IndexAny(target, "*?["); i >= 0 {
		cut := strings.LastIndex(target[:i], "/") + 1
		pattern, _, _ := strings.Cut(target[cut:], "/")
		tidy = !allWildcard.MatchString(pattern)
		target = normPath(target[:cut])
	}
	if !inRoots(target, roots) {
		return strings.ReplaceAll(l.f.OutsideRefused, "{path}", p)
	}
	if deleting {
		for _, r := range roots {
			if (target == r && r != "/tmp" && !tidy) || strings.Contains(target+"/", "/.git/") {
				return strings.ReplaceAll(l.f.RootRefused, "{path}", p)
			}
		}
	}
	return ""
}

// redirectWhy checks `> file` the same way as a changing command.
func (l *Leash) redirectWhy(segment []string, cwd string, roots []string) string {
	for i, w := range segment {
		bare := strings.TrimLeft(w, "0123456789&")
		if !strings.HasPrefix(bare, ">") {
			continue
		}
		target := strings.TrimLeft(bare, ">")
		if target == "" && i+1 < len(segment) {
			target = segment[i+1]
		}
		if target == "" || strings.HasPrefix(target, "&") {
			continue
		}
		if why := l.targetWhy(target, cwd, roots, false); why != "" {
			return why
		}
	}
	return ""
}
