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
// notes). This file is the hook's seam to it: a lock, a read and a write on Tether's control socket, the
// flock and the files they replace. Every caller of the lock treats a store that does not answer as "no
// coordination this call": leases are advisory, so an edit goes ahead unleased and the guard is not involved.

const (
	lockWaitMs = 4000
	lockTTLMs  = 8000
	callLimit  = 2500 * time.Millisecond
)

// ErrNoStore is a coordination store that did not answer (Tether is not running, or refused).
var ErrNoStore = errors.New("coordination store unavailable")

var (
	docMu    sync.Mutex
	docLocks = map[string]string{}                     // name -> lock token while this process holds it
	docCache = map[string]map[string]json.RawMessage{} // name -> the document read when the lock was taken
)

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
	return &http.Client{Timeout: callLimit, Transport: &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		}}}
}

// tetherCall sends one JSON request; out (if any) takes the JSON answer. A status over 299 is an error that
// carries it.
func tetherCall(method, path string, in, out any) (int, error) {
	var body io.Reader
	if in != nil {
		buf, err := json.Marshal(in)
		if err != nil {
			return 0, err
		}
		body = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, "http://tether"+path, body)
	if err != nil {
		return 0, err
	}
	if in != nil || method == "POST" {
		req.Header.Set("content-type", "application/json")
	}
	resp, err := tetherHTTP().Do(req)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", ErrNoStore, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode > 299 {
		return resp.StatusCode, fmt.Errorf("%w: %s %s answered %d", ErrNoStore, method, path, resp.StatusCode)
	}
	if out != nil && json.Unmarshal(raw, out) != nil {
		return resp.StatusCode, fmt.Errorf("%w: %s %s answered something unreadable", ErrNoStore, method, path)
	}
	return resp.StatusCode, nil
}

func docPath(name string) string { return "/v1/coordination/docs/" + url.PathEscape(name) }

// fetchDoc reads one document (an unwritten one is empty).
func fetchDoc(name string) (map[string]json.RawMessage, error) {
	var out struct {
		Doc map[string]json.RawMessage `json:"doc"`
	}
	if _, err := tetherCall("GET", docPath(name), nil, &out); err != nil {
		return nil, err
	}
	if out.Doc == nil {
		out.Doc = map[string]json.RawMessage{}
	}
	return out.Doc, nil
}

// readDoc is the document as the holder of its lock sees it (what the lock read), else a fresh read; a store
// that does not answer reads as empty.
func readDoc(name string) map[string]json.RawMessage {
	docMu.Lock()
	cached, held := docCache[name]
	docMu.Unlock()
	if held {
		return cached
	}
	doc, err := fetchDoc(name)
	if err != nil {
		return map[string]json.RawMessage{}
	}
	return doc
}

// writeDoc replaces a document: only while this process holds its lock.
func writeDoc(name string, doc any) error {
	docMu.Lock()
	token, held := docLocks[name]
	docMu.Unlock()
	if !held {
		return fmt.Errorf("write of %s without its lock", name)
	}
	if _, err := tetherCall("PUT", docPath(name), map[string]any{"doc": doc, "lock": token}, nil); err != nil {
		return err
	}
	buf, _ := json.Marshal(doc)
	var fresh map[string]json.RawMessage
	_ = json.Unmarshal(buf, &fresh)
	docMu.Lock()
	docCache[name] = fresh
	docMu.Unlock()
	return nil
}

// withDocLock runs fn holding the document's lock, with the document read once the lock is taken (so a store
// that answers the lock but not the read never has fn write an empty document over a full one).
func withDocLock(name string, fn func() error) error {
	var got struct {
		Lock string `json:"lock"`
	}
	if _, err := tetherCall("POST", docPath(name)+"/lock", map[string]any{"waitMs": lockWaitMs, "ttlMs": lockTTLMs}, &got); err != nil {
		return err
	}
	release := func() {
		docMu.Lock()
		delete(docLocks, name)
		delete(docCache, name)
		docMu.Unlock()
		_, _ = tetherCall("DELETE", docPath(name)+"/lock?lock="+url.QueryEscape(got.Lock), nil, nil)
	}
	doc, err := fetchDoc(name)
	if err != nil {
		_, _ = tetherCall("DELETE", docPath(name)+"/lock?lock="+url.QueryEscape(got.Lock), nil, nil)
		return err
	}
	docMu.Lock()
	docLocks[name] = got.Lock
	docCache[name] = doc
	docMu.Unlock()
	defer release()
	return fn()
}

// projectDocs lists the project documents (every document but the registry's "_..." ones).
func projectDocs() []string {
	var out struct {
		Items []struct {
			Name string `json:"name"`
		} `json:"items"`
	}
	if _, err := tetherCall("GET", "/v1/coordination/docs", nil, &out); err != nil {
		return nil
	}
	var names []string
	for _, it := range out.Items {
		if !strings.HasPrefix(it.Name, "_") {
			names = append(names, it.Name)
		}
	}
	return names
}

// ImportLegacy loads SummitFlow's lease files (<dir>/<name>.json, the coordination ledger among them as
// _coord.json) into the store, replacing a document of the same name. It is the one-time carry-over at cutover;
// the old files stay where they are. It returns the names imported.
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
		var doc map[string]json.RawMessage
		if err := json.Unmarshal(raw, &doc); err != nil {
			return done, fmt.Errorf("%s: %w", e.Name(), err)
		}
		if err := withDocLock(name, func() error { return writeDoc(name, doc) }); err != nil {
			return done, fmt.Errorf("%s: %w", name, err)
		}
		done = append(done, name)
	}
	return done, nil
}

var docName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)
