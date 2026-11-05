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

Current live acceptance remains with the Neri coordinator until its postcondition receipt is attached.
