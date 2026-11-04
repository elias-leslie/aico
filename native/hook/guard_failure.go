package main

import (
	"regexp"
	"strings"
)

// guardFailed answers a PreToolUse call the guard could not judge: guard.json missing or broken, or a panic on the
// guard path. Shell and GitHub connector calls are refused with a plain reason; other calls (plain edits, reads)
// go ahead with a note. What counts as a shell or connector call is built in, since guard.json is what failed. A
// command on SummitFlow's old fallback deny list (publication_guard_entry.py) is named as such in the reason.
func guardFailed(payload map[string]any, why string) Out {
	refuse := func(extra string) Out {
		return Out{Event: "PreToolUse", Deny: why + ", so it refuses every shell and GitHub call until it is " +
			"repaired (reinstall with native/hook/install.sh in the aico repo)." + extra + " Tell the owner."}
	}
	input, ok := payload["tool_input"].(map[string]any)
	if !ok {
		return refuse(" This call's input was malformed too.")
	}
	command, present := input["command"]
	if !present {
		command = input["cmd"]
	}
	if command != nil {
		var text string
		switch c := command.(type) {
		case string:
			text = c
		case []any:
			for _, w := range c {
				s, _ := w.(string)
				text += s + " "
			}
		}
		for _, f := range fallbackDeny {
			if f.re.MatchString(text) {
				return refuse(" This command is also on the fallback deny list (" + f.label + ").")
			}
		}
		return refuse("")
	}
	tool := strings.ToLower(str(payload["tool_name"]))
	if builtinGuarded.MatchString(tool) {
		return refuse("")
	}
	return Out{Event: "PreToolUse", Context: []string{why + "; this call is neither a shell nor a GitHub call, " +
		"so it went ahead. Tell the owner."}}
}

// builtinGuarded is guard.json's payload.guarded_tools plus its shell and connector-mutation words, lower-cased.
var builtinGuarded = regexp.MustCompile(`^mcp__.*git|bash|exec_command|shell|merge_pull_request|create_release|` +
	`update_release|delete_release|push_files|create_or_update_file|create_repository`)

type labelled struct {
	re    *regexp.Regexp
	label string
}

// fallbackDeny is SummitFlow's conservative deny list for a guard without its policy (publication_guard_entry.py).
var fallbackDeny = func() []labelled {
	var out []labelled
	for _, p := range [][2]string{
		{`\b(?:git|jj)\b[\s\S]*\b(?:push|send-pack)\b`, "direct publication"},
		{`\bgh\b[\s\S]*\b(?:api|pr\s+merge|release|repo\s+(?:create|delete|archive|unarchive|rename|edit))\b`, "direct publication"},
		{`api\.github\.com`, "direct publication"},
		{`--no-verify|--dangerously-bypass-hook-trust|--disable-hooks|--disable\s+hooks`, "hook disable"},
		{`(?:SF_COMMAND_GUARD_DISABLE|GIT_ALLOW_SECRET|SECRETGUARD_DISABLE)\s*=`, "hook disable"},
		{`core\.hookspath|hooks\.enabled|features\.hooks`, "hook disable"},
		{`\brm\s+(?:-\S+\s+)*-\S*[rR]\S*\s+(?:-\S+\s+)*(?:/|/\*|~|~/|/srv|/srv/\S*|/home|\$HOME)(?:\s|$|;|&|\|)`, "recursive deletion of a root path"},
		{`\b(?:mkfs(?:\.\S+)?|wipefs|blkdiscard)\b`, "filesystem destruction"},
		{`\bdd\b[^\n]*\bof=/dev/`, "raw device overwrite"},
		{`\bbtrfs\s+(?:subvolume|sub)\s+(?:delete|del)\b`, "snapshot deletion"},
		{`\brestic\b[^\n]*\b(?:forget|prune|key\s+(?:remove|rm))\b`, "backup deletion"},
		{`\brclone\b[^\n]*\b(?:delete|deletefile|purge|cleanup|rmdirs)\b`, "backup deletion"},
		{`\bbtrbk\b[^\n]*\b(?:clean|prune)\b`, "snapshot deletion"},
		{`\bdmsetup\b[^\n]*\bremove`, "device-mapper teardown"},
		{`\bcryptsetup\b[^\n]*\b(?:luksFormat|erase|luksErase)\b`, "filesystem destruction"},
		{`\b(?:(?:qm|pct|zfs|zpool)\s+destroy|pvesm\s+free|pvesh\s+delete|lvremove|vgremove|pvremove)\b`, "proxmox storage destruction"},
		{`\bgit\b[\s\S]*\b(?:reset\s+--hard|clean\s+-\S*f)`, "destructive git"},
		{`\b(?:eval|base64\s+(?:-d|--decode))\b`, "unanalysable command"},
	} {
		out = append(out, labelled{regexp.MustCompile(`(?i)` + p[0]), p[1]})
	}
	return out
}()
