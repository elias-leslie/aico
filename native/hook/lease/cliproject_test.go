package lease

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCLIProjectPrefersDeclaredCwdOverInheritedEnv(t *testing.T) {
	tmp := t.TempDir()
	declared := filepath.Join(tmp, "b")
	bare := filepath.Join(tmp, "bare")
	for _, dir := range []string{declared, bare} {
		if out, err := exec.Command("git", "init", "-q", dir).CombinedOutput(); err != nil {
			t.Fatalf("git init: %v %s", err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(declared, ".index.yaml"), []byte("project: b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ST_PROJECT_ID", "a")
	for dir, want := range map[string]string{declared: "b", bare: "a"} {
		t.Chdir(dir)
		got, err := CLIProject()
		if err != nil || got.ID != want {
			t.Fatalf("in %s: project %q, err %v; want %q", dir, got.ID, err, want)
		}
	}
	t.Setenv("ST_PROJECT_ID", "")
	if got, err := CLIProject(); err != nil || got.ID != "bare" {
		t.Fatalf("no env, undeclared checkout: %q, %v", got.ID, err)
	}
}
