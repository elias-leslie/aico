# Remote-use shakedown, Nov 8

The owner requested a proper plan followed by multiple Terra/Luna user testers,
careful temperature/performance/memory observation, and simple fixes in existing
seams. Start execution after the preceding walk-away checkpoint is complete.
No publication, full backup, deliberate heating, real power cut, password changes,
backup deletion or production-data rewrite is part of this plan.

## Preserve Claude's completed work

Read the reports under `/srv/scratch/briefs/usage-burn-2026-11-08/`: shakedown-cli,
shakedown-web, shakedown-drills, shakedown-fixes, shakedown-reboot and lane11-final;
read `docs/power-off-test.md`. The fixes report was stale. Transcript commit/deploy
receipts and Git ancestry show the interrupted workers completed more than it
listed. All 13 recovered Aico fixes through `f099c4dd`, `431732f0` and `20d91524`
are included in currently deployed `32e740a8`. Preserve them.

Existing evidence to reuse rather than repeat for its own sake:

- Six short network cuts proved connector takeover/withdrawal and quiet recovery;
  a clean workstation reboot restored four sessions. Today's later gem reboot
  freshly proved its selected guests and native guard recover.
- Web/jobs restart adopted running jobs without starting duplicates; a killed
  scheduler restarted. Deploy rollback has six meaningful synthetic tests, not
  a deliberately failed live deployment.
- Aico README restored from Drive (3,994 bytes); old report records Jobinator and
  Dadbot restore/integrity checks. This is bounded restore evidence, not a full
  machine recovery guarantee. Today's moved-source snapshot metadata was checked.
- Notification settings persisted and were restored; 390px/1440px Aico layouts
  were rendered. Some later application/standby UI goals never rendered because
  the tester used unsuitable routes. Those goals remain unproved.
- Real implementation-agent round trip and coordinator-route refusal worked.
  Standby sudden-stop recovery was not seen through; a clean restore and a
  throwaway-server crash proof are different evidence.
- Ten historical standby sessions stayed within memory, but those observations
  did not catch today's recursive CLI process explosion. Root fixed that exact
  recursion and independently monitored its successful two-controller retest.

## Sequence and acceptance

1. **Close prior work.** Verify owner-aware backup health and the BlackBox registry
   correction live; all agreed guest states and service health checked. Preserve
   the three old-repository copies while the new owner awaits its first copy.
2. **Preflight.** Record both hosts' cheap CPU/memory/pressure/sensor baseline,
   relevant guest states, service restart/OOM counts, current browser/session
   resources and active work. Use existing overlap handshakes before an actual
   shared-host interruption. No new reboot is planned.
3. **Real user journeys.** Two native `user-tester` agents (GPT-6.1 Terra, xhigh)
   receive only goals, normal URLs/commands/help and cleanup constraints. Give each
   its own named browser/session resources. First verify Aico phone-width desktop
   journeys and a throwaway session round trip; independently verify application
   pages and the standby CLI workflow. The coordinator supplies valid local routes
   and does not send testers to Access login or invent a failed app from a wrong
   URL. Read Status/Backups/Machines/Routines, inspect recoverable files, and test
   ordinary navigation/reconnect/own-session cleanup. Never answer the owner's
   real asks, type in an existing session, touch saved secrets, submit job
   applications, change family records or start intentionally paused AI work.
4. **Recovery gaps.** Check actual Tether boot results and pending-input state
   metadata. Reproduce meaningful historical issues at their supported existing
   isolated test seams before considering live disruption. Reuse completed
   injected guard/agent-delivery tests; no real heat or failure alarm is required.
   A second warm navigation pass checks obvious resource growth under normal use;
   no synthetic load flood or new soak platform.
5. **Validate and finish.** Root validates every tester finding against live
   behavior/source before fixing it. Make the smallest effective change, focused
   regression check, routine local commit and managed deployment where necessary.
   A meaningful change gets a fresh independent review; tiny help/config changes
   get proportionate checks. Rerun the affected journey, then remove only created
   sessions/tunnels/scratch runtimes. Verify VM100 naturally off when unused,
   desired guests/autostart intact, no test jobs/services or changed preferences,
   and schedules/intentional pauses intact. Record proven, failed and untested
   separately. Remove this plan's ROADMAP line only when agreed work is complete.

## Resource observation and response

Keep gem's installed native guard active throughout. Normal production sampling
stays 15 seconds. During active tests only, use a temporary low-cost observer:
one persistent SSH stream from gem plus local workstation reads, every two
seconds. Read cached sensors, /proc CPU/memory pressure, CT190 memory/pid/OOM
counters; write a small scratch log. This introduces no production service,
notification channel, benchmark framework or enduring monitoring policy.

Use existing thresholds: gem's configured hot threshold 85 C; workstation's
configured k10temp warning 88 C; ST's memory full-pressure limits. On a breach,
wake the root via the existing Aico wait mechanism, pause/cancel only owned test
commands, inspect actual contributors and let the host recover. Never kill an
agent for taking time or stop another agent's work without coordination. A sensor
or observer failure is unknown, so do not add test load while blind. Record peaks
and baseline/end-state evidence; CPU utilization alone is not a temperature.

## Honest limits / owner involvement

The owner skipped unwired smart-plug/power-cut testing. Do not repeat the ask.
A clean reboot does not prove BIOS power-on after mains loss or WOL from fully off.
Public mobile-data reachability and actual handset receipt cannot be proven by
headless local rendering or an FCM sent receipt. If needed, file one standalone
Aico Needs you question for a bounded handset check, respecting notification/Test
settings and silent channels. Do not request new logins or change notification
preferences. Other genuine owner-only decisions go through Aico Ask; continue
independent work while waiting.

Long network partitions can duplicate a reminder/digest slot after its lease
expires (`lane2-failover-report.md`). This documented tradeoff is not evidence of
a new failure and does not justify adding consensus machinery for a solo setup.

## Execution evidence

The preceding checkpoint was closed at `c655fa7a`. Owner-aware backup health,
BlackBox presence and recovered routine completion were checked on both installed
controllers at `cc8b8ede`; native backup/asset checks were healthy. No full backup
was started to clear a historical stopped-run result.

Three native Terra user testers completed bounded read-only journeys:

- Aico at 390x844 and Status at 1440x900: navigation, Status, Backups, Routines,
  Machines and Files passed. A throwaway Workstation Codex session replied READY,
  survived reload and ended. Standby failed to launch Codex: the actual pane said
  `exec: codex: not found`, preserved exit 127, and contained only fallback Bash.
  Both throwaway sessions and the tester's browser were ended.
- Jobinator at 390x844 and 1280x800: Today/Discover navigation, no-match search and
  recovery, application filtering and page width passed. Standby's read-only
  Status/Backups/Machines/Routines pages rendered. Duplicate reviewer labels and
  the false universal explanation of Off rows were independently source-checked.
  Jobinator's label fix `0b9098d` passed managed checks, was deployed by its recorded
  CT191 procedure after the generic facade explicitly refused remote deployment,
  and root verified distinct rendered choices. No AI/preferences were changed.
- Portfolio at 390x844 and 1280x800: main navigation, no-match search/recovery and
  natural loading/incomplete states passed. The tester found a vehicle all-clear
  despite missing evidence, a NASDAQ exchange/ticker notice misclassified as broad
  market context, and one scroll-dependent partially covered heading. Root
  confirmed the first two against source/screenshots; their narrow corrections
  are in progress. The layout observation is not yet an independently reproduced
  defect. No financial actions, account changes, refresh jobs or records changed.

Reports and private screenshots remain under
`/srv/scratch/readiness-remote-shakedown/{aico-user,apps-user,portfolio-user}`.
Portfolio screenshots contain household information; do not publish them.

Standby's supported Codex CLI 0.166.0 now matches the workstation, installed via
the existing managed admission command and official npm package. Its native
sign-in is absent; a real Codex device-sign-in process was opened using Aico's
existing host sign-in action. The owner has a Needs you item to finish it; no
credentials were copied, altered or printed. The actual READY/reload/end retest
remains pending that sign-in and deployment of executable readiness checks.

Portfolio VM180 was started only after its agent cleared overlap. The actual
guest SSH key differed from the workstation's stale cached IP keys. Root verified
the public key and fingerprint through Proxmox QGA before updating that IP's
known-host entry. The existing API forwarder then returned health 200 and the
temporary frontend forward returned 200. Guest keys, login credentials, aliases
and forwarding restrictions were unchanged. Restore the guest to its prior off
state after the owned verification/release work.

Current recovery metadata has no waiting sessions on either controller. The
workstation's boot record has four restored sessions and no failed or pending
entries. Standby's older restore record refers to an already-ended session; it
does not prove a current recovery failure or an untested sudden-stop recovery.
Both controllers' three services, Jobinator's two services and the native guard
were active with zero automatic restarts at the post-journey check.

Final deployment, resource totals, cleanup and guest-state verification remain
to be recorded before this shakedown is closed.
