package lease

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// MayDisrupt is the read-only coordination preflight. An unreadable source is unknown,
// never evidence that the host is free. It uses the same Tether documents as the hook.
func (h *Hook) MayDisrupt(target string, requests []string) map[string]any {
	return h.disruption(target, requests, func(argv []string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
		runtime := os.Getenv("XDG_RUNTIME_DIR")
		if runtime == "" {
			runtime = fmt.Sprintf("/run/user/%d", os.Getuid())
		}
		bus := os.Getenv("DBUS_SESSION_BUS_ADDRESS")
		if bus == "" {
			bus = "unix:path=" + runtime + "/bus"
		}
		cmd.Env = append(os.Environ(), "XDG_RUNTIME_DIR="+runtime, "DBUS_SESSION_BUS_ADDRESS="+bus)
		out, err := cmd.Output()
		return string(out), err
	})
}

func (h *Hook) disruption(target string, requests []string, run func([]string) (string, error)) map[string]any {
	now := time.Now().UTC()
	blocking, unknown := []string{}, []string{}
	replies, holds, files, agents := []map[string]any{}, []map[string]any{}, []map[string]any{}, []map[string]any{}
	units, procs := []string{}, []string{}
	pending, unasked := []string{}, []string{}
	wanted, asked, ready := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, id := range requests {
		if id != "" {
			wanted[id] = true
		}
	}
	mine := h.lineage().SelfIDs(h.ID)
	for _, r := range h.Rows() {
		if (len(wanted) > 0 && !wanted[str(r["id"])]) || (len(wanted) == 0 && !mine[str(r["from"])]) {
			continue
		}
		reply := str(r["intent"])
		state := str(r["state"])
		asked[str(r["to"])], asked[str(r["acked_by"])] = true, true
		item := copyRow(r)
		item["reply"] = reply
		replies = append(replies, item)
		if reply == "yes" {
			ready[str(r["to"])], ready[str(r["acked_by"])] = true, true
		}
		// Confirmation closes an objection; its old answer remains useful history only.
		if state != "open" && state != "acked" {
			continue
		}
		if reply == "no" {
			blocking = append(blocking, str(r["to"])+" objected: "+str(r["note"]))
		} else if reply == "eta" {
			at, ok := parseStamp(str(r["acked_at"]))
			minutes, _ := strconv.Atoi(fmt.Sprint(r["eta_min"]))
			until := at.Add(time.Duration(minutes) * time.Minute)
			if ok && until.After(now) {
				blocking = append(blocking, str(r["to"])+" asked to wait until "+stamp(until))
			}
		} else if state == "open" {
			pending = append(pending, str(r["to"]))
		}
	}
	sessions := h.tetherSessions()
	for _, id := range sortedKeysOfSessions(sessions) {
		s := sessions[id]
		if str(s["status"]) != "running" {
			continue
		}
		agents = append(agents, map[string]any{"session": id, "project": s["projectId"], "state": s["state"], "title": sessionTitle(s)})
	}
	for _, project := range h.Cfg.allProjects() {
		s, err := h.storeFor(project)
		if err != nil {
			unknown = append(unknown, project+" leases unreadable")
			continue
		}
		live, err := s.Active("hold", "op", "file")
		if err != nil {
			unknown = append(unknown, project+" leases unreadable")
			continue
		}
		for _, l := range live {
			row := map[string]any{"project": project, "holder": l.AgentID, "kind": l.Kind, "since": l.AcquiredAt}
			if l.Kind == "file" {
				row["paths"] = len(l.Globs)
				files = append(files, row)
				continue
			}
			if !l.Sensitive {
				row["purpose"] = l.Purpose
			}
			holds = append(holds, row)
			inScope := target == "host" || target == project || strings.HasPrefix(target, project+"-") || strings.HasPrefix(target, project+"@") || strings.HasPrefix(target, project+".")
			if inScope && !(l.Kind == "hold" && ready[l.AgentID]) {
				blocking = append(blocking, h.holderLine(project, l, ""))
			}
		}
	}
	for _, user := range []bool{false, true} {
		argv := []string{"systemctl"}
		label := "system"
		if user {
			argv = append(argv, "--user")
			label = "user"
		}
		argv = append(argv, "list-units", "--type=service", "--state=active,activating", "--no-legend", "--plain", "--no-pager")
		out, err := run(argv)
		if err != nil {
			unknown = append(unknown, label+" units unreadable")
			continue
		}
		pattern, err := regexp.Compile(h.Cfg.BackupUnitPattern)
		if err != nil || h.Cfg.BackupUnitPattern == "" {
			unknown = append(unknown, "backup unit policy unavailable")
			continue
		}
		for _, line := range strings.Split(out, "\n") {
			fields := strings.Fields(line)
			if len(fields) > 0 && pattern.MatchString(fields[0]) {
				units = append(units, label+":"+fields[0])
				blocking = append(blocking, "backup unit "+fields[0]+" running")
			}
		}
	}
	if pattern, err := regexp.Compile(h.Cfg.BackupProcessPattern); err == nil && h.Cfg.BackupProcessPattern != "" {
		out, err := run([]string{"ps", "-eo", "comm="})
		if err != nil {
			unknown = append(unknown, "process table unreadable")
		} else {
			for _, line := range strings.Split(out, "\n") {
				if pattern.MatchString(strings.TrimSpace(line)) {
					procs = append(procs, strings.TrimSpace(line))
					blocking = append(blocking, "backup process "+strings.TrimSpace(line)+" running")
				}
			}
		}
	} else {
		unknown = append(unknown, "backup process policy unavailable")
	}
	if Unavailable() != nil {
		unknown = append(unknown, "Tether coordination unavailable")
	}
	// Session inventory is advisory: no unreadable inventory is represented as zero live agents.
	var inventory struct {
		Items []map[string]any `json:"items"`
	}
	if _, err := tetherCall("GET", "/v1/sessions", nil, &inventory); err != nil {
		unknown = append(unknown, "Tether sessions unavailable")
	}
	for aid, row := range rows(h.lineage().doc, "identities") {
		if anchorAlive(str(row["anchor"])) && !asked[aid] {
			unasked = append(unasked, aid)
		}
	}
	sort.Strings(unasked)
	return map[string]any{"schema": "aico.may-disrupt.v1", "target": target, "generated_at": stamp(now),
		"clear": len(blocking) == 0 && len(unknown) == 0, "blocking": blocking, "unknown": unknown,
		"agents": agents, "unasked": unasked, "handshakes": replies, "awaiting_reply": pending,
		"holds": holds, "leases": files, "backups": map[string]any{"units": units, "processes": procs}}
}

func sortedKeysOfSessions(sessions map[string]map[string]any) []string {
	keys := make([]string, 0, len(sessions))
	for id := range sessions {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	return keys
}
