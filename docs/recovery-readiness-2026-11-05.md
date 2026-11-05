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

Current live acceptance remains with the Neri coordinator until the network prerequisite is restored and the native Pi process, matching UUID/model/effort, running original container and valid booking are observed together. At this checkpoint no live Pi process had been confirmed; tests and a running fallback shell are not completion.
