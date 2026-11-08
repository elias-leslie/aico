// Package testtether is a stand-in for Tether's control socket in tests: the coordination documents with their
// versions and compare-and-set writes (docs/api-v1.md "Coordination") in memory, an empty session list, and a
// record of the deliveries posted.
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
	mu       sync.Mutex
	docs     map[string]json.RawMessage
	version  map[string]int
	Sessions []map[string]any
	// BeforePut, when set, runs before each document write is judged (without the server's mutex), so a test
	// can save the document "from another process" between a writer's read and its write.
	BeforePut     func(name string)
	Puts          map[string]int   // writes accepted per document
	Conflicts     int              // writes refused as version_conflict
	Deliveries    []map[string]any // each POST .../deliveries body, with "session" added
	HistoryOwners []map[string]any
	// ComesBack names ended sessions something kept will relaunch.
	ComesBack map[string]bool
	// ComesBackCoordinator is the coordinator those sessions report.
	ComesBackCoordinator string
	// ComesBackParent is the session that launched them.
	ComesBackParent string
}

// Start serves on a control.sock in a short temp dir (dir is unused, kept for callers) and points TETHER_SOCKET at it.
func Start(t *testing.T, dir string) *Server {
	t.Helper()
	s := &Server{docs: map[string]json.RawMessage{}, version: map[string]int{}, Puts: map[string]int{}}
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
	if r.Method == "PUT" && s.BeforePut != nil {
		s.BeforePut(strings.TrimPrefix(p, "/v1/coordination/docs/"))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case r.Method == "PUT" && p == "/v1/history/owner":
		var owner map[string]any
		_ = json.Unmarshal(body, &owner)
		s.HistoryOwners = append(s.HistoryOwners, owner)
		reply(w, 200, map[string]any{"kept": true})
	case r.Method == "GET" && strings.HasPrefix(p, "/v1/sessions/") && strings.HasSuffix(p, "/comes-back"):
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/v1/sessions/"), "/comes-back")
		reply(w, 200, map[string]any{"comesBack": s.ComesBack[id], "coordinatorId": s.ComesBackCoordinator, "parentId": s.ComesBackParent})
	case r.Method == "GET" && strings.HasPrefix(p, "/v1/sessions/") && !strings.Contains(strings.TrimPrefix(p, "/v1/sessions/"), "/"):
		reply(w, 404, map[string]any{"error": "not_found"})
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
		case r.Method == "GET":
			doc := s.docs[name]
			if doc == nil {
				doc = json.RawMessage("{}")
			}
			reply(w, 200, map[string]any{"name": name, "version": s.version[name], "doc": doc})
		case r.Method == "PUT":
			var in struct {
				Doc     json.RawMessage `json:"doc"`
				Version *int            `json:"version"`
			}
			_ = json.Unmarshal(body, &in)
			if in.Version == nil {
				reply(w, 400, map[string]any{"error": "invalid_body", "field": "version"})
				return
			}
			if *in.Version != s.version[name] {
				s.Conflicts++
				reply(w, 409, map[string]any{"error": "version_conflict", "version": s.version[name]})
				return
			}
			s.docs[name] = in.Doc
			s.version[name]++
			s.Puts[name]++
			reply(w, 200, map[string]any{"name": name, "version": s.version[name]})
		}
	default:
		reply(w, 404, map[string]any{"error": "not_found"})
	}
}
