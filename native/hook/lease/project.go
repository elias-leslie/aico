package lease

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Project is the store key and checkout root that own a path (coord.project_for_path).
type Project struct {
	ID   string
	Root string
}

// ProjectFor finds the git checkout holding path (not the caller's cwd) and its project id: the
// `project:` of the first .index.yaml in the checkout root, the canonical repo root, or a parent; else
// the checkout directory's name.
func ProjectFor(path string) (Project, bool) {
	top, gitEntry, ok := toplevel(expandHome(path))
	if !ok {
		return Project{}, false
	}
	candidates := []string{top}
	if common := commonRoot(top, gitEntry); common != "" {
		candidates = append(candidates, common)
	}
	for dir := top; ; dir = filepath.Dir(dir) {
		candidates = append(candidates, dir)
		if dir == "/" {
			break
		}
	}
	seen := map[string]bool{}
	for _, dir := range candidates {
		if seen[dir] {
			continue
		}
		seen[dir] = true
		if id := indexProject(filepath.Join(dir, ".index.yaml")); id != "" {
			return Project{id, top}, true
		}
	}
	return Project{filepath.Base(top), top}, true
}

// toplevel is `git rev-parse --show-toplevel` from path (or its nearest existing parent), read from the tree.
func toplevel(path string) (string, string, bool) {
	probe := filepath.Clean(path)
	if fi, err := os.Stat(probe); err != nil || !fi.IsDir() {
		probe = filepath.Dir(probe)
	}
	for {
		if _, err := os.Stat(probe); err == nil || probe == "/" {
			break
		}
		probe = filepath.Dir(probe)
	}
	real, err := filepath.EvalSymlinks(probe)
	if err != nil {
		return "", "", false
	}
	for dir := real; ; dir = filepath.Dir(dir) {
		entry := filepath.Join(dir, ".git")
		if fi, err := os.Stat(entry); err == nil && (fi.IsDir() || fi.Mode().IsRegular()) {
			if fi.IsDir() && filepath.Base(dir) == ".git" {
				return "", "", false
			}
			return dir, entry, true
		}
		if filepath.Base(dir) == ".git" {
			return "", "", false // inside a git dir: no work tree
		}
		if dir == "/" {
			return "", "", false
		}
	}
}

// commonRoot is the canonical repo root behind a checkout (a worktree's main checkout).
func commonRoot(top, gitEntry string) string {
	fi, err := os.Stat(gitEntry)
	if err != nil {
		return ""
	}
	if fi.IsDir() {
		return top
	}
	raw, err := os.ReadFile(gitEntry)
	if err != nil {
		return ""
	}
	gitdir := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(raw)), "gitdir:"))
	if !filepath.IsAbs(gitdir) {
		gitdir = filepath.Join(top, gitdir)
	}
	common := gitdir
	if c, err := os.ReadFile(filepath.Join(gitdir, "commondir")); err == nil {
		common = strings.TrimSpace(string(c))
		if !filepath.IsAbs(common) {
			common = filepath.Join(gitdir, common)
		}
	}
	if real, err := filepath.EvalSymlinks(common); err == nil {
		common = real
	}
	if filepath.Base(common) == ".git" {
		return filepath.Dir(common)
	}
	return common
}

// indexProject is the top-level `project:` value of a .index.yaml.
func indexProject(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "project:") {
			continue
		}
		v := strings.TrimSpace(strings.TrimPrefix(line, "project:"))
		if i := strings.Index(v, " #"); i >= 0 {
			v = strings.TrimSpace(v[:i])
		}
		return strings.Trim(v, `"'`)
	}
	return ""
}

// ignored is `git check-ignore -q path` in root.
func ignored(root, path string) bool {
	return exec.Command("git", "-C", root, "check-ignore", "-q", path).Run() == nil
}

// sensitive: the session marks itself (ST_COORD_SENSITIVE=1) or its cwd's project.identity.json does.
func (id Identity) sensitive() bool {
	if id.env["ST_COORD_SENSITIVE"] == "1" {
		return true
	}
	cwd, err := os.Getwd()
	if err != nil {
		return false
	}
	if real, err := filepath.EvalSymlinks(cwd); err == nil {
		cwd = real
	}
	for dir := cwd; ; dir = filepath.Dir(dir) {
		raw, err := os.ReadFile(filepath.Join(dir, "project.identity.json"))
		if err == nil {
			var data map[string]any
			if json.Unmarshal(raw, &data) != nil {
				return false
			}
			coord, _ := data["coordination"].(map[string]any)
			return coord != nil && truthy(coord["sensitive"])
		}
		if dir == "/" {
			return false
		}
	}
}

// realPath is os.path.realpath: symlinks resolved as far as the path exists.
func realPath(p string) string {
	p = filepath.Clean(p)
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	dir, base := filepath.Split(p)
	if dir == "" || dir == p {
		return p
	}
	return filepath.Join(realPath(strings.TrimSuffix(dir, "/")), base)
}
