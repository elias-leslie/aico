# Status baseline inventory

Initial badge: 16. Every non-ok row is below, including off and quiet unknown rows that do not count toward the badge. The unknown app-worker rows are not failures asserted by this cleanup; their machine is explicitly off.

| Row | Shown | Reason | Disposition |
|---|---|---|---|
| davion-sidarli/check-tripwire | failed | the workstation: Auth config changed (Tue 21:34): /etc/sudoers.d/60-host-steward content. Nothing explains it. Check it, then run: host-steward security-ack --event 85bcaccdea --note WHY. | Current report retained for coordinator to route; no failure suppressed. |
| jobs/github-publish | failed | Exited 1: Publication: 2 pushed; 2 failed. | Current report retained for coordinator to route; no failure suppressed. |
| davion-sidarli/backup/external/portfolio-ai-complete | failed | The backup owner machine could not be reached; its last artifact date is shown. | Confirmed current by backup owner; preserved. Active backup work may change count independently. |
| davion-sidarli/check-trends | failed | PVE host thin pool: pve/data data 65.2%, +1.11/day, worsening: pve/data data reaches 92.0% in ~24 days. Guests freeze if the pool fills. Free space (discard, snapshot pruning) or grow the pool before then. | Current report retained for coordinator to route; no failure suppressed. |
| publish:blackbox | failed | Local check failed at 519ce38b82: browser-e2e, go-tests, osv, webcrypto. Owning agent: fix it and check again. | Current report retained for coordinator to route; no failure suppressed. |
| publish:ominull | failed | Main has no local check at cfbbecee35. Owning agent: run st check --acceptance. | Current report retained for coordinator to route; no failure suppressed. |
| fleet/davion-sidarli/agent-work | late | Waiting for agent-work to connect. | Wrong: guest confirmed stopped. Fixed by live Proxmox power report. |
| fleet/davion-sidarli/neri-hunters | late | Waiting for neri-hunters to connect. | Wrong: guest confirmed stopped. Fixed by live Proxmox power report. |
| portfolio-ai/portfolio-aca-landscape | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-backfill-indicators | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-capture-macro-tape | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-check-disk | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-check-freshness | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-cleanup-agent-runs | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-cleanup-backups | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-cleanup-debug | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-cleanup-logs | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-cleanup-maintenance | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-cleanup-models | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-cleanup-news | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-cleanup-snapshots | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-cleanup-temp | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| jobinator-4000/nightly_enrich_wf | unknown | Waiting for this worker's first scheduled result. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| jobinator-4000/deferred_ab_sweep_wf | unknown | Paused in Jobinator settings. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-covariance | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-db-size | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-drift-snapshot | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-earnings-surprises | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-fg-calc | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-fg-inputs | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-financial-health | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| jobinator-4000/followup_sweep_wf | unknown | Waiting for this worker's first scheduled result. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-ingest-fundamentals | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-ingest-macro | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-jenny-daily-household-maintenance | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-jenny-weekly-price-check | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| jobinator-4000/nightly_screen_wf | unknown | Waiting for this worker's first scheduled result. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| jobinator-4000/backend | unknown | Jobinator backend stopped. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| jobinator-4000/worker | unknown | Hatchet worker process stopped. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-macro-gate | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-maintain-historical | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-market-macro-calendar-ingestion | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| jobinator-4000/market_trends_wf | unknown | Waiting for this worker's first scheduled result. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| jobinator-4000/nightly_scan_wf | unknown | Waiting for this worker's first scheduled result. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-options-activity | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/service | unknown | API stopped. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/worker | unknown | Hatchet worker is running. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-profile-news | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-putcall-ratio | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-refresh-news-sentiment | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-refresh-ohlcv | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-refresh-property-valuations | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-refresh-watchlist-intraday | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-refresh-watchlist-ohlcv | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-refresh-watchlist-scores | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-research-universe-refresh | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-rotate-logs | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-rules-validation | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-sec-cik | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-snapshots | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-source-health | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-sync-accounts | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-tlh-scan | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-vacuum-db | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-valuation-metrics | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-vehicle-due-alerts | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| jobinator-4000/webinar_refresh_wf | unknown | Waiting for this worker's first scheduled result. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| portfolio-ai/portfolio-yfinance-ref | unknown | Scheduled on the app's worker. No run has been reported to Aico yet. | Quiet: owning apps VM is off; retained as unknown and already outside badge. |
| davion-sidarli/backup/drive/aico-davion-sidarli | warn | No verified copy yet. | Confirmed current by backup owner; preserved. Active backup work may change count independently. |
| davion-sidarli/check-assets | warn | fydor-lab-win11 (111) is a lab machine but is not verified isolated: declared isolated, but no NIC evidence. Its tier assumes it cannot reach the LAN. Check its network cards and the PVE firewall. | Current report retained for coordinator to route; no failure suppressed. |
| davion-sidarli/backup/drive/blackbox-vault-archive | warn | No verified copy yet. | Confirmed current by backup owner; preserved. Active backup work may change count independently. |
| jobs/context-unused | warn | 0 items have no recorded use across at least 3 observed sessions. 1/26 deliveries fully observed; 25 sessions unavailable. | Current report retained for coordinator to route; no failure suppressed. |
| davion-sidarli/backup/drive/ominull-production-state | warn | No verified copy yet. | Confirmed current by backup owner; preserved. Active backup work may change count independently. |
| davion-sidarli/check-sudo | warn | 11 new sudo commands: ./host-steward declare, 8, bin/tether and 8 more. Expected if declared (host-steward or nightshift declare) or run by a known agent; they count as normal after a day. Don't know one? journalctl -t sudo --since -1d -g NAME shows who ran it. | Current report retained for coordinator to route; no failure suppressed. |
| davion-sidarli/check-workstation | warn | A package update wants a reboot. Reboot when the work in flight is done. | Current report retained for coordinator to route; no failure suppressed. |
| davion-sidarli/check-probes | warn | 2 agent-driven local Chrome (3.1 GiB); 0 fallbacks from the browser VM to local Chrome in 24h (+53 while the browser VM was off on purpose). Agent browsers belong on the browser VM; local ones eat workstation memory. Check why the browser VM is not answering and close stray local Chrome. | Current report retained for coordinator to route; no failure suppressed. |
| davion-sidarli/backup/drive/agent-hub-telegram-bot-v1 | off | This source path is gone. Older snapshots may still contain its files. | Off by design; already outside badge. |
| davion-sidarli/backup/native/agent-hub-telegram-bot-v1 | off | This source path is gone. Older snapshots may still contain its files. | Off by design; already outside badge. |
| davion-sidarli/backup/drive/a-term | off | This source path is gone. Older snapshots may still contain its files. | Off by design; already outside badge. |
| davion-sidarli/backup/native/a-term | off | This source path is gone. Older snapshots may still contain its files. | Off by design; already outside badge. |
| davion-sidarli/backup/drive/aico-web-state | off | This source path is gone. Older snapshots may still contain its files. | Off by design; already outside badge. |
| davion-sidarli/backup/native/aico-web-state | off | This source path is gone. Older snapshots may still contain its files. | Off by design; already outside badge. |
| jobs/m11a-fleet-review-proof | off | Fleet check finished. Normal jobs restored. | Off by design; already outside badge. |
| davion-sidarli/backup/drive/tether | off | This source path is gone. Older snapshots may still contain its files. | Off by design; already outside badge. |
| davion-sidarli/backup/native/tether | off | This source path is gone. Older snapshots may still contain its files. | Off by design; already outside badge. |
| jobinator-4000/machine | off | VM 180 is off after verification. | Off by design; already outside badge. |
| portfolio-ai/machine | off | VM 180 is off after verification. | Off by design; already outside badge. |
