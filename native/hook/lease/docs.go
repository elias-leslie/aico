package lease

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// The coordination store lives in Tether (tether.db coord_docs, docs/api-v1.md "Coordination"), one JSON
// document per project (leases and writer sets) plus "_coord" (identity registry, handshake messages, peer
// notes). This file is the hook's seam to it: a read with the document's version and a write back with that
// version (compare-and-set). A write refused because someone else saved first is redone on a fresh read, a few
// times at most, so nothing is held between the read and the write and no update is lost.
//
// Every caller treats a store that does not answer as "no coordination this call", never as an empty document:
// leases are advisory, so an edit goes ahead unleased (with a warning) and the guard is not involved. One hook
// call has one time budget for all its store calls (SetBudget), and after the first call that gets no answer the
// rest fail at once, so a hung Tether costs a hook call its budget once, not once per call.

const (
	callLimit   = 2500 * time.Millisecond // one call, outside a hook's budget (the CLI verbs)
	casAttempts = 5                       // reads and writes of one change before giving up
)

// ErrNoStore is a coordination store that did not answer (Tether is not running, or refused).
var ErrNoStore = errors.New("coordination store unavailable")

// errConflict: someone else saved the document since it was read (the change is redone on a fresh read).
var errConflict = errors.New("coordination document changed since it was read")

// txn is one change in progress: the document as read (then as written) and its version.
type txn struct {
	version  int
	doc      map[string]json.RawMessage
	conflict bool // a write was refused: the change is redone
}

var (
	docMu    sync.Mutex
	docTx    = map[string]*txn{} // name -> the change this process has in progress
	deadline time.Time           // the hook call's budget runs out (zero: no budget)
	downErr  error               // the first call that got no answer; later calls fail at once
)

// SetBudget starts a hook call: its store calls share one time budget from start (0: none, the CLI verbs), and a
// store that did not answer an earlier call is tried again.
func SetBudget(start time.Time, budget time.Duration) {
	docMu.Lock()
	defer docMu.Unlock()
	downErr = nil
	if budget <= 0 {
		deadline = time.Time{}
		return
	}
	deadline = start.Add(budget)
}

// Unavailable is the reason the store did not answer in this process, or nil.
func Unavailable() error {
	docMu.Lock()
	defer docMu.Unlock()
	return downErr
}

// tetherSocket is Tether's control socket for this user and instance.
func tetherSocket() string {
	if s := os.Getenv("TETHER_SOCKET"); s != "" {
		return s
	}
	runtime := os.Getenv("XDG_RUNTIME_DIR")
	if runtime == "" {
		runtime = fmt.Sprintf("/run/user/%d", os.Getuid())
	}
	instance := os.Getenv("TETHER_INSTANCE")
	if instance == "" {
		instance = "default"
	}
	return filepath.Join(runtime, "tether", instance, "control.sock")
}

func tetherHTTP() *http.Client {
	sock := tetherSocket()
	return &http.Client{Transport: &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		}}}
}

// tetherCall sends one JSON request; out (if any) takes the JSON answer. A status over 299 is an error that
// carries it (409 version_conflict is errConflict). A call that gets no answer in time marks the store down for
// the rest of this process.
func tetherCall(method, path string, in, out any) (int, error) {
	docMu.Lock()
	down, limit := downErr, callLimit
	if !deadline.IsZero() {
		limit = min(limit, time.Until(deadline))
	}
	if down == nil && limit <= 0 {
		downErr = fmt.Errorf("%w: the hook's time budget is spent", ErrNoStore)
		down = downErr
	}
	docMu.Unlock()
	if down != nil {
		return 0, down
	}
	var body io.Reader
	if in != nil {
		buf, err := json.Marshal(in)
		if err != nil {
			return 0, err
		}
		body = bytes.NewReader(buf)
	}
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, "http://tether"+path, body)
	if err != nil {
		return 0, err
	}
	if in != nil || method == "POST" {
		req.Header.Set("content-type", "application/json")
	}
	resp, err := tetherHTTP().Do(req)
	if err != nil {
		err = fmt.Errorf("%w: %v", ErrNoStore, err)
		docMu.Lock()
		if downErr == nil {
			downErr = err
		}
		docMu.Unlock()
		return 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return resp.StatusCode, fmt.Errorf("%w: %s %s: %v", ErrNoStore, method, path, err)
	}
	if resp.StatusCode == http.StatusConflict && bytes.Contains(raw, []byte(`"version_conflict"`)) {
		return resp.StatusCode, errConflict
	}
	if resp.StatusCode > 299 {
		return resp.StatusCode, fmt.Errorf("%w: %s %s answered %d", ErrNoStore, method, path, resp.StatusCode)
	}
	if out != nil && json.Unmarshal(raw, out) != nil {
		return resp.StatusCode, fmt.Errorf("%w: %s %s answered something unreadable", ErrNoStore, method, path)
	}
	return resp.StatusCode, nil
}

func docPath(name string) string { return "/v1/coordination/docs/" + url.PathEscape(name) }

// fetchDoc reads one document and its version (an unwritten one is empty at version 0).
func fetchDoc(name string) (map[string]json.RawMessage, int, error) {
	var out struct {
		Version *int                       `json:"version"`
		Doc     map[string]json.RawMessage `json:"doc"`
	}
	if _, err := tetherCall("GET", docPath(name), nil, &out); err != nil {
		return nil, 0, err
	}
	if out.Version == nil {
		return nil, 0, fmt.Errorf("%w: %s has no version", ErrNoStore, name)
	}
	if out.Doc == nil {
		out.Doc = map[string]json.RawMessage{}
	}
	return out.Doc, *out.Version, nil
}

// loadDocErr is the document as this process's change in progress sees it, else a fresh read. A store that
// does not answer is an error, never an empty document.
func loadDocErr(name string) (map[string]json.RawMessage, error) {
	docMu.Lock()
	tx, ok := docTx[name]
	docMu.Unlock()
	if ok {
		return tx.doc, nil
	}
	doc, _, err := fetchDoc(name)
	return doc, err
}

// readDoc is loadDocErr for readers that show or decide nothing when the store is down (an empty document).
func readDoc(name string) map[string]json.RawMessage {
	doc, err := loadDocErr(name)
	if err != nil {
		return map[string]json.RawMessage{}
	}
	return doc
}

// writeDoc replaces a document: only inside updateDoc, against the version that change read.
func writeDoc(name string, doc any) error {
	docMu.Lock()
	tx, ok := docTx[name]
	docMu.Unlock()
	if !ok {
		return fmt.Errorf("write of %s outside a change", name)
	}
	var got struct {
		Version int `json:"version"`
	}
	if _, err := tetherCall("PUT", docPath(name), map[string]any{"doc": doc, "version": tx.version}, &got); err != nil {
		if errors.Is(err, errConflict) {
			tx.conflict = true
		}
		return err
	}
	buf, _ := json.Marshal(doc)
	var fresh map[string]json.RawMessage
	_ = json.Unmarshal(buf, &fresh)
	docMu.Lock()
	tx.version, tx.doc = got.Version, fresh
	docMu.Unlock()
	return nil
}

// updateDoc runs fn as one change of the document: fn reads it (readDoc, loadDocErr) as read at the start and
// writes it with writeDoc. When someone else saved first, the document is read again and fn runs again, so fn
// must start from what it reads and reset anything it collects. A store that does not answer the first read
// is an error and fn never runs: nothing is written over a document this process could not read.
func updateDoc(name string, fn func() error) error {
	for attempt := 0; ; attempt++ {
		doc, version, err := fetchDoc(name)
		if err != nil {
			return err
		}
		tx := &txn{version: version, doc: doc}
		docMu.Lock()
		outer, nested := docTx[name]
		docTx[name] = tx
		docMu.Unlock()
		err = fn()
		docMu.Lock()
		if nested {
			docTx[name] = outer
		} else {
			delete(docTx, name)
		}
		docMu.Unlock()
		if !tx.conflict {
			return err
		}
		if attempt+1 >= casAttempts {
			return fmt.Errorf("%w: %s kept changing under %d tries", ErrNoStore, name, casAttempts)
		}
	}
}

// projectDocs lists the project documents (every document but the registry's "_..." ones).
func projectDocs() []string {
	names, _ := projectDocsErr()
	return names
}

func projectDocsErr() ([]string, error) {
	var out struct {
		Items []struct {
			Name string `json:"name"`
		} `json:"items"`
	}
	if _, err := tetherCall("GET", "/v1/coordination/docs", nil, &out); err != nil {
		return nil, err
	}
	var names []string
	for _, it := range out.Items {
		if !strings.HasPrefix(it.Name, "_") {
			names = append(names, it.Name)
		}
	}
	return names, nil
}

// ImportLegacy carries SummitFlow's lease files (<dir>/<name>.json, the coordination ledger among them as
// _coord.json) into the store. It merges row by row and never drops what the store has: a lease is keyed by
// lease_id, a message by id, an identity by agent id, a note by (to, about); a row the store already has stays
// as the store has it, and a writer entry is added only for an agent the path has no entry for. Other top-level
// keys are taken only when the store lacks them. So re-running it never loses newer data. The old files stay
// where they are. It returns the names imported.
func ImportLegacy(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var done []string
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || e.IsDir() || !docName.MatchString(name) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return done, err
		}
		var old map[string]json.RawMessage
		if err := json.Unmarshal(raw, &old); err != nil {
			return done, fmt.Errorf("%s: %w", e.Name(), err)
		}
		err = updateDoc(name, func() error {
			cur, err := loadDocErr(name)
			if err != nil {
				return err
			}
			return writeDoc(name, mergeLegacy(cur, old))
		})
		if err != nil {
			return done, fmt.Errorf("%s: %w", name, err)
		}
		done = append(done, name)
	}
	return done, nil
}

// mergeLegacy is cur with old's rows added where cur lacks them (ImportLegacy).
func mergeLegacy(cur, old map[string]json.RawMessage) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(cur)+len(old))
	for k, v := range cur {
		out[k] = v
	}
	rowKey := map[string]func(map[string]any) string{
		"leases":   func(r map[string]any) string { return str(r["lease_id"]) },
		"messages": func(r map[string]any) string { return str(r["id"]) },
		"notes":    func(r map[string]any) string { return str(r["to"]) + "\x00" + str(r["about"]) },
	}
	for key, raw := range old {
		have, ok := out[key]
		if !ok {
			out[key] = raw
			continue
		}
		var merged any
		switch key {
		case "leases", "messages", "notes":
			var mine, theirs []map[string]any
			if json.Unmarshal(have, &mine) != nil || json.Unmarshal(raw, &theirs) != nil {
				continue
			}
			ident := rowKey[key]
			seen := map[string]bool{}
			for _, r := range mine {
				seen[ident(r)] = true
			}
			for _, r := range theirs {
				if k := ident(r); k != "" && !seen[k] {
					seen[k] = true
					mine = append(mine, r)
				}
			}
			merged = mine
		case "identities":
			var mine, theirs map[string]any
			if json.Unmarshal(have, &mine) != nil || json.Unmarshal(raw, &theirs) != nil {
				continue
			}
			for k, v := range theirs {
				if _, ok := mine[k]; !ok {
					mine[k] = v
				}
			}
			merged = mine
		case "writers":
			var mine, theirs map[string][]map[string]any
			if json.Unmarshal(have, &mine) != nil || json.Unmarshal(raw, &theirs) != nil {
				continue
			}
			for path, entries := range theirs {
				for _, e := range entries {
					dup := false
					for _, m := range mine[path] {
						dup = dup || str(m["agent_id"]) == str(e["agent_id"])
					}
					if !dup {
						mine[path] = append(mine[path], e)
					}
				}
			}
			merged = mine
		default:
			continue // a scalar or unknown key: the store's value stands
		}
		if buf, err := json.Marshal(merged); err == nil {
			out[key] = buf
		}
	}
	return out
}

var docName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)
