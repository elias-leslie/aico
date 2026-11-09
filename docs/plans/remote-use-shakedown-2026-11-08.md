# Remote-use shakedown, Nov 8

The owner requested a proper plan followed by multiple Terra/Luna user testers,
careful temperature/performance/memory observation, and simple fixes in existing
seams. Start execution after the preceding walk-away checkpoint is complete.
No publication, full host/VM backup, deliberate heating, real power cut, password changes,
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
  passed review/checks and were released at `4718e784`. Root verified all three
  vehicle cards show incomplete due status and the original exchange/ticker
  notice disappeared while other news still rendered. The layout observation is
  not an independently reproduced
  defect. No financial actions, account changes, refresh jobs or records changed.

Reports and private screenshots remain under
`/srv/scratch/readiness-remote-shakedown/{aico-user,apps-user,portfolio-user}`.
Portfolio screenshots contain household information; do not publish them.

Standby's supported Codex CLI 0.166.0 now matches the workstation, installed via
the existing managed admission command and official npm package. Its native
sign-in was absent; a real Codex device-sign-in process was opened using Aico's
existing host sign-in action. The first code expired; root supplied a fresh
direct session link and an Open button on the same Needs you item. The owner
completed sign-in, native status returned success, and the ask was closed. No
credentials were copied or printed. A Terra tester then completed the actual
Standby READY/reload/end journey: response in two seconds, reply retained after
reload, throwaway ended and browser closed. Trust was accepted only for the
verified owned Aico project directory. The UI offered no model selector; the
native response used the default GPT-6.1-Sol. The tester itself used Terra.

Executable readiness was released on both controllers through `cf6e4831` after
the fresh review caught and the author fixed actual auth-shim targets, retained
gate environment/cwd, and Blank Slate native targets. Final author checks:
1,044 related tests passed, one existing skip, types/lint/boundaries/uilint clean.
Fresh reviewer independently passed 47 focused tests and found no remaining
supported defect. The false universal Off explanation also passed live rendering.

Portfolio VM180 was started only after its agent cleared overlap. The actual
guest SSH key differed from the workstation's stale cached IP keys. Root verified
the public key and fingerprint through Proxmox QGA before updating that IP's
known-host entry. The existing API forwarder then returned health 200 and the
temporary frontend forward returned 200. Guest keys, login credentials, aliases
and forwarding restrictions were unchanged. The guest was restored to its prior
off state after owned verification/release work; all temporary page forwards and
owned browser sessions were closed.

Portfolio's existing release procedure required an app-level predeployment
backup. Root used its existing no-prune option under a temporary half-core CPU
cap: one 104,890,292-byte database/upload archive was added, with all 58 prior
complete archives retained (59 afterward). No host/VM export ran. The temporary
override was removed; the same normal half-core backup cap was committed in the
unit template at `e966a23b` and installed in the guest's native unit. Its actual
CPUQuotaPerSecUSec was 500ms. Existing retention policy was not rewritten.

At 19:26 EST the actual CBOE endpoint returned HTTP 200 and all three categories
with empty call/put lists. Portfolio's historical Options activity warning is
therefore supported by current empty upstream data; its cause is not established.
No schema failure, closed-market explanation or successful data refresh is
claimed, and the warning was not artificially cleared.

Current recovery metadata has no waiting sessions on either controller. The
workstation's boot record has four restored sessions and no failed or pending
entries. Standby's older restore record refers to an already-ended session; it
does not prove a current recovery failure or an untested sudden-stop recovery.
Both controllers' three services, Jobinator's two services and the native guard
were active with zero automatic restarts at the post-journey check.

The initial final resource review found 20 observations at or above 80 C,
none at or above the 85 C guard threshold; peak 84.5 C. The bursts recur roughly
once a minute during 19:25–19:34 EST, before the later app release/backup. Their
process is not established. No owned Portfolio page was open in that window.
Source review identifies expensive health reads as candidates, not a diagnosis.
Root completed one coordinated, bounded read-only process/query attribution
probe. `/health/detailed` returned 200 in 3.505 seconds; the request window used
2.09 CPU-seconds in the API and 0.95 in PostgreSQL. Guest parallel PostgreSQL
workers were observed, but no named aggregate-query family was captured.
Temperature peaked at 67.375 C during that request and returned to 47.375 C.
The earlier minute-spaced 84.5 C bursts were not reproduced and remain
unattributed. No performance change was made from a source-only hypothesis.
No confirmed overheating or sustained pressure was observed.

## Closed checkpoint

The temporary resource log covers 18:59–19:58 EST (1,924 observations). Peak
workstation temperature was 72.375 C; gem peaked at 84.5 C. There were zero
configured temperature/pressure breaches and zero new standby OOM events.
Workstation memory full-pressure avg10 briefly reached 0.36, below its configured
limit, and ended at zero; gem stayed at zero. Ending available memory was about
27.0 GB on the workstation and 28.8 GB on gem. Standby's higher cgroup total was
predominantly reclaimable release/package file cache, not evidence of a leak.

Both attribution samplers and the temporary two-second observer were stopped.
The native 15-second guard remains active, zero automatic restarts, normal mode,
fresh heartbeat, 50-percent-of-one-core normal backup cap and open admission;
its later live check reported 48 C. No permanent extra polling service was added.

VM180 was shut down again immediately after the one-request probe. VM100 and
VM180 are confirmed stopped; the six selected containers and Dadbot remain on.
Active Proxmox configuration and the API inventory match the linked full guest
table, including BlackBox autostart and browser on-demand/no-autostart. All owned
test sessions/browsers, expired/completed sign-in sessions, temporary forwards
and own overlap handshakes are closed. There are no open owner asks.

The first new-owner full scheduled Drive copies were not forced during this
shakedown; their ordinary schedules are restored and old verified copies remain
retained. This checkpoint does not claim those future runs have succeeded.
Actual mobile-carrier access, handset notification receipt, a mains-loss recovery,
and full-machine restore remain outside the evidence described above. The owner
declined the unwired power-cut test; notification Tests remains off as chosen.

One operator-visibility limit remains: Standby's direct root-SSH inspection of
Proxmox-native timer rows was unavailable. Their actual health was verified from
the workstation, and the native guard does not depend on that SSH path. Standby's
existing Proxmox VM API inventory works; its managed service command also worked
when invoked with the normal pane PATH. No root keys or new administrative access
were copied to broaden the boundary. This is not evidence that a native timer is
failed or that Standby itself is down.

Remaining: None within the agreed bounded shakedown scope. Historical burst
attribution and the explicit untested recovery/network limits are not represented
as proved or silently replaced by assumptions.
