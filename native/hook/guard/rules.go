package guard

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
)

// Rules is the guard policy: every word list, path, pattern and reason text
// from data/guard.json, with the patterns compiled once. Logic lives in the
// other files of this package; a Rules is read-only after Load.
type Rules struct {
	reasons struct{ publication, hookDisable, evaluationError, tooDeep, tooLarge, tooSlow string }

	guarded            *regexp.Regexp // the tool names the guard judges
	connectorMutations []string
	shellTools         []string

	// Bounds on one evaluation: nesting (eval, bash -c, $(...), heredocs, ssh), command size and wall time.
	maxDepth int
	maxBytes int
	deadline time.Duration

	shellExecutables  set
	keywords          set
	xargsValueOptions set
	commandWrappers   set
	optionWrappers    set
	envValueOptions   set
	sudoValueOptions  set
	uvValueOptions    set
	nestedInertWords  set

	readOnly           set
	disable            *regexp.Regexp
	hookConfigKey      string
	configReadFlags    []string
	gitGlobalWithValue set
	gitPublish         set
	ghReleaseActions   set
	ghRepoActions      set
	ghVisibilityFlag   string
	ghFieldShort       []string
	ghFieldLong        []string
	httpClients        set
	httpBodyShort      []string
	httpBodyLong       []string
	mutatingVerbs      set
	mutatingMethod     *regexp.Regexp
	githubAPI          *regexp.Regexp
	endpoints          []*regexp.Regexp
	graphqlWords       []string
	heredocOperator    *regexp.Regexp
	consumerBoundary   *regexp.Regexp
	pipelineBoundary   *regexp.Regexp
	prefixBoundary     *regexp.Regexp
	substitution       *regexp.Regexp
	dataSinks          set

	irrGitGlobal       set
	disposableRoots    []string
	sharedMainBranches set
	sharedMainSuffixes []string
	broadPathspecs     set
	stashReadOrApply   set
	stashDropActions   set

	mountedRoots     []string
	proxmoxRoots     []string
	protectedParents set
	protectedExact   set
	remoteCwd        string
	snapshotStore    string
	snapshotDirs     set
	snapshotParts    []string
	durableRoots     []string
	durableDirs      []string
	durableSuffixes  []string

	scriptInterpreters *regexp.Regexp
	scriptCodeOptions  set
	scriptDeletes      *regexp.Regexp
	scriptLiteral      *regexp.Regexp

	harmlessDevices  set
	harmlessPrefixes []string
	formatters       set
	formatPrefix     string
	discarders       set
	partedWrites     set
	sgdiskReadOnly   set
	partitioners     map[string]set
	cryptDestructive set

	resticValue       set
	resticActions     set
	resticKeyActions  set
	rcloneDestructive set
	rcloneMirrors     set
	rcloneValue       set
	rcloneRemote      *regexp.Regexp
	btrbkValue        set
	btrbkActions      set
	dmsetupValue      set
	dmsetupActions    set
	dmsetupScratch    string
	btrfsValue        set

	findGlobal      set
	findSelective   set
	findDeleters    set
	findExecOptions set

	guestTools  set
	volumeTools set
	zfsTools    set

	sshValueLetters string
	messages        map[string]string
	replacer        *strings.Replacer
}

type set map[string]struct{}

func toSet(items []string) set {
	s := make(set, len(items))
	for _, it := range items {
		s[it] = struct{}{}
	}
	return s
}

func (s set) has(v string) bool { _, ok := s[v]; return ok }

// file mirrors data/guard.json.
type file struct {
	Reasons struct {
		Publication     string `json:"publication"`
		HookDisable     string `json:"hook_disable"`
		EvaluationError string `json:"evaluation_error"`
		TooDeep         string `json:"too_deep"`
		TooLarge        string `json:"too_large"`
		TooSlow         string `json:"too_slow"`
	} `json:"reasons"`
	Limits struct {
		MaxNestingDepth int `json:"max_nesting_depth"`
		MaxCommandBytes int `json:"max_command_bytes"`
		DeadlineMS      int `json:"deadline_ms"`
	} `json:"limits"`
	Payload struct {
		GuardedTools       string   `json:"guarded_tools"`
		ConnectorMutations []string `json:"connector_mutations"`
		ShellTools         []string `json:"shell_tools"`
	} `json:"payload"`
	Shell struct {
		Executables       []string `json:"executables"`
		Keywords          []string `json:"keywords"`
		XargsValueOptions []string `json:"xargs_value_options"`
		CommandWrappers   []string `json:"command_wrappers"`
		OptionWrappers    []string `json:"option_wrappers"`
		EnvValueOptions   []string `json:"env_value_options"`
		SudoValueOptions  []string `json:"sudo_value_options"`
		UvValueOptions    []string `json:"uv_value_options"`
		NestedInertWords  []string `json:"nested_inert_words"`
	} `json:"shell"`
	Publication struct {
		ReadOnly              []string `json:"read_only"`
		DisablePattern        string   `json:"disable_pattern"`
		HookConfigKey         string   `json:"hook_config_key"`
		ConfigReadFlags       []string `json:"config_read_flags"`
		GitGlobalWithValue    []string `json:"git_global_options_with_value"`
		GitPublishSubcommands []string `json:"git_publish_subcommands"`
		GhReleaseActions      []string `json:"gh_release_actions"`
		GhRepoActions         []string `json:"gh_repo_actions"`
		GhVisibilityFlag      string   `json:"gh_visibility_flag"`
		GhFieldShort          []string `json:"gh_field_short"`
		GhFieldLong           []string `json:"gh_field_long"`
		HTTPClients           []string `json:"http_clients"`
		HTTPBodyShort         []string `json:"http_body_short"`
		HTTPBodyLong          []string `json:"http_body_long"`
		MutatingVerbs         []string `json:"mutating_verbs"`
		MutatingMethodPattern string   `json:"mutating_method_pattern"`
		GithubAPIPattern      string   `json:"github_api_pattern"`
		EndpointPatterns      []string `json:"endpoint_patterns"`
		GraphqlWords          []string `json:"graphql_words"`
	} `json:"publication"`
	Heredoc struct {
		OperatorPattern         string   `json:"operator_pattern"`
		ConsumerBoundaryPattern string   `json:"consumer_boundary_pattern"`
		PipelineBoundaryPattern string   `json:"pipeline_boundary_pattern"`
		PrefixBoundaryPattern   string   `json:"prefix_boundary_pattern"`
		SubstitutionPattern     string   `json:"substitution_pattern"`
		DataSinks               []string `json:"data_sinks"`
	} `json:"heredoc"`
	Git struct {
		GlobalWithValue    []string `json:"global_options_with_value"`
		DisposableRoots    []string `json:"disposable_roots"`
		SharedMainBranches []string `json:"shared_main_branches"`
		SharedMainSuffixes []string `json:"shared_main_suffixes"`
		BroadPathspecs     []string `json:"broad_pathspecs"`
		StashReadOrApply   []string `json:"stash_read_or_apply"`
		StashDropActions   []string `json:"stash_drop_actions"`
	} `json:"git"`
	Paths struct {
		MountedRoots     []string `json:"mounted_storage_roots"`
		ProxmoxRoots     []string `json:"proxmox_data_roots"`
		ProtectedParents []string `json:"protected_parents"`
		ProtectedExact   []string `json:"protected_exact"`
		RemoteCwd        string   `json:"remote_cwd"`
		SnapshotStore    string   `json:"snapshot_store"`
		SnapshotDirs     []string `json:"snapshot_dir_names"`
		SnapshotParts    []string `json:"snapshot_name_parts"`
		DurableRoots     []string `json:"durable_roots"`
		DurableDirs      []string `json:"durable_dirs"`
		DurableSuffixes  []string `json:"durable_file_suffixes"`
	} `json:"paths"`
	Scripts struct {
		InterpreterPattern string   `json:"interpreter_pattern"`
		CodeOptions        []string `json:"code_options"`
		DeletePattern      string   `json:"delete_pattern"`
		LiteralPattern     string   `json:"literal_pattern"`
	} `json:"scripts"`
	Disk struct {
		HarmlessDevices  []string            `json:"harmless_devices"`
		HarmlessPrefixes []string            `json:"harmless_device_prefixes"`
		Formatters       []string            `json:"formatters"`
		FormatPrefix     string              `json:"format_prefix"`
		Discarders       []string            `json:"discarders"`
		PartedWrites     []string            `json:"parted_writes"`
		SgdiskReadOnly   []string            `json:"sgdisk_read_only"`
		PartitionerRO    map[string][]string `json:"partitioner_read_only"`
		CryptDestructive []string            `json:"cryptsetup_destructive"`
	} `json:"disk"`
	Backup struct {
		ResticValue       []string `json:"restic_value_options"`
		ResticActions     []string `json:"restic_actions"`
		ResticKeyActions  []string `json:"restic_key_actions"`
		RcloneDestructive []string `json:"rclone_destructive"`
		RcloneMirrors     []string `json:"rclone_mirrors"`
		RcloneValue       []string `json:"rclone_value_options"`
		RcloneRemote      string   `json:"rclone_remote_pattern"`
		BtrbkValue        []string `json:"btrbk_value_options"`
		BtrbkActions      []string `json:"btrbk_actions"`
		DmsetupValue      []string `json:"dmsetup_value_options"`
		DmsetupActions    []string `json:"dmsetup_actions"`
		DmsetupScratch    string   `json:"dmsetup_scratch_marker"`
		BtrfsValue        []string `json:"btrfs_value_options"`
	} `json:"backup"`
	Find struct {
		Global      []string `json:"global_options"`
		Selective   []string `json:"selective"`
		Deleters    []string `json:"deleting_executables"`
		ExecOptions []string `json:"exec_options"`
	} `json:"find"`
	Proxmox struct {
		GuestTools  []string `json:"guest_tools"`
		VolumeTools []string `json:"volume_tools"`
		ZfsTools    []string `json:"zfs_tools"`
	} `json:"proxmox"`
	SSH struct {
		ValueLetters string `json:"value_option_letters"`
	} `json:"ssh"`
	Messages map[string]string `json:"messages"`
}

// Load reads and compiles the rules file (data/guard.json next to the binary).
func Load(path string) (*Rules, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f file
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("guard rules %s: %w", path, err)
	}
	return build(&f)
}

func build(f *file) (*Rules, error) {
	r := &Rules{}
	var err error
	compile := func(name, pattern string) *regexp.Regexp {
		re, e := regexp.Compile(pattern)
		if e != nil && err == nil {
			err = fmt.Errorf("guard rules: %s: %w", name, e)
		}
		return re
	}
	r.reasons.publication = f.Reasons.Publication
	r.reasons.hookDisable = f.Reasons.HookDisable
	r.reasons.evaluationError = f.Reasons.EvaluationError
	r.reasons.tooDeep, r.reasons.tooLarge, r.reasons.tooSlow = f.Reasons.TooDeep, f.Reasons.TooLarge, f.Reasons.TooSlow
	for name, text := range map[string]string{"publication": r.reasons.publication, "hook_disable": r.reasons.hookDisable,
		"evaluation_error": r.reasons.evaluationError, "too_deep": r.reasons.tooDeep, "too_large": r.reasons.tooLarge,
		"too_slow": r.reasons.tooSlow} {
		if text == "" && err == nil {
			err = fmt.Errorf("guard rules: missing reason %q", name)
		}
	}
	r.maxDepth = orDefault(f.Limits.MaxNestingDepth, DefaultMaxDepth)
	r.maxBytes = orDefault(f.Limits.MaxCommandBytes, DefaultMaxBytes)
	deadlineMS := orDefault(f.Limits.DeadlineMS, DefaultDeadlineMS)
	r.deadline = time.Duration(deadlineMS) * time.Millisecond
	limit := func(text string, n int) string { return strings.ReplaceAll(text, "{limit}", fmt.Sprint(n)) }
	r.reasons.tooDeep = limit(r.reasons.tooDeep, r.maxDepth)
	r.reasons.tooLarge = limit(r.reasons.tooLarge, r.maxBytes)
	r.reasons.tooSlow = limit(r.reasons.tooSlow, deadlineMS)
	if f.Payload.GuardedTools == "" && err == nil {
		err = fmt.Errorf("guard rules: missing payload.guarded_tools")
	}
	r.guarded = compile("guarded_tools", f.Payload.GuardedTools)
	r.connectorMutations = f.Payload.ConnectorMutations
	r.shellTools = f.Payload.ShellTools

	r.shellExecutables = toSet(f.Shell.Executables)
	r.keywords = toSet(f.Shell.Keywords)
	r.xargsValueOptions = toSet(f.Shell.XargsValueOptions)
	r.commandWrappers = toSet(f.Shell.CommandWrappers)
	r.optionWrappers = toSet(f.Shell.OptionWrappers)
	r.envValueOptions = toSet(f.Shell.EnvValueOptions)
	r.sudoValueOptions = toSet(f.Shell.SudoValueOptions)
	r.uvValueOptions = toSet(f.Shell.UvValueOptions)
	r.nestedInertWords = toSet(f.Shell.NestedInertWords)

	p := &f.Publication
	r.readOnly = toSet(p.ReadOnly)
	r.disable = compile("disable_pattern", p.DisablePattern)
	r.hookConfigKey = p.HookConfigKey
	r.configReadFlags = p.ConfigReadFlags
	r.gitGlobalWithValue = toSet(p.GitGlobalWithValue)
	r.gitPublish = toSet(p.GitPublishSubcommands)
	r.ghReleaseActions = toSet(p.GhReleaseActions)
	r.ghRepoActions = toSet(p.GhRepoActions)
	r.ghVisibilityFlag = p.GhVisibilityFlag
	r.ghFieldShort, r.ghFieldLong = p.GhFieldShort, p.GhFieldLong
	r.httpClients = toSet(p.HTTPClients)
	r.httpBodyShort, r.httpBodyLong = p.HTTPBodyShort, p.HTTPBodyLong
	r.mutatingVerbs = toSet(p.MutatingVerbs)
	r.mutatingMethod = compile("mutating_method_pattern", p.MutatingMethodPattern)
	r.githubAPI = compile("github_api_pattern", p.GithubAPIPattern)
	for i, e := range p.EndpointPatterns {
		r.endpoints = append(r.endpoints, compile(fmt.Sprintf("endpoint_patterns[%d]", i), e))
	}
	r.graphqlWords = p.GraphqlWords

	h := &f.Heredoc
	r.heredocOperator = compile("operator_pattern", h.OperatorPattern)
	r.consumerBoundary = compile("consumer_boundary_pattern", h.ConsumerBoundaryPattern)
	r.pipelineBoundary = compile("pipeline_boundary_pattern", h.PipelineBoundaryPattern)
	r.prefixBoundary = compile("prefix_boundary_pattern", h.PrefixBoundaryPattern)
	r.substitution = compile("substitution_pattern", h.SubstitutionPattern)
	r.dataSinks = toSet(h.DataSinks)

	g := &f.Git
	r.irrGitGlobal = toSet(g.GlobalWithValue)
	r.disposableRoots = g.DisposableRoots
	r.sharedMainBranches = toSet(g.SharedMainBranches)
	r.sharedMainSuffixes = g.SharedMainSuffixes
	r.broadPathspecs = toSet(g.BroadPathspecs)
	r.stashReadOrApply = toSet(g.StashReadOrApply)
	r.stashDropActions = toSet(g.StashDropActions)

	pp := &f.Paths
	r.mountedRoots, r.proxmoxRoots = pp.MountedRoots, pp.ProxmoxRoots
	r.protectedParents = toSet(pp.ProtectedParents)
	r.protectedExact = toSet(pp.ProtectedExact)
	r.remoteCwd = pp.RemoteCwd
	r.snapshotStore = pp.SnapshotStore
	r.snapshotDirs = toSet(pp.SnapshotDirs)
	r.snapshotParts = pp.SnapshotParts
	r.durableRoots, r.durableDirs, r.durableSuffixes = pp.DurableRoots, pp.DurableDirs, pp.DurableSuffixes
	sc := &f.Scripts
	if sc.InterpreterPattern != "" && sc.DeletePattern != "" && sc.LiteralPattern != "" {
		r.scriptInterpreters = compile("interpreter_pattern", sc.InterpreterPattern)
		r.scriptDeletes = compile("delete_pattern", sc.DeletePattern)
		r.scriptLiteral = compile("literal_pattern", sc.LiteralPattern)
	}
	r.scriptCodeOptions = toSet(sc.CodeOptions)

	d := &f.Disk
	r.harmlessDevices = toSet(d.HarmlessDevices)
	r.harmlessPrefixes = d.HarmlessPrefixes
	r.formatters = toSet(d.Formatters)
	r.formatPrefix = d.FormatPrefix
	r.discarders = toSet(d.Discarders)
	r.partedWrites = toSet(d.PartedWrites)
	r.sgdiskReadOnly = toSet(d.SgdiskReadOnly)
	r.partitioners = map[string]set{}
	for name, flags := range d.PartitionerRO {
		r.partitioners[name] = toSet(flags)
	}
	r.cryptDestructive = toSet(d.CryptDestructive)

	b := &f.Backup
	r.resticValue = toSet(b.ResticValue)
	r.resticActions = toSet(b.ResticActions)
	r.resticKeyActions = toSet(b.ResticKeyActions)
	r.rcloneDestructive = toSet(b.RcloneDestructive)
	r.rcloneMirrors = toSet(b.RcloneMirrors)
	r.rcloneValue = toSet(b.RcloneValue)
	r.rcloneRemote = compile("rclone_remote_pattern", b.RcloneRemote)
	r.btrbkValue = toSet(b.BtrbkValue)
	r.btrbkActions = toSet(b.BtrbkActions)
	r.dmsetupValue = toSet(b.DmsetupValue)
	r.dmsetupActions = toSet(b.DmsetupActions)
	r.dmsetupScratch = b.DmsetupScratch
	r.btrfsValue = toSet(b.BtrfsValue)

	r.findGlobal = toSet(f.Find.Global)
	r.findSelective = toSet(f.Find.Selective)
	r.findDeleters = toSet(f.Find.Deleters)
	r.findExecOptions = toSet(f.Find.ExecOptions)
	r.guestTools = toSet(f.Proxmox.GuestTools)
	r.volumeTools = toSet(f.Proxmox.VolumeTools)
	r.zfsTools = toSet(f.Proxmox.ZfsTools)
	r.sshValueLetters = f.SSH.ValueLetters

	r.messages = f.Messages
	r.replacer = strings.NewReplacer(
		"{disk_advice}", f.Messages["disk_advice"],
		"{proxmox_advice}", f.Messages["proxmox_advice"],
	)
	for _, key := range requiredMessages {
		if f.Messages[key] == "" {
			return nil, fmt.Errorf("guard rules: missing message %q", key)
		}
	}
	if err != nil {
		return nil, err
	}
	return r, nil
}

// Safe bounds when guard.json leaves limits out (or sets them to 0 or less). The deadline sits well inside the
// shortest tool hook timeout (10 s: Claude Code, Codex and Pi PreToolUse, Aico's agent harness).
const (
	DefaultMaxDepth   = 64
	DefaultMaxBytes   = 256 << 10
	DefaultDeadlineMS = 2000
)

func orDefault(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

// Guards reports whether the guard judges calls of this tool (payload.guarded_tools).
func (r *Rules) Guards(tool string) bool { return r.guarded.MatchString(tool) }

// Deadline is the wall-time bound of one evaluation.
func (r *Rules) Deadline() time.Duration { return r.deadline }

var requiredMessages = []string{
	"git_force_push_main", "git_reset_hard", "git_clean", "git_checkout_all", "git_restore_all",
	"git_stash_drop", "git_stash", "rm_protected_root", "format_device", "wipefs", "dd_device",
	"parted", "sgdisk", "partitioner", "cryptsetup", "btrfs_subvolume_delete", "restic",
	"rclone_mirror", "rclone_delete", "btrbk", "dmsetup", "find_delete", "proxmox_guest",
	"proxmox_volume", "pvesm_free", "pvesh_delete", "durable_state", "pkill_self",
}

// message renders messages[key], filling {name}, {action} and {target}.
func (r *Rules) message(key string, vars ...string) string {
	text := r.replacer.Replace(r.messages[key])
	if len(vars) == 0 {
		return text
	}
	return strings.NewReplacer(vars...).Replace(text)
}
