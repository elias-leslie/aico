package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// One agy PreToolUse call through the real binary's logic, in a scratch project with real data/*.json.
func agyCheck(t *testing.T, root, name string, args map[string]any) string {
	t.Helper()
	in := map[string]any{"conversationId": "61981ce8-d721-429b-a226-799d8dc7106f", "workspacePaths": []any{root},
		"toolCall": map[string]any{"name": name, "args": args}}
	var out map[string]any
	if err := json.Unmarshal([]byte(agyPreTool(in)), &out); err != nil {
		t.Fatalf("answer isn't JSON: %v", err)
	}
	if d := out["decision"]; d != "deny" && d != "ask" {
		t.Fatalf("%s %v: answered %v; only deny and ask are safe in agy (an empty answer refuses in agy -p)", name, args, d)
	}
	reason, _ := out["reason"].(string)
	return reason
}

// agySetup is the shared sandbox with leash.json added. t.TempDir is under /tmp, which the real rules leave open,
// so the copy opens another folder instead: everything here then counts as outside the project.
func agySetup(t *testing.T) string {
	t.Helper()
	root := sandbox(t)
	t.Setenv("HOME", filepath.Dir(root))
	raw, err := os.ReadFile(filepath.Join("data", "leash.json"))
	if err != nil {
		t.Fatal(err)
	}
	body := strings.Replace(string(raw), `"write_extra_roots": ["/tmp"]`, `"write_extra_roots": ["/nonexistent-extra"]`, 1)
	if err := os.WriteFile(filepath.Join(os.Getenv("AICO_HOOK_DATA"), "leash.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestAgyLeashRefuses(t *testing.T) {
	root := agySetup(t)
	home := os.Getenv("HOME")
	script := filepath.Join(root, "clean.py")
	if err := os.WriteFile(script, []byte("import shutil\nshutil.rmtree('/srv/x')\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{
		"tmux kill-server",
		"tmux -S /run/user/1000/tether/x list-sessions",
		"/usr/bin/tmux ls",
		"timeout 5 tmux kill-server",
		"nohup tmux kill-server",
		"bash -c 'tmux kill-server'",
		"echo $(tmux kill-server)",
		"kill -9 1234",
		"pkill -f agy",
		"killall agy",
		"echo 1 | xargs kill",
		"fuser -k 3000/tcp",
		"sudo rm /tmp/x",
		"sudo -n true",
		"tether sessions end abc",
		"tether --instance default sessions list",
		"st aico root end foo",
		"st -P aico aico create x y",
		"st service rebuild aico --detach",
		"curl --unix-socket /tmp/some.sock http://x/v1/roots",
		"ls /run/user/1000/tether/default",
		"cat ~/.ssh/id_ed25519",
		"cat $HOME/.ssh/config",
		"cat ${HOME}/.codex/auth.json",
		"cat " + home + "/.gemini/antigravity-cli/antigravity-oauth-token",
		"cat .env",
		"cat ../proj/.env.production",
		"pi auth print-api-key --provider x",
		"aico grants run github-admin -- gh api",
		"aico logins get x",
		"gh auth token",
		"rm -rf ~/stuff",
		"rm -rf " + root,
		"cd " + root + " && rm -rf .",
		"cd " + root + " && rm -rf .git",
		"rm -rf ../other",
		"rm -rf *",
		"rm $X",
		"mv a.txt ~/a.txt",
		"cp a.txt /srv/elsewhere/a.txt",
		"echo hi > ~/x",
		"echo hi >> /srv/elsewhere/x",
		"cat a | tee /etc/x",
		"find . -name '*.log' -delete",
		"find . -exec rm {} +",
		"sqlite3 ~/.local/state/aico/web.db 'delete from x'",
		"ssh aico-gem ls",
		"systemctl --user stop aico-web",
		"systemctl restart aico-web",
		"git commit -am x",
		"git -C . clean -fdx",
		"git reset --hard",
		"git checkout -- .",
		"git stash",
		"git push origin main",
		"python3 clean.py",
		"python3 -c 'import os; os.kill(1, 9)'",
		"nohup sleep 100",
		"cat /mnt/summitflow-native/x",
		"ls /srv/workspaces/projects/neri-hunters/cases",
	} {
		if agyCheck(t, root, "run_command", map[string]any{"CommandLine": command}) == "" {
			t.Errorf("allowed: %s", command)
		}
	}
	for _, c := range []struct {
		tool string
		args map[string]any
	}{
		{"read_file", map[string]any{"Path": filepath.Join(home, ".ssh/id_ed25519")}},
		{"read_file", map[string]any{"Path": "/srv/workspaces/projects/neri-hunters/cases/1.md"}},
		{"write_file", map[string]any{"Path": filepath.Join(home, ".gemini/config/hooks.json"), "Content": "{}"}},
		{"write_file", map[string]any{"Path": filepath.Join(home, "x"), "Content": "x"}},
		{"edit_file", map[string]any{"Path": "/srv/elsewhere/a.go", "Target": "a", "Replacement": "b"}},
		{"schedule", map[string]any{}},
		{"browser_subagent", map[string]any{}},
		{"some_new_tool", map[string]any{}},
		{"ask_question", map[string]any{}},
	} {
		if agyCheck(t, root, c.tool, c.args) == "" {
			t.Errorf("allowed: %s %v", c.tool, c.args)
		}
	}
}

// What a careless agent does by accident: the shapes a review found getting through.
func TestAgyLeashSeesThroughShellShapes(t *testing.T) {
	root := agySetup(t)
	home, _ := os.UserHomeDir()
	if err := os.WriteFile(filepath.Join(root, "c.sh"), []byte("#!/bin/bash\ntmux kill-server\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "d.sh"), []byte("rm -rf /srv/elsewhere\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []string{
		"cd /srv/elsewhere/ # x\nrm -rf dist", "ls # list\nkill -9 1234", "echo start # begin\ntmux kill-server",
		"git status # check\ngit commit -am x",
		"rm -rf \\\n  /srv/elsewhere", "mv a.txt \\\n  /srv/elsewhere/a.txt",
		"echo done#1; rm -rf /srv/elsewhere", "curl -s http://x/#/a && kill -9 1",
		"find /srv/elsewhere -name '*.db' | xargs rm -f", "cat list | xargs -I{} rm -rf {}", "ls | xargs -n 1 rm",
		"bash c.sh", "sh c.sh", "./c.sh", "source d.sh", ". d.sh", "bash d.sh",
		"cd ~ && cat .ssh/id_ed25519", "cd ~/.ssh && ls",
		"cp a.txt /srv/elsewhere/a.txt 2>/dev/null", "cp a.txt /srv/elsewhere/a.txt 2>&1 | tail -2",
		"sed -i 's/a/b/' /srv/elsewhere/x 2>/dev/null", "sed --in-place=.bak 's/a/b/' /srv/elsewhere/x",
		"perl -pi -e 's/a/b/' /srv/elsewhere/x",
		"cat .env;", "cat .env|head", "echo $(cat .env)", "source .env; npm test", "cat .env*", "cat .env.local.bak-2a-20261029",
		"cat ~/.kube/config", "cat ~/.npmrc", "cat ~/.docker/config.json",
		"pushd /srv/elsewhere && rm -rf dist; popd", "cd \"$OTHER\" && rm -rf dist", "popd; rm -rf dist",
		"git rm -rf .", "git -C /srv/elsewhere rm -rf .", "mv .git /tmp/x", "mv . /tmp/x",
		"tar -xf a.tar -C /srv/elsewhere", "curl -o /srv/elsewhere/x http://a", "wget -O /srv/elsewhere/x http://a",
		"unzip a.zip -d /srv/elsewhere", "npx kill-port 3000", "systemctl --user reload aico-web",
		"st commit -m x --paths a.txt --skip-checks",
		"grep -rn x /srv/ 2>/dev/null | head", "find / -name x", "du -sh ~", "rg x /srv/scratch", "grep x ~/.bash_history",
		"timeout 5 tmux ls", "env X=1 tmux ls", "xargs tmux", "find . -name x -exec tmux ls ;",
		"python3 -c 'import os; os.remove(\"x\")'", "rm *",
	}
	for _, command := range cases {
		if why := agyCheck(t, root, "run_command", map[string]any{"CommandLine": command}); why == "" {
			t.Errorf("let through %q", command)
		}
	}
	for _, cwd := range []string{filepath.Join(home, ".ssh"), "~/.ssh", "/srv/workspaces/projects/neri-hunters"} {
		if why := agyCheck(t, root, "run_command", map[string]any{"CommandLine": "ls", "Cwd": cwd}); why == "" {
			t.Errorf("let a command start in %q", cwd)
		}
	}
}

func TestAgyLeashAllowsTheJob(t *testing.T) {
	root := agySetup(t)
	cases := []string{
		// Words about things aren't the things.
		"rg 'shutil.rmtree' .", "rg 'fs.rmSync(' packages", "cat packages/a/mnt/x.md", "rg -n timeout docker/", "rg env gh/",
		"st commit -m 'load .env first' --paths a.txt", "st commit -m 'fix `tmux` call' --paths a.txt",
		"tether ask create 'May I read /mnt/x?' --option A", "cat .env.example",
		"echo done#1", "rm -f *.log", "mv sub/a.txt .",
		"pwd", "ls -la", "git status --short", "git diff", "git log -5 --oneline", "git add a.txt",
		"st check --quick --changed-only", "st commit -m 'fix the thing' --paths a.txt",
		"tether ask list", "tether ask create 'One line?' --option A --option B --recommend 1",
		"st sessions send cc:abc123 'hello'", "st models route --role testing | head -2",
		"st aico wait session x",
		"echo hi > a.txt", "echo hi > /nonexistent-extra/a.txt", "rm a.txt", "rm -rf dist", "rm -f /nonexistent-extra/x", "mkdir -p sub/dir",
		"mv a.txt b.txt", "cp /etc/hostname a.txt", "cat /etc/hostname", "journalctl --user -u aico-web -n 50 --no-pager",
		"systemctl --user status aico-web", "systemctl list-units --failed", "aico status", "aico routines log x",
		"aico models route --role testing", "ls 2>/dev/null", "go test ./... 2>&1 | tail -5", "find . -name '*.go'",
		"curl -s http://127.0.0.1:3000/health", "rg -n foo packages | head",
	}
	for _, command := range cases {
		if why := agyCheck(t, root, "run_command", map[string]any{"CommandLine": command}); why != "" {
			t.Errorf("refused %q: %s", command, why)
		}
	}
	for _, c := range []struct {
		tool string
		args map[string]any
	}{
		{"finish", map[string]any{}},
		{"send_message", map[string]any{}},
		{"write_file", map[string]any{"Path": filepath.Join(root, "c.py"), "Content": "import os\nos.remove('x')  # /mnt/x\n"}},
		{"read_file", map[string]any{"Path": "/etc/hostname"}},
		{"read_file", map[string]any{"Path": filepath.Join(root, "a.go")}},
		{"write_file", map[string]any{"Path": filepath.Join(root, "b.go"), "Content": "package b\n"}},
		{"edit_file", map[string]any{"Path": filepath.Join(root, "b.go"), "Target": "b", "Replacement": "c"}},
		{"write_file", map[string]any{"Path": "/nonexistent-extra/n.txt", "Content": "x"}},
	} {
		if why := agyCheck(t, root, c.tool, c.args); why != "" {
			t.Errorf("refused %s %v: %s", c.tool, c.args, why)
		}
	}
}

// Broken rules can't turn the limits off: agy runs the tool on any hook failure, so the answer has to be a deny.
func TestAgyBrokenRulesRefuse(t *testing.T) {
	root := agySetup(t)
	dir := os.Getenv("AICO_HOOK_DATA")
	if err := os.Remove(filepath.Join(dir, "leash.json")); err != nil {
		t.Fatal(err)
	}
	if agyCheck(t, root, "run_command", map[string]any{"CommandLine": "pwd"}) == "" {
		t.Error("no leash.json: pwd allowed")
	}
	if err := os.WriteFile(filepath.Join(dir, "leash.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if agyCheck(t, root, "read_file", map[string]any{"Path": "/etc/hostname"}) == "" {
		t.Error("bad leash.json: read allowed")
	}
	if !strings.Contains(agyAnswer("PreToolUse", nil), `"deny"`) {
		t.Error("unreadable input: not refused")
	}
}

// A one-shot `agy -p` from inside a session inherits the launch's variables; it must not get the 25K context.
func TestAgyLaunchedOnlyForTheSessionItself(t *testing.T) {
	t.Setenv("AICO_CONTEXT_DELIVERED", "hash")
	t.Setenv("AICO_CONTEXT_PID", "999999")
	if agyLaunched() {
		t.Error("a pid that isn't a parent counted")
	}
	t.Setenv("AICO_CONTEXT_PID", strconv.Itoa(os.Getppid()))
	if !agyLaunched() {
		t.Error("the parent didn't count")
	}
	t.Setenv("AICO_CONTEXT_DELIVERED", "")
	if agyLaunched() {
		t.Error("no marker counted")
	}
}

func TestAgyInstallKeepsOtherHooks(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".gemini/config/hooks.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"mine":{"Stop":[]}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if code := agyInstall(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	raw, _ := os.ReadFile(path)
	var doc map[string]map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["mine"] == nil || doc["aico"]["PreToolUse"] == nil {
		t.Fatalf("got %s", raw)
	}
	if !strings.Contains(string(raw), "aico-hook agy PreToolUse") {
		t.Fatalf("got %s", raw)
	}
}

// With no folder agy works in its scratch folder, and the hook runs in its closed config folder.
func TestAgyWithoutAFolderWorksInItsScratch(t *testing.T) {
	agySetup(t)
	in := map[string]any{"toolCall": map[string]any{"name": "run_command", "args": map[string]any{"CommandLine": "pwd && echo hi > a.txt"}}}
	if got := agyPreTool(in); got != agyGoAhead {
		t.Fatalf("refused: %s", got)
	}
}
