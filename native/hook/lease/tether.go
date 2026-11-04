package lease

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// conflictSuffix is "; belongs to <title> (<agent id>); raise conflicts there" for a lease held by a lane a
// coordinator launched (cli/lib/coordinators.conflict_suffix). Best effort: "" whenever Tether is absent.
func (h *Hook) conflictSuffix(l Lease) string {
	doc := h.lineage().doc
	ids := rows(doc, "identities")
	anchor := l.anchor()
	if anchor == "" {
		anchor = str(ids[l.AgentID]["anchor"])
	}
	widget := widgetFor(anchor)
	if widget == "" {
		return ""
	}
	sessions := h.tetherSessions()
	desc := sessions[widget]
	coordID := str(desc["coordinatorId"])
	if desc == nil || coordID == "" || truthy(desc["coordinator"]) {
		return ""
	}
	title, agent := "Coordinator", ""
	if coord := sessions[coordID]; coord != nil {
		title = sessionTitle(coord)
		best := ""
		for aid, row := range ids { // the latest identity on any harness process in that window
			if a := str(row["anchor"]); a != "" && widgetFor(a) == coordID {
				if last := str(row["last"]); agent == "" || last > best {
					agent, best = aid, last
				}
			}
		}
	}
	if agent != "" {
		agent = " (" + agent + ")"
	}
	return fmt.Sprintf("; belongs to %s%s; raise conflicts there", title, agent)
}

func widgetFor(anchor string) string {
	if anchor == "" || !anchorAlive(anchor) {
		return ""
	}
	pid, _, _ := strings.Cut(anchor, ":")
	raw, err := os.ReadFile("/proc/" + pid + "/environ")
	if err != nil {
		return ""
	}
	for _, kv := range strings.Split(string(raw), "\x00") {
		if v, ok := strings.CutPrefix(kv, "AICO_WIDGET_ID="); ok {
			return v
		}
	}
	return ""
}

func sessionTitle(desc map[string]any) string {
	if t := strings.TrimSpace(str(desc["displayTitle"])); t != "" {
		return t
	}
	for _, k := range []string{"label", "id"} {
		if v := str(desc[k]); v != "" {
			return v
		}
	}
	return "?"
}

func (h *Hook) tetherSock() string {
	if s := h.ID.env["TETHER_SOCKET"]; s != "" {
		return s
	}
	runtime := h.ID.env["XDG_RUNTIME_DIR"]
	if runtime == "" {
		runtime = fmt.Sprintf("/run/user/%d", os.Getuid())
	}
	instance := h.ID.env["TETHER_INSTANCE"]
	if instance == "" {
		instance = "default"
	}
	return filepath.Join(runtime, "tether", instance, "control.sock")
}

// tetherSessions are Tether's running session descriptors by id (GET /v1/sessions, 0.5 s).
func (h *Hook) tetherSessions() map[string]map[string]any {
	out := map[string]map[string]any{}
	sock := h.tetherSock()
	fi, err := os.Lstat(sock)
	if err != nil || fi.Mode()&os.ModeSocket == 0 {
		return out
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); !ok || int(st.Uid) != os.Getuid() {
		return out
	}
	client := http.Client{Timeout: 500 * time.Millisecond, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		}}}
	resp, err := client.Get("http://tether/v1/sessions")
	if err != nil {
		return out
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return out
	}
	var data struct {
		Items []map[string]any `json:"items"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&data) != nil {
		return out
	}
	for _, d := range data.Items {
		if id := str(d["id"]); id != "" {
			if _, dup := out[id]; !dup {
				out[id] = d
			}
		}
	}
	return out
}
