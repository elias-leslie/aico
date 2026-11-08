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
}

type leashText struct {
	Pattern string `json:"pattern"`
	Why     string `json:"why"`
	re      *regexp.Regexp
}

type leashCommand struct {
	Argv []string `json:"argv"`
	Why  string   `json:"why"`
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
	for i := range f.DeniedText {
		if f.DeniedText[i].re, err = regexp.Compile(f.DeniedText[i].Pattern); err != nil {
			return nil, fmt.Errorf("leash.json denied_text: %w", err)
		}
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
	Text    string   // what a file tool writes
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
		if why := l.textWhy(c.Command); why != "" {
			return l.refuse(why)
		}
		if why := l.walk(c.Command, normPath(expandUser(c.Cwd)), roots, 0); why != "" {
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
		if why := l.textWhy(c.Text); why != "" {
			return l.refuse(why)
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
		if strings.Contains(spelled, normPath(expandUser(p.Path))) {
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

// walk judges every command a shell line would run: nested shells, substitutions and heredoc bodies, `cd` followed.
func (l *Leash) walk(command, cwd string, roots []string, depth int) string {
	if _, over := l.rules.tooDeep(depth); over {
		return "the command nests too deep to check."
	}
	command, shellBodies, _ := l.rules.splitHeredocs(command)
	for _, nested := range append(shellBodies, l.rules.substitutions(command)...) {
		if why := l.walk(nested, cwd, roots, depth+1); why != "" {
			return why
		}
	}
	for _, segment := range segments(command) {
		// Each wrapper in turn counts (`sudo`, `timeout 5 sudo`), and what it runs.
		for _, args := range l.layers(segment) {
			if why := l.commandWhy(args); why != "" {
				return why
			}
		}
		if why := l.redirectWhy(segment, cwd, roots); why != "" {
			return why
		}
		args := l.rules.unwrap(segment)
		if len(args) == 0 {
			continue
		}
		exe := exeName(args[0])
		if exe == "cd" {
			target := "~"
			for _, a := range args[1:] {
				if !strings.HasPrefix(a, "-") {
					target = a
					break
				}
			}
			if !strings.Contains(target, "$") && !strings.Contains(target, "`") {
				cwd = normPath(joinPath(cwd, expandUser(target)))
			}
			continue
		}
		if l.rules.shellExecutables.has(exe) || exe == "eval" {
			if nested, ok := nestedCommand(exe, args); ok {
				if why := l.walk(nested, cwd, roots, depth+1); why != "" {
					return why
				}
				continue
			}
		}
		if why := l.scriptWhy(exe, args, cwd); why != "" {
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
	// xargs, find -exec and the like hand the rest of the line to a program: judge what follows each of them.
	for i, word := range segment {
		switch exeName(word) {
		case "xargs", "-exec", "-execdir", "-ok", "parallel", "watch", "env", "time", "timeout", "nice":
			if i+1 < len(segment) {
				for j := i + 1; j < len(segment); j++ {
					if !strings.HasPrefix(segment[j], "-") {
						out = append(out, segment[j:])
						break
					}
				}
			}
		}
	}
	return out
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
		if hasPrefix(exe, words, rule.Argv) {
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

// scriptWhy reads a script the command runs: `python3 x.py` hides its deletes from everything above.
func (l *Leash) scriptWhy(exe string, args []string, cwd string) string {
	if !l.runners.has(exe) {
		return ""
	}
	for _, a := range args[1:] {
		if strings.HasPrefix(a, "-") {
			continue
		}
		f, err := os.Open(joinPath(cwd, expandUser(a)))
		if err != nil {
			return ""
		}
		defer f.Close()
		body := make([]byte, l.f.ScriptReadBytes)
		n, _ := f.Read(body)
		return l.textWhy(string(body[:n]))
	}
	return ""
}

// targetsWhy checks where a changing command points: inside the session's folders, and never the project itself.
func (l *Leash) targetsWhy(exe string, args []string, cwd string, roots []string) string {
	mode := l.f.Mutators[exe]
	var plain []string
	for _, a := range args[1:] {
		if a == ">" || a == ">>" || strings.HasPrefix(a, ">") {
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
	if exe == "sed" {
		for _, a := range args[1:] {
			if strings.HasPrefix(a, "-i") || a == "--in-place" {
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
	for _, p := range plain {
		if why := l.targetWhy(p, cwd, roots, l.delete.has(exe)); why != "" {
			return why
		}
	}
	return ""
}

func (l *Leash) targetWhy(p, cwd string, roots []string, deleting bool) string {
	if strings.ContainsAny(p, "$`") {
		return strings.ReplaceAll(l.f.UnknownRefused, "{path}", p)
	}
	target := normPath(joinPath(cwd, expandUser(p)))
	if l.nulls.has(target) {
		return ""
	}
	// A wildcard's fixed start says where it can land.
	if i := strings.IndexAny(target, "*?["); i >= 0 {
		target = normPath(target[:strings.LastIndex(target[:i], "/")+1])
		if deleting {
			for _, r := range roots {
				if target == r && !strings.HasPrefix(r, "/tmp") {
					return strings.ReplaceAll(l.f.RootRefused, "{path}", p)
				}
			}
		}
	}
	if !inRoots(target, roots) {
		return strings.ReplaceAll(l.f.OutsideRefused, "{path}", p)
	}
	if deleting {
		for _, r := range roots {
			if (target == r && r != "/tmp") || strings.Contains(target+"/", "/.git/") {
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
