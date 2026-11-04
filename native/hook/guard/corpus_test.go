package guard

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The replay: every case of contracts/guard-corpus/*.json goes through
// Rules.Evaluate and must give the answer SummitFlow's hook recorded. A case
// may carry an "exception" (owner rule plus the Go answer) for a difference
// that is kept on purpose; there are none today.
const (
	corpusDir = "../../../contracts/guard-corpus" // contracts/guard-corpus
	rulesPath = "../data/guard.json"
)

type corpusFile struct {
	Description string            `json:"description"`
	Version     int               `json:"version"`
	Env         map[string]string `json:"env"`
	Source      string            `json:"source"`
	Cwd         string            `json:"cwd"`
	Cases       []corpusCase      `json:"cases"`
}

type corpusCase struct {
	Note      string         `json:"note"`
	Source    string         `json:"source"`
	Command   string         `json:"command"`
	Payload   map[string]any `json:"payload"`
	Cwd       string         `json:"cwd"`
	Expect    string         `json:"expect"`
	Exception *struct {
		Rule string `json:"rule"`
		Got  string `json:"got"`
	} `json:"exception"`
}

func loadRules(t testing.TB) *Rules {
	t.Helper()
	r, err := Load(rulesPath)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func (c corpusCase) payload(defaultCwd string) map[string]any {
	if c.Payload != nil {
		return c.Payload
	}
	cwd := c.Cwd
	if cwd == "" {
		cwd = defaultCwd
	}
	return map[string]any{
		"hook_event_name": "PreToolUse", "tool_name": "Bash",
		"tool_input": map[string]any{"command": c.Command}, "cwd": cwd,
	}
}

func answer(res Result) string {
	if res.Deny {
		return res.Reason
	}
	return "allow"
}

func TestCorpusReplay(t *testing.T) {
	rules := loadRules(t)
	files, err := filepath.Glob(filepath.Join(corpusDir, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no corpus files under contracts/guard-corpus: %v", err)
	}
	sort.Strings(files)
	total, exceptions := 0, 0
	var mismatches []string
	for _, path := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var f corpusFile
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&f); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		for k, v := range f.Env {
			t.Setenv(k, v)
		}
		for i, c := range f.Cases {
			total++
			res := rules.Evaluate(c.payload(f.Cwd))
			want := c.Expect
			if c.Exception != nil {
				exceptions++
				want = c.Exception.Got
			}
			if res.Fault != "" {
				mismatches = append(mismatches, filepath.Base(path)+"#"+itoa(i)+": fault: "+res.Fault)
			}
			if got := answer(res); got != want {
				mismatches = append(mismatches, filepath.Base(path)+"#"+itoa(i)+" "+describe(c)+"\n    want "+want+"\n    got  "+got)
			}
		}
	}
	t.Logf("replayed %d cases from %d files, %d exceptions", total, len(files), exceptions)
	if len(mismatches) > 0 {
		t.Errorf("%d of %d cases differ from SummitFlow's answer:\n%s", len(mismatches), total, strings.Join(mismatches, "\n"))
	}
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}

func describe(c corpusCase) string {
	if c.Payload != nil {
		b, _ := json.Marshal(c.Payload)
		return string(b)
	}
	return strconvQuote(c.Command) + " cwd=" + c.Cwd
}

func strconvQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
