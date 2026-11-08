package guard

import (
	"os"
	"regexp"
	"strings"
)

// The irreversible-command policy: whole-tree git discards, recursive delete of
// protected roots, and disk, snapshot, backup and Proxmox destruction. Pure
// string and path logic over an argv; nothing here touches the filesystem.

// evaluateIrreversible walks the command the way the publication policy does,
// tracking `cd` so later segments are judged in the directory they run in.
func (r *Rules) evaluateIrreversible(command, cwd string, depth int) (decision, error) {
	if d, over := r.tooDeep(depth); over {
		return d, nil
	}
	var working string
	if cwd != "" {
		working = normPath(expandUser(cwd))
	} else {
		wd, err := os.Getwd()
		if err != nil {
			return allow(), err
		}
		working = wd
	}
	command, shellBodies, dataBodies := r.splitHeredocs(command)
	for _, nested := range append(shellBodies, r.substitutions(command)...) {
		d, err := r.evaluateIrreversible(nested, working, depth+1)
		if err != nil || d.blocked {
			return d, err
		}
	}
	for _, segment := range segments(command) {
		args := r.unwrap(segment)
		if len(args) == 0 {
			continue
		}
		executable := exeName(args[0])
		if executable == "cd" {
			target := "~"
			for _, a := range args[1:] {
				if !strings.HasPrefix(a, "-") {
					target = a
					break
				}
			}
			if !strings.Contains(target, "$") && !strings.Contains(target, "`") {
				working = normPath(joinPath(working, expandUser(target)))
			}
			continue
		}
		if r.shellExecutables.has(executable) || executable == "eval" {
			if nested, ok := nestedCommand(executable, args); ok {
				d, err := r.evaluateIrreversible(nested, working, depth+1)
				if err != nil || d.blocked {
					return d, err
				}
			}
			continue
		}
		if executable == "ssh" {
			// Remote commands get the same policy; the remote cwd is unknown, assume root's home.
			if remote, ok := sshRemoteCommand(r.sshValueLetters, args); ok && remote != "" {
				d, err := r.evaluateIrreversible(remote, r.remoteCwd, depth+1)
				if err != nil || d.blocked {
					return d, err
				}
			}
			continue
		}
		if depth == 0 {
			if d, ok := r.selfKillDecision(args, command); ok {
				return d, nil
			}
		}
		if d, ok := r.scriptDecision(args, dataBodies); ok {
			return d, nil
		}
		if d, ok := r.segmentDecision(args, working); ok {
			// Do not reflect the command: tool input can include embedded credentials.
			return d, nil
		}
	}
	return allow(), nil
}

// --- Aico durable state ------------------------------------------------------

// durableTarget is true when deleting target would destroy Aico durable state: a durable root or an
// ancestor of one, anything inside a durable directory, or a database or key file anywhere under a root.
// Other paths under the roots (logs, captures, deliveries) stay scratch.
func (r *Rules) durableTarget(target string) bool {
	for _, raw := range append(append([]string{}, r.durableRoots...), r.durableDirs...) {
		if under(normPath(expandUser(raw)), target) {
			return true
		}
	}
	if r.insideDurableDir(target) {
		return true
	}
	for _, raw := range r.durableRoots {
		if under(target, normPath(expandUser(raw))) {
			name := pathName(target)
			for _, suffix := range r.durableSuffixes {
				if strings.HasSuffix(name, suffix) {
					return true
				}
			}
		}
	}
	return false
}

func (r *Rules) insideDurableDir(target string) bool {
	for _, raw := range r.durableDirs {
		if under(target, normPath(expandUser(raw))) {
			return true
		}
	}
	return false
}

// durableOperands blocks a delete whose operand is durable state.
func (r *Rules) durableOperands(operands []string, cwd string) (decision, bool) {
	for _, operand := range operands {
		if target, ok := deletionTarget(operand, cwd); ok && r.durableTarget(target) {
			return blocked(r.message("durable_state", "{target}", target))
		}
	}
	return decision{}, false
}

// selfKillDecision blocks pkill -f whose pattern matches the command it runs in: the agent's shell
// has that text on its command line, so it dies (exit 144) and every later step, a commit included,
// is lost. A bare pkill on a remote host can be exec'd without a shell, so only the local command counts.
func (r *Rules) selfKillDecision(args []string, command string) (decision, bool) {
	if exeName(args[0]) != "pkill" {
		return decision{}, false
	}
	full := false
	pattern := ""
	for _, arg := range args[1:] {
		switch {
		case arg == "--full" || (strings.HasPrefix(arg, "-") && !strings.HasPrefix(arg, "--") && strings.Contains(arg, "f")):
			full = true
		case !strings.HasPrefix(arg, "-"):
			pattern = arg
		}
	}
	if !full || pattern == "" {
		return decision{}, false
	}
	matcher, err := regexp.Compile(pattern)
	if err != nil || !matcher.MatchString(command) {
		return decision{}, false
	}
	return blocked(r.message("pkill_self"))
}

// scriptDecision blocks an interpreter one-liner (python -c, node -e, or a script on stdin from a heredoc)
// that both calls a delete function and names Aico durable state in a string literal.
func (r *Rules) scriptDecision(args, stdinBodies []string) (decision, bool) {
	if r.scriptInterpreters == nil || !r.scriptInterpreters.MatchString(exeName(args[0])) {
		return decision{}, false
	}
	var code []string
	stdin := true
	for i := 1; i < len(args); i++ {
		if r.scriptCodeOptions.has(args[i]) && i+1 < len(args) {
			code = append(code, args[i+1])
			stdin = false
			i++
		} else if args[i] != "-" && !strings.HasPrefix(args[i], "-") && !strings.ContainsAny(args[i][:1], "<>") {
			stdin = false // a script file: its text is not in the command
			break
		}
	}
	if stdin {
		code = append(code, stdinBodies...)
	}
	for _, text := range code {
		if !r.scriptDeletes.MatchString(text) {
			continue
		}
		for _, m := range r.scriptLiteral.FindAllStringSubmatch(text, -1) {
			for _, literal := range m[1:] {
				// A bare "/" is a separator (path.split("/")), and it names no state.
				if literal == "" || literal == "/" || strings.Contains(literal, "$") {
					continue
				}
				// A literal may also be joined or appended to the home directory
				// (os.path.join(home, '.local/...'), homedir() + '/.local/...').
				for _, candidate := range []string{literal, "~/" + strings.TrimPrefix(literal, "/")} {
					if strings.HasPrefix(candidate, "/") || strings.HasPrefix(candidate, "~") {
						if target := normPath(expandUser(candidate)); r.durableTarget(target) {
							return blocked(r.message("durable_state", "{target}", target))
						}
					}
				}
			}
		}
	}
	return decision{}, false
}

// segmentDecision judges one unwrapped argv against the irreversible set.
func (r *Rules) segmentDecision(tokens []string, cwd string) (decision, bool) {
	if d, ok := r.systemDecision(tokens, cwd); ok {
		return d, true
	}
	subcommand, args, gitCwd, ok := r.gitInvocation(tokens, cwd)
	if !ok {
		return decision{}, false
	}
	shared := true
	for _, root := range r.disposableRoots {
		if under(gitCwd, root) {
			shared = false
		}
	}
	return r.gitDecision(subcommand, args, shared)
}

func blocked(message string) (decision, bool) { return decision{true, message}, true }

// --- git --------------------------------------------------------------------

// gitInvocation returns (subcommand, args, effective cwd) for an unwrapped git argv.
func (r *Rules) gitInvocation(tokens []string, cwd string) (string, []string, string, bool) {
	if len(tokens) < 2 || pathName(tokens[0]) != "git" {
		return "", nil, "", false
	}
	index := 1
	gitCwd := cwd
	for index < len(tokens) {
		token := tokens[index]
		switch {
		case token == "-C" && index+1 < len(tokens):
			gitCwd = normPath(joinPath(gitCwd, expandUser(tokens[index+1])))
			index += 2
		case strings.HasPrefix(token, "-C") && token != "-C":
			gitCwd = normPath(joinPath(gitCwd, expandUser(token[2:])))
			index++
		case r.irrGitGlobal.has(token) && index+1 < len(tokens):
			index += 2
		case strings.HasPrefix(token, "-"):
			index++
		default:
			return token, append([]string{}, tokens[index+1:]...), gitCwd, true
		}
	}
	return "", nil, "", false
}

func gitHasFlag(args []string, flags ...string) bool {
	for _, arg := range args {
		for _, f := range flags {
			if arg == f || strings.HasPrefix(arg, f+"=") {
				return true
			}
		}
	}
	return false
}

// shortFlags collects the letters of single-dash options up to "--".
func shortFlags(args []string) map[rune]bool {
	flags := map[rune]bool{}
	for _, arg := range args {
		if arg == "--" {
			break
		}
		if strings.HasPrefix(arg, "-") && !strings.HasPrefix(arg, "--") {
			for _, c := range arg[1:] {
				flags[c] = true
			}
		}
	}
	return flags
}

func pathsAfterDoubleDash(args []string) []string {
	for i, a := range args {
		if a == "--" {
			var out []string
			for _, t := range args[i+1:] {
				if !strings.HasPrefix(t, "-") {
					out = append(out, t)
				}
			}
			return out
		}
	}
	return nil
}

func stripOptionValues(args []string, valueFlags ...string) []string {
	var out []string
	for idx := 0; idx < len(args); {
		token := args[idx]
		switch {
		case containsStr(valueFlags, token):
			idx += 2
		case func() bool {
			for _, f := range valueFlags {
				if strings.HasPrefix(token, f+"=") {
					return true
				}
			}
			return false
		}():
			idx++
		default:
			out = append(out, token)
			idx++
		}
	}
	return out
}

// restorePaths are the pathspecs `git restore` would overwrite; stagingOnly for --staged without --worktree.
func restorePaths(args []string) (paths []string, stagingOnly bool) {
	if gitHasFlag(args, "--staged") && !gitHasFlag(args, "--worktree") {
		return nil, true
	}
	cleaned := stripOptionValues(args, "--source", "--pathspec-from-file")
	if explicit := pathsAfterDoubleDash(cleaned); len(explicit) > 0 {
		return explicit, false
	}
	for _, t := range cleaned {
		if !strings.HasPrefix(t, "-") {
			paths = append(paths, t)
		}
	}
	return paths, false
}

func (r *Rules) forcePushesSharedMain(args []string) bool {
	if !gitHasFlag(args, "-f", "--force") {
		return false
	}
	for _, arg := range args {
		if r.sharedMainBranches.has(arg) {
			return true
		}
		for _, suffix := range r.sharedMainSuffixes {
			if strings.HasSuffix(arg, suffix) {
				return true
			}
		}
	}
	return false
}

func (r *Rules) anyBroad(paths []string) bool {
	for _, p := range paths {
		if r.broadPathspecs.has(p) {
			return true
		}
	}
	return false
}

// gitDecision denies git commands that destroy uncommitted or shared work without recovery.
func (r *Rules) gitDecision(subcommand string, args []string, shared bool) (decision, bool) {
	if subcommand == "push" && r.forcePushesSharedMain(args) {
		return blocked(r.message("git_force_push_main"))
	}
	if !shared {
		return decision{}, false
	}
	switch subcommand {
	case "reset":
		if gitHasFlag(args, "--hard") {
			return blocked(r.message("git_reset_hard"))
		}
	case "clean":
		flags := shortFlags(args)
		forced := flags['f'] || gitHasFlag(args, "--force")
		dryRun := flags['n'] || gitHasFlag(args, "--dry-run")
		if forced && !dryRun {
			return blocked(r.message("git_clean"))
		}
	case "checkout":
		paths := pathsAfterDoubleDash(args)
		if (len(args) > 0 && args[0] == ".") || r.anyBroad(paths) {
			return blocked(r.message("git_checkout_all"))
		}
	case "restore":
		paths, stagingOnly := restorePaths(args)
		if !stagingOnly && r.anyBroad(paths) {
			return blocked(r.message("git_restore_all"))
		}
	case "stash":
		action := "push"
		if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
			action = args[0]
		}
		if r.stashDropActions.has(action) {
			return blocked(r.message("git_stash_drop"))
		}
		if !r.stashReadOrApply.has(action) {
			return blocked(r.message("git_stash"))
		}
	}
	return decision{}, false
}

// --- rm and protected roots -------------------------------------------------

// deletionTarget normalizes an rm operand to the directory it destroys; ok is false when unknowable.
func deletionTarget(token, cwd string) (string, bool) {
	home := expandUser("~")
	for _, prefix := range []string{"${HOME}", "$HOME"} {
		if token == prefix || strings.HasPrefix(token, prefix+"/") {
			token = home + token[len(prefix):]
		}
	}
	token = expandUser(token)
	if strings.Contains(token, "$") || strings.Contains(token, "`") {
		return "", false
	}
	// "dir/*" and "dir/.*" destroy dir's contents: judge dir itself.
	for token == "*" || token == ".*" || strings.HasSuffix(token, "/*") || strings.HasSuffix(token, "/.*") {
		if i := strings.LastIndexByte(token, '/'); i >= 0 {
			token = token[:i]
		} else {
			token = "."
		}
		if token == "" {
			token = "/"
		}
	}
	return normPath(joinPath(cwd, token)), true
}

// protectedDeletionRoot is true when recursively deleting target would destroy a protected root.
func (r *Rules) protectedDeletionRoot(target string) bool {
	home := normPath(expandUser("~"))
	if strings.Count(target, "/") <= 1 || target == home { // "/", "/etc", "/home", "/srv", ...
		return true
	}
	if r.protectedParents.has(dirName(target)) || r.protectedExact.has(target) {
		return true
	}
	return r.inStorageRoots(target)
}

func (r *Rules) inStorageRoots(target string) bool {
	for _, root := range r.mountedRoots {
		if under(target, root) {
			return true
		}
	}
	for _, root := range r.proxmoxRoots {
		if under(target, root) {
			return true
		}
	}
	return false
}

func (r *Rules) rmDecision(tokens []string, cwd string) (decision, bool) {
	recursive := false
	var operands []string
	optionsDone := false
	for _, token := range tokens[1:] {
		switch {
		case !optionsDone && token == "--":
			optionsDone = true
		case !optionsDone && strings.HasPrefix(token, "--"):
			recursive = recursive || token == "--recursive"
		case !optionsDone && strings.HasPrefix(token, "-") && token != "-":
			recursive = recursive || strings.ContainsAny(token[1:], "rR")
		default:
			operands = append(operands, token)
		}
	}
	for _, operand := range operands {
		if target, ok := deletionTarget(operand, cwd); ok && recursive && r.protectedDeletionRoot(target) {
			return blocked(r.message("rm_protected_root", "{target}", target))
		}
	}
	return r.durableOperands(operands, cwd)
}

// --- host-level commands: disks, snapshots, backups, Proxmox ------------------

func (r *Rules) systemBlocked(key string, vars ...string) (decision, bool) {
	return blocked(r.message(key, vars...))
}

func (r *Rules) realDevice(token string) bool {
	value := token
	if strings.HasPrefix(token, "of=") || strings.HasPrefix(token, "if=") {
		value = token[3:]
	}
	if strings.Contains(value, "$") || strings.Contains(value, "`") {
		return true
	}
	if !strings.HasPrefix(value, "/dev/") {
		return false
	}
	path := normPath(value)
	if r.harmlessDevices.has(path) {
		return false
	}
	for _, p := range r.harmlessPrefixes {
		if strings.HasPrefix(path, p) {
			return false
		}
	}
	return true
}

func (r *Rules) deviceOperands(args []string) bool {
	for _, a := range args {
		if !strings.HasPrefix(a, "-") && r.realDevice(a) {
			return true
		}
	}
	return false
}

// positionals are the non-option args, skipping the value of each value option.
func positionals(args []string, valueOptions set) []string {
	var out []string
	skip := false
	for _, arg := range args {
		switch {
		case skip:
			skip = false
		case valueOptions.has(arg):
			skip = true
		case !strings.HasPrefix(arg, "-"):
			out = append(out, arg)
		}
	}
	return out
}

func beforeEquals(s string) string {
	if i := strings.IndexByte(s, '='); i >= 0 {
		return s[:i]
	}
	return s
}

func (r *Rules) diskDecision(name string, tokens []string) (decision, bool) {
	args := tokens[1:]
	switch {
	case strings.HasPrefix(name, r.formatPrefix) || r.formatters.has(name) || r.discarders.has(name):
		if r.deviceOperands(args) {
			return r.systemBlocked("format_device", "{name}", name)
		}
	case name == "wipefs":
		flags := shortFlags(args)
		erasing := flags['a'] || flags['o'] || gitHasFlag(args, "--all", "--offset")
		dryRun := flags['n'] || gitHasFlag(args, "--no-act")
		if erasing && !dryRun && r.deviceOperands(args) {
			return r.systemBlocked("wipefs")
		}
	case name == "dd":
		for _, a := range args {
			if strings.HasPrefix(a, "of=") && r.realDevice(a) {
				return r.systemBlocked("dd_device")
			}
		}
	case name == "parted":
		if r.deviceOperands(args) {
			for _, a := range args {
				if r.partedWrites.has(pyLower(a)) {
					return r.systemBlocked("parted")
				}
			}
		}
	case name == "sgdisk":
		var options []string
		for _, a := range args {
			if strings.HasPrefix(a, "-") {
				options = append(options, beforeEquals(a))
			}
		}
		writes := false
		pretend := false
		for _, opt := range options {
			key := opt
			if !strings.HasPrefix(opt, "--") {
				if rs := []rune(opt); len(rs) > 2 {
					key = string(rs[:2])
				}
			}
			if !r.sgdiskReadOnly.has(key) {
				writes = true
			}
			if opt == "-P" || opt == "--pretend" {
				pretend = true
			}
		}
		if writes && !pretend && r.deviceOperands(args) {
			return r.systemBlocked("sgdisk")
		}
	case r.partitioners[name] != nil:
		readOnly := r.partitioners[name]
		listing := false
		for _, a := range args {
			if readOnly.has(beforeEquals(a)) {
				listing = true
			}
		}
		if !listing && r.deviceOperands(args) {
			return r.systemBlocked("partitioner", "{name}", name)
		}
	case name == "cryptsetup":
		destructive := false
		for _, a := range args {
			if r.cryptDestructive.has(pyLower(a)) {
				destructive = true
			}
		}
		if destructive && r.deviceOperands(args) {
			return r.systemBlocked("cryptsetup")
		}
	}
	return decision{}, false
}

func (r *Rules) snapshotTarget(raw, cwd string) bool {
	target, ok := deletionTarget(raw, cwd)
	text := raw
	if ok && target != "" {
		text = target
	}
	parts := strings.Split(pyLower(text), "/")
	if ok && target != "" && r.underDisposable(target) {
		return false // scratch is never backup history
	}
	if ok && (under(target, r.snapshotStore) || r.protectedDeletionRoot(target)) {
		return true
	}
	for _, part := range parts {
		if r.snapshotDirs.has(part) {
			return true
		}
		for _, marker := range r.snapshotParts {
			if strings.Contains(part, marker) {
				return true
			}
		}
	}
	return false
}

func (r *Rules) btrfsDecision(tokens []string, cwd string) (decision, bool) {
	words := positionals(tokens[1:], r.btrfsValue)
	if len(words) < 3 {
		return decision{}, false
	}
	group, action, targets := words[0], words[1], words[2:]
	if len(group) < 2 || !strings.HasPrefix("subvolume", group) || !strings.HasPrefix("delete", action) {
		return decision{}, false
	}
	for _, t := range targets {
		if r.snapshotTarget(t, cwd) {
			return r.systemBlocked("btrfs_subvolume_delete")
		}
	}
	return decision{}, false
}

func (r *Rules) resticDecision(tokens []string) (decision, bool) {
	words := positionals(tokens[1:], r.resticValue)
	if len(words) == 0 {
		return decision{}, false
	}
	dryRun := gitHasFlag(tokens, "--dry-run") || shortFlags(tokens[1:])['n']
	keyRemoval := words[0] == "key" && len(words) > 1 && r.resticKeyActions.has(words[1])
	if (r.resticActions.has(words[0]) && !dryRun) || keyRemoval {
		return r.systemBlocked("restic", "{action}", words[0])
	}
	return decision{}, false
}

func (r *Rules) rcloneDecision(tokens []string) (decision, bool) {
	args := tokens[1:]
	command, at := "", -1
	for i, a := range args {
		if r.rcloneDestructive.has(a) || r.rcloneMirrors.has(a) {
			command, at = a, i
			break
		}
	}
	if at < 0 || gitHasFlag(args, "--dry-run") || containsStr(args, "-n") {
		return decision{}, false
	}
	operands := positionals(args[at+1:], r.rcloneValue)
	if r.rcloneMirrors.has(command) {
		if len(operands) >= 2 && r.rcloneRemote.MatchString(operands[1]) {
			return r.systemBlocked("rclone_mirror", "{action}", command)
		}
		return decision{}, false
	}
	for _, o := range operands {
		if r.rcloneRemote.MatchString(o) {
			return r.systemBlocked("rclone_delete", "{action}", command)
		}
	}
	return decision{}, false
}

func (r *Rules) btrbkDecision(tokens []string) (decision, bool) {
	words := positionals(tokens[1:], r.btrbkValue)
	dryRun := gitHasFlag(tokens[1:], "--dry-run") || shortFlags(tokens[1:])['n']
	if len(words) > 0 && r.btrbkActions.has(words[0]) && !dryRun {
		return r.systemBlocked("btrbk", "{action}", words[0])
	}
	return decision{}, false
}

func (r *Rules) dmsetupDecision(tokens []string) (decision, bool) {
	words := positionals(tokens[1:], r.dmsetupValue)
	if len(words) == 0 || !r.dmsetupActions.has(words[0]) {
		return decision{}, false
	}
	targets := words[1:]
	scratchOnly := len(targets) > 0
	for _, t := range targets {
		if !strings.Contains(pyLower(t), r.dmsetupScratch) {
			scratchOnly = false
		}
	}
	// Only loop-backed scratch mappings may be removed; remove_all names no target.
	if words[0] == "remove_all" || !scratchOnly {
		return r.systemBlocked("dmsetup", "{action}", words[0])
	}
	return decision{}, false
}

func (r *Rules) findDecision(tokens []string, cwd string) (decision, bool) {
	args := append([]string{}, tokens[1:]...)
	for len(args) > 0 && (r.findGlobal.has(args[0]) || strings.HasPrefix(args[0], "-O")) {
		args = args[1:]
	}
	if len(args) > 0 && args[0] == "-D" {
		if len(args) >= 2 {
			args = args[2:]
		} else {
			args = nil
		}
	}
	var starts []string
	for len(args) > 0 && !strings.HasPrefix(args[0], "-") && args[0] != "(" && args[0] != "!" && args[0] != "," {
		starts = append(starts, args[0])
		args = args[1:]
	}
	deleting := containsStr(args, "-delete")
	selective := false
	for i, arg := range args {
		if r.findExecOptions.has(arg) && i+1 < len(args) && r.findDeleters.has(pathName(args[i+1])) {
			deleting = true
		}
		if r.findSelective.has(arg) {
			selective = true
		}
	}
	if !deleting {
		return decision{}, false
	}
	if len(starts) == 0 {
		starts = []string{"."}
	}
	for _, start := range starts {
		target, ok := deletionTarget(start, cwd)
		if !ok {
			continue
		}
		if r.inStorageRoots(target) || (r.protectedDeletionRoot(target) && !selective) {
			return r.systemBlocked("find_delete", "{target}", target)
		}
		// A selective find over a parent (find ~ -name x -delete) stays allowed, as for protected roots.
		if r.durableTarget(target) && (!selective || r.insideDurableDir(target)) {
			return r.systemBlocked("durable_state", "{target}", target)
		}
	}
	return decision{}, false
}

func (r *Rules) proxmoxDecision(name string, tokens []string) (decision, bool) {
	words := positionals(tokens[1:], nil)
	first := ""
	if len(words) > 0 {
		first = words[0]
	}
	switch {
	case r.guestTools.has(name) && first == "destroy":
		return r.systemBlocked("proxmox_guest", "{name}", name)
	case r.volumeTools.has(name) && !gitHasFlag(tokens[1:], "-t", "--test"):
		return r.systemBlocked("proxmox_volume", "{name}", name)
	case r.zfsTools.has(name) && first == "destroy" && !shortFlags(tokens[1:])['n']:
		return r.systemBlocked("proxmox_guest", "{name}", name)
	case name == "pvesm" && first == "free":
		return r.systemBlocked("pvesm_free")
	case name == "pvesh" && first == "delete":
		return r.systemBlocked("pvesh_delete")
	}
	return decision{}, false
}

// systemDecision denies host-level irreversible commands: protected-root rm/find,
// disk and LUKS destruction, snapshot and backup deletion, Proxmox destroys.
func (r *Rules) systemDecision(tokens []string, cwd string) (decision, bool) {
	if len(tokens) == 0 {
		return decision{}, false
	}
	name := pathName(tokens[0])
	switch name {
	case "rm":
		return r.rmDecision(tokens, cwd)
	case "unlink", "shred", "truncate":
		return r.durableOperands(positionals(tokens[1:], nil), cwd)
	case "find":
		return r.findDecision(tokens, cwd)
	case "btrfs":
		return r.btrfsDecision(tokens, cwd)
	case "restic":
		return r.resticDecision(tokens)
	case "rclone":
		return r.rcloneDecision(tokens)
	case "btrbk":
		return r.btrbkDecision(tokens)
	case "dmsetup":
		return r.dmsetupDecision(tokens)
	}
	if d, ok := r.diskDecision(name, tokens); ok {
		return d, true
	}
	return r.proxmoxDecision(name, tokens)
}

// underDisposable reports whether path lies under a scratch root nothing backs up.
func (r *Rules) underDisposable(path string) bool {
	for _, root := range r.disposableRoots {
		if under(path, root) {
			return true
		}
	}
	return false
}
