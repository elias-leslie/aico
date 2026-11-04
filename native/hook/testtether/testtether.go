// Package testtether is a stand-in for Tether's control socket in tests: the coordination documents and lock
// (docs/api-v1.md "Coordination") in memory, an empty session list, and a record of the deliveries posted.
package testtether

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type Server struct {
	mu         sync.Mutex
	docs       map[string]json.RawMessage
	version    map[string]int
	locks      map[string]string
	Sessions   []map[string]any
	Deliveries []map[string]any // each POST .../deliveries body, with "session" added
}

// Start serves on a control.sock in a short temp dir (dir is unused, kept for callers) and points TETHER_SOCKET at it.
func Start(t *testing.T, dir string) *Server {
	t.Helper()
	s := &Server{docs: map[string]json.RawMessage{}, version: map[string]int{}, locks: map[string]string{}}
	// A unix socket path is limited to about 100 bytes, which a test's own temp dir can exceed.
	short, err := os.MkdirTemp("/tmp", "ttether")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(short) })
	sock := filepath.Join(short, "control.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(s.serve))
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	t.Setenv("TETHER_SOCKET", sock)
	return s
}

// Doc is a stored document (nil when never written).
func (s *Server) Doc(name string) map[string]json.RawMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out map[string]json.RawMessage
	_ = json.Unmarshal(s.docs[name], &out)
	return out
}

// Put stores a document as if written by someone else.
func (s *Server) Put(name string, doc any) {
	buf, _ := json.Marshal(doc)
	s.mu.Lock()
	s.docs[name] = buf
	s.version[name]++
	s.mu.Unlock()
}

func reply(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	body, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case r.Method == "GET" && p == "/v1/sessions":
		reply(w, 200, map[string]any{"items": append([]map[string]any{}, s.Sessions...)})
	case r.Method == "POST" && strings.HasPrefix(p, "/v1/sessions/") && strings.HasSuffix(p, "/deliveries"):
		var d map[string]any
		_ = json.Unmarshal(body, &d)
		d["session"] = strings.Split(p, "/")[3]
		s.Deliveries = append(s.Deliveries, d)
		reply(w, 200, map[string]any{"delivery": map[string]any{"id": "000000000001"}})
	case r.Method == "GET" && p == "/v1/coordination/docs":
		items := []map[string]any{}
		for n := range s.docs {
			items = append(items, map[string]any{"name": n})
		}
		reply(w, 200, map[string]any{"items": items})
	case strings.HasPrefix(p, "/v1/coordination/docs/"):
		name := strings.TrimPrefix(p, "/v1/coordination/docs/")
		switch {
		case strings.HasSuffix(name, "/lock") && r.Method == "POST":
			name = strings.TrimSuffix(name, "/lock")
			if s.locks[name] != "" {
				reply(w, 423, map[string]any{"error": "lock_busy"})
				return
			}
			s.locks[name] = "tok" + name
			reply(w, 200, map[string]any{"lock": s.locks[name]})
		case strings.HasSuffix(name, "/lock") && r.Method == "DELETE":
			name = strings.TrimSuffix(name, "/lock")
			released := s.locks[name] != "" && s.locks[name] == r.URL.Query().Get("lock")
			if released {
				delete(s.locks, name)
			}
			reply(w, 200, map[string]any{"released": released})
		case r.Method == "GET":
			doc := s.docs[name]
			if doc == nil {
				doc = json.RawMessage("{}")
			}
			reply(w, 200, map[string]any{"name": name, "version": s.version[name], "doc": doc})
		case r.Method == "PUT":
			var in struct {
				Doc  json.RawMessage `json:"doc"`
				Lock string          `json:"lock"`
			}
			_ = json.Unmarshal(body, &in)
			if s.locks[name] != "" && s.locks[name] != in.Lock {
				reply(w, 409, map[string]any{"error": "locked"})
				return
			}
			s.docs[name] = in.Doc
			s.version[name]++
			reply(w, 200, map[string]any{"name": name, "version": s.version[name]})
		}
	default:
		reply(w, 404, map[string]any{"error": "not_found"})
	}
}
