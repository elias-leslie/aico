# Interrupted Pi recovery: Aico readiness milestone

Scope: Aico recovery code and control-plane facts only. No case files, hunter transcript, evidence, report, auth contents or live target traffic were inputs. The original hunt/root was not ended, replaced or respawned by this lane. The Neri coordinator owns final live re-entry and acceptance.

## Preserved observations

- Hunt `nh-315638ecef`, root `hunt-nh-315638ecef`, session `d23a2f8a`.
- Original saved Pi conversation `47d6c333-e62a-476e-982a-467541eb880f`.
- Expected saved selection, read only from Tether's `session_launch_options` metadata: `opencode-go/glm-5.3`, reasoning effort `max`.
- Root was a running fallback shell with `agentExit.status=78`; no crash recovery record existed. Neri said started, runtime ready, container stopped, prior push OK, booking absent.
- Previous-boot Tether journal: restore started at 17:20:23 EST and reported four restored, zero failed at 17:20:34. NetworkManager did not receive a LAN DHCP lease until 17:28:29. These are separate facts; a shell dispatch was already enough to report success before LAN readiness.
- Neri worker restored the same owned source container and tick, preserving its home and state without pulling case data. Its installed live-process probe correctly returned `running=false` before Pi resumed.

## Defects and changes

1. `Continuity.restoreOne` accepted a dispatched running pane without checking the native agent. Restore now confirms the expected conversation through live process observation; configured entries use a filtered native-process probe. An entry and an old session file cannot qualify as Pi.
2. Entry exit 78 was outside crash classification, so the fallback shell had no supported recovery action. Exit 78 is now held with a reason and `tether recovery resume`; exit 75 means temporary prerequisites and retries the same conversation. Neri owns the matching entry/runtime implementation.
3. Reboot and crash launch retries could expire after 15 minutes. Transient prerequisite waits now continue until readiness returns. Pending reboot attempts survive daemon restart. Terminal failures stay explicit; actual repeated-crash protection remains.
4. `Placement.place` returned a no-op for a known root whose reservation had vanished. It now checks room and books on that same host. Placement preserves original host/needs/capabilities in its own durable settings. Both restore paths rebook recorded needs before launch; recovering entry bookings are retained.

An old booking already lost before this upgrade has no needs metadata to reconstruct. For this root the coordinator can seed the known 4.5 GiB/2 CPU needs once:

```sh
tether recovery resume d23a2f8a --mem-bytes 4831838208 --cpus 2
```

Afterward, recovery reads recorded placement needs automatically. The command must be run only after the new Tether is deployed, the session is held, and Neri's existing runtime is ready. It preserves the root and saved native conversation; it does not replay the original hunt prompt.

## Verification and acceptance

Regression tests drive the real restore/recovery state machines with synthetic process/control-plane fixtures. They cover false shell success, terminal 78, temporary 75 beyond the former cutoff, daemon restart at a pending fallback shell, a probe that disproves an old conversation observation, a different live conversation left untouched, and missing reservation plus delayed readiness followed by automatic booking and exact-conversation resume. Placement tests also exercise durable intent recovery after its active booking disappears.

Final managed gate: PASS, 16 stages run; 404 related TypeScript tests, 1,232 host tests and 174 contract tests passed, along with types, lint, dependency boundaries, secret scan and UI-source lint. The two nonapplicable security stages were skipped by the gate. Deployment and live acceptance are recorded below when complete. Tests are not proof of the live hunter.

Required live postconditions: same hunt/root and saved Pi UUID; actual native Pi process; original container running; valid 4.5 GiB/2 CPU reservation; expected model and reasoning effort; recovery reports recovered only after the native process is observed. Coordinator performs the live mutation and independent verification.

Realistic interruption drill: use a synthetic hunt with a saved Pi UUID and recorded needs; interrupt its host/daemon or native process, remove its active booking while retaining placement metadata, keep LAN/internal services unavailable past the former 15-minute boundary, then restore prerequisites. Without a coordinator resume, observe pending/held honesty, preserved files/UUID, one native Pi, a rebooked original host and expected model/effort. Repeat with abrupt power loss and a process SIGKILL. This lane has not rebooted or power-cut the workstation, or sent target traffic.

## Live deployment and interruption evidence

- Aico recovery commit `6c907958a67803a7e7a2e61faf04c4c34e4c89ad` deployed through managed job `aico-ae134dc88fb6`. Clean-commit acceptance passed all 3,458 TypeScript tests, 1,232 host tests and 174 contract tests. The live session then correctly exposed held exit 78 and its supported resume action.
- The coordinator ran the command above once. It retained the original root and native UUID and seeded a held local reservation of 4,831,838,208 bytes / 2 CPUs plus matching durable placement intent. Entry then returned retryable 75; Aico reported waiting and retried with fresh generations, preserving the UUID and booking.
- Direct read-only runtime checks found the ready marker, running/unpaused container, active tick, no pause, green disk and push OK. Both configured internal control-port checks failed inside the container. Neri independently confirmed host ports answered while the container namespace had only loopback, no routes and no network helper.
- Neri reproduced the helper lifetime defect in a synthetic container: its helper inherited the launching session scope while the container lived in another cgroup. The Neri follow-up owns repairing the existing namespace and giving the helper an independent per-hunt service lifetime. This is a distinct runtime defect, not a reason to replace the hunter or issue another resume command.
- The misleading retained-agent notice was separately fixed in Aico commit `34abcd27ba3eea230e649051437a471e733078ca`, deployed through managed job `aico-50b5a6af6d96`. An exited agent now says the session remains open; an actual retired session still says ended. Its regression was reproduced before the wording fix; the managed gate passed 345 related tests and the deployment's full acceptance passed.
- That actual Tether restart preserved the live pending retry. After restart the same native UUID remained resumable, recovery stayed waiting at exit 75, and its next-attempt timestamp and root generation advanced automatically. No second resume command was run.

## Verified recovery

At 18:24 EST the joint live checks passed:

- Same root `hunt-nh-315638ecef`, widget `d23a2f8a`, native Pi UUID `47d6c333-e62a-476e-982a-467541eb880f`. The coordinator issued the one seed/resume command above; all later prerequisite retries converged automatically.
- Live native Pi PID `173028` belongs to the original container. The coordinator approved reading only its nonsecret `TETHER_AGENT_SESSION_ID` control field, and it exactly matches the saved UUID. Pi rewrites its argv to `pi`, so the original argv-only probe was a false negative. Neri probe commit `72584d9013c218cd052639e22ad1bb62fda35925` retains native-executable/container-membership checks and filters only that one control field; it emits only the agreed `{running,pid,resumeId}` JSON.
- Separate filtered launcher selection checks matched `opencode-go/glm-5.3` and effort `max`, consistent with the durable launch options. No raw environment, auth value or session contents were returned. Aico observed a working turn followed by healthy idle; the native process remained running.
- Original container ID `66ba91d588fd079f89533646845d9fd0b00a24727f15ea1ec2721320ce9e9409`, created 15:08:38 EST, remains running with container PID `36319`. Network repair preserved that PID and namespace. Its hard memory limit is 4,831,838,208 bytes; CPU quota/period is 200,000/100,000, matching 2 CPUs.
- The same root holds a valid local reservation of 4,831,838,208 bytes / 2 CPUs. Matching durable placement intent is present. Runtime is ready, unpaused, with last push OK and not stale.
- Neri network repair commit `b7d397ade959ab4a97838b80c9479bc46c2390ea` restores the helper under `neri-hunt-nh-315638ecef-network.service`. That service and the updated tick are active with `Restart=on-failure`, in their own sibling per-hunt service cgroups rather than the launcher scope. Its native fault test killed the helper, repaired the original test namespace, and restored both sockets without changing the test container PID/namespace.
- Aico late-confirmation commit `6d7c1617fc9339c3ab87b54f4f55688a18a4bf71`, deployed through managed job `aico-8591daef3e30`, accepts a previously launched held/waiting agent only after its live PID/UUID and booking match. The reproduced regression passed after the fix. Clean-commit acceptance passed 3,459 TypeScript tests plus native checks. Compatible probe installation was held until this code was active.
- Tether now reports `state=recovered`, `reason=null`, with `recovered_at=1793920972807`. Native Pi PID `173028` and root generation `d1d64e9b598825663a0672fcf51f44115142e11f03438da965216d8a648e517b` were unchanged across that late confirmation and the preceding Tether deployment. Confirmation updated control-plane state without another resume or respawn.

At 18:30 EST the coordinator retired the finished Neri repair lane `cf2beecf`. After that exact old failure trigger, native Pi PID `173028` still matched the original UUID, the original container PID `36319` remained running, both internal control ports still passed, network/tick services stayed active, the 4.5 GiB / 2 CPU booking stayed held, and Tether remained recovered with no reason. The repaired network lifetime is independent of the coding lane in the live hunt.

The workstation was not deliberately rebooted or power-cut, and no intentional public-internet outage was run in this milestone. The realistic interruption drill above remains the broader outage exercise. No further recovery implementation fix or coordinator action remains within this milestone. Remaining: None within the agreed scope.
