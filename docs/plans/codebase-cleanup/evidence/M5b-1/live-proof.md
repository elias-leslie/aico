The scratch alarm used its own state directory and a one-second window; it never stopped or changed the production heartbeats and did not publish fake outage rows into production.

At 03:23:24 UTC, gem sent one TEST (ignore) availability alert through the existing encrypted FCM phone route. FCM accepted one of one recipients. The phone signed a receipt for that exact message id, reporting receipt at 03:23:25 UTC with shown=true. A second outage tick retained the same delivery id and did not send again.

At 03:24:45 UTC, the scratch CT 190 heartbeat resumed. Gem sent one silent recovery through the same route. The phone signed its exact receipt at 03:24:46 UTC with shown=true. A second recovery tick did not send again. The final scratch state has zero open alarms, exactly two delivery events, and one accepted recipient in each event: one test alarm plus one recovery.

The source machine rows, both heartbeat ages, sender, rescue login, local PVE health and ECC rows all show ok on the workstation and on CT 190. The live audit initially caught the missing gem machine row, which had made otherwise healthy service rows show unknown; the regression and deployed fix are in 983c325e. The final views show all eight gem rows as ok.

A forced host-steward token refresh minted a fresh token at 03:16:24 UTC; gem's safe route-status view reports that same mint time and its later expiration. No key, device token, signing material or access token is included in evidence.

The scratch state and task-owned deployment exports were removed after the proof. The installed sender and both heartbeat timers remain running.
