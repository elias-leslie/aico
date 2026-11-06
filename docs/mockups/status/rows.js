// Mockup data. The first four davion-sidarli rows are the real rows from
// GET /api/status on 2026-11-03 (times as served); the rest are made up to
// cover every kind, machine and shown state. The screen reads "now" as
// Tue 2026-11-03 8:25 PM (America/New_York).
window.MOCK_NOW = Date.parse('2026-11-03T20:25:00-05:00')

// Machine labels come from the hosts registry, not from the row.
window.MACHINE_LABEL = {
  'davion-sidarli': 'davion-sidarli',
  'davion-gem': 'davion-gem',
  aico: 'aico · CT 190',
  apps: 'apps · VM 180',
  'agent-work': 'agent-work · VM 200',
  'neri-hunters': 'neri-hunters · VM 201',
}

const t = (s) => `2026-${s}-05:00`
const A = (kind, ref) => ({ kind, ref })

// Each entry: the row as the writer posted it, plus `at` (when the server took it).
window.MOCK_ROWS = [
  // --- real rows (GET /api/status) ---
  {
    id: 'davion-sidarli/aico-web', what: 'Aico web server', kind: 'service',
    machine: 'davion-sidarli', project: 'aico', state: 'ok',
    meaning: 'Serving the app and API on 127.0.0.1:3002.',
    last_run: t('11-03T20:22:33'), next_run: t('11-03T20:32:33'),
    actions: [A('run', 'systemctl --user restart aico-web.service'), A('log', 'journalctl --user -u aico-web.service')],
    at: t('11-03T20:22:33'),
  },
  {
    id: 'davion-sidarli/notes-export', what: 'Notes export to Drive', kind: 'job',
    machine: 'davion-sidarli', project: 'aico', state: 'ok',
    meaning: 'Not exporting tonight: gem is linked and does the nightly export.',
    last_run: t('11-03T20:12:41'), next_run: t('11-04T21:12:41'),
    actions: [A('run', 'systemctl --user start aico-notes-export.service'), A('log', 'journalctl --user -u aico-notes-export.service -u aico-web.service')],
    at: t('11-03T20:12:41'),
  },
  {
    id: 'davion-sidarli/machine', what: 'davion-sidarli', kind: 'machine',
    machine: 'davion-sidarli', state: 'ok', meaning: 'Up and reporting to Aico.',
    last_run: t('11-03T20:22:33'), next_run: t('11-03T20:32:33'),
    at: t('11-03T20:22:33'),
  },

  // --- made up: problems ---
  {
    id: 'aico/aico-db-drive', what: 'Aico database to Drive', kind: 'backup',
    machine: 'aico', project: 'aico', state: 'failed',
    meaning: 'Upload refused: the Drive login expired. The newest copy on Drive holds data from Nov 1, 2:10 AM.',
    last_run: t('11-03T02:10:00'), next_run: t('11-04T02:40:00'),
    actions: [
      A('run', 'systemctl --user start aico-backup-drive.service'),
      A('log', 'journalctl --user -u aico-backup-drive.service'),
      A('detail', '/status/backup/aico-db-drive'),
      A('look', '/srv/workspaces/projects/aico'),
    ],
    at: t('11-03T02:11:04'),
  },
  {
    id: 'davion-sidarli/listeners', what: 'Listening ports', kind: 'check',
    machine: 'davion-sidarli', state: 'failed',
    meaning: 'New listener on 0.0.0.0:8890 (python3, pid 41822) that isn’t on the allowed list.',
    last_run: t('11-03T20:15:00'), next_run: t('11-03T20:45:00'),
    actions: [A('run', 'aico host check listeners'), A('log', 'aico host log listeners'), A('look', 'host checks on davion-sidarli')],
    at: t('11-03T20:15:02'),
  },
  {
    id: 'davion-sidarli/nightly-publish', what: 'Nightly GitHub publication', kind: 'job',
    machine: 'davion-sidarli', project: 'summitflow', state: 'ok',
    meaning: 'Published 6 repos.',
    last_run: t('11-02T03:31:00'), next_run: t('11-03T04:30:00'),
    actions: [A('run', 'st vcs publish --nightly'), A('log', '~/.local/state/summitflow/publish.log'), A('look', '/srv/workspaces/projects/summitflow')],
    at: t('11-02T03:31:10'),
  },
  {
    id: 'davion-gem/ecc', what: 'ECC memory errors', kind: 'check',
    machine: 'davion-gem', state: 'ok',
    meaning: 'No corrected or uncorrected errors.',
    last_run: t('11-03T08:00:00'), next_run: t('11-03T14:30:00'),
    actions: [A('run', 'aico host check ecc --host davion-gem'), A('log', 'aico host log ecc --host davion-gem'), A('look', 'host checks on davion-gem')],
    at: t('11-03T08:00:03'),
  },
  {
    id: 'apps/receipt-import', what: 'Receipt import', kind: 'job',
    machine: 'apps', project: 'portfolio-ai', state: 'ok',
    meaning: 'Imported 3 receipts.',
    last_run: t('11-02T06:00:00'), next_run: t('11-03T06:30:00'),
    actions: [A('run', 'portfolio-ai jobs run receipts'), A('log', 'portfolio-ai jobs log receipts')],
    at: t('11-02T06:00:41'),
  },
  {
    id: 'apps/job-search', what: 'Job search run', kind: 'job',
    machine: 'apps', project: 'jobinator-4000', state: 'ok',
    meaning: 'Found 14 new postings, 2 worth a look.',
    last_run: t('11-02T07:00:00'), next_run: t('11-03T07:30:00'),
    actions: [A('run', 'jobinator run search'), A('log', 'jobinator log search')],
    at: t('11-02T07:02:15'),
  },
  {
    id: 'agent-work/checkout-pull', what: 'Fresh checkouts from GitHub', kind: 'job',
    machine: 'agent-work', state: 'ok',
    meaning: 'Pulled 9 repos, read-only.',
    last_run: t('11-01T09:00:00'), next_run: t('11-02T09:30:00'),
    actions: [A('run', 'aico checkouts pull'), A('log', 'journalctl --user -u aico-checkouts.service')],
    at: t('11-01T09:00:12'),
  },
  {
    id: 'davion-sidarli/system-disk', what: 'System disk', kind: 'check',
    machine: 'davion-sidarli', state: 'warn',
    meaning: '86% full: 268 GB free of 1.9 TB. Warns from 85%.',
    last_run: t('11-03T20:15:00'), next_run: t('11-03T20:45:00'),
    actions: [A('run', 'aico host check disk'), A('look', 'disk use on davion-sidarli')],
    at: t('11-03T20:15:01'),
  },
  {
    id: 'davion-sidarli/grant-github-admin', what: 'GitHub admin grant', kind: 'grant',
    machine: 'davion-sidarli', state: 'warn',
    meaning: 'Open for 42 minutes. Revoke it once the change is done.',
    last_run: t('11-03T20:20:00'), next_run: t('11-03T20:50:00'),
    actions: [A('log', 'aico grant log github-admin'), A('look', 'the open github-admin grant')],
    at: t('11-03T20:20:00'),
  },
  {
    id: 'davion-sidarli/repo-aico', what: 'aico repo', kind: 'repo',
    machine: 'davion-sidarli', project: 'aico', state: 'warn',
    meaning: '1 open code-scanning alert (medium) on main.',
    last_run: t('11-03T03:40:00'), next_run: t('11-04T04:30:00'),
    actions: [A('log', 'st check codeql'), A('look', '/srv/workspaces/projects/aico')],
    at: t('11-03T03:40:20'),
  },

  // --- made up: healthy ---
  {
    id: 'davion-gem/machine', what: 'davion-gem', kind: 'machine', machine: 'davion-gem',
    state: 'ok', meaning: 'Up and reporting to Aico.',
    last_run: t('11-03T20:20:00'), next_run: t('11-03T20:30:00'), at: t('11-03T20:20:00'),
  },
  {
    id: 'aico/machine', what: 'aico', kind: 'machine', machine: 'aico',
    state: 'ok', meaning: 'Up and reporting to Aico.',
    last_run: t('11-03T20:21:00'), next_run: t('11-03T20:31:00'), at: t('11-03T20:21:00'),
  },
  {
    id: 'apps/machine', what: 'apps', kind: 'machine', machine: 'apps',
    state: 'off', meaning: 'Off by your choice.',
    last_run: t('11-02T16:51:00'), next_run: t('11-02T17:01:00'), at: t('11-02T16:51:00'),
  },
  {
    id: 'neri-hunters/machine', what: 'neri-hunters', kind: 'machine', machine: 'neri-hunters',
    state: 'off', meaning: 'Off.',
    last_run: t('11-03T09:12:00'), next_run: t('11-03T09:22:00'), at: t('11-03T09:12:00'),
  },
  {
    id: 'aico/aico-web', what: 'Aico web server', kind: 'service', machine: 'aico', project: 'aico',
    state: 'ok', meaning: 'Serving the gem front door on port 3002.',
    last_run: t('11-03T20:21:00'), next_run: t('11-03T20:31:00'),
    actions: [A('run', 'systemctl --user restart aico-web.service'), A('log', 'journalctl --user -u aico-web.service')],
    at: t('11-03T20:21:00'),
  },
  {
    id: 'aico/notes-export', what: 'Notes export to Drive', kind: 'job', machine: 'aico', project: 'aico',
    state: 'ok', meaning: 'Exported 1,284 notes to Drive.',
    last_run: t('11-03T02:12:00'), next_run: t('11-04T03:12:00'),
    actions: [A('run', 'systemctl --user start aico-notes-export.service'), A('log', 'journalctl --user -u aico-notes-export.service')],
    at: t('11-03T02:12:30'),
  },
  {
    id: 'aico/front-door', what: 'Front-door connector', kind: 'service', machine: 'aico', project: 'aico',
    state: 'ok', meaning: '4 connections to Cloudflare.',
    last_run: t('11-03T20:21:00'), next_run: t('11-03T20:31:00'),
    actions: [A('log', 'journalctl -u cloudflared-aico.service')],
    at: t('11-03T20:21:00'),
  },
  {
    id: 'davion-sidarli/link-aico', what: 'Link to aico on davion-gem', kind: 'link', machine: 'davion-sidarli', project: 'aico',
    state: 'ok', meaning: 'Linked. Notes in sync.',
    last_run: t('11-03T20:24:00'), next_run: t('11-03T20:29:00'),
    actions: [A('log', 'journalctl --user -u tether-link.service')],
    at: t('11-03T20:24:00'),
  },
  {
    id: 'davion-sidarli/snapshots', what: 'Workstation snapshots', kind: 'backup', machine: 'davion-sidarli',
    state: 'ok', meaning: 'Hourly snapshot at 8:00 PM; 48 kept.',
    last_run: t('11-03T20:00:00'), next_run: t('11-03T21:10:00'),
    actions: [A('run', 'sudo btrbk run'), A('log', 'journalctl -u btrbk.service')],
    at: t('11-03T20:00:20'),
  },
  {
    id: 'davion-gem/ct150-backup', what: 'OmniNull hub backup (CT 150)', kind: 'backup', machine: 'davion-gem',
    state: 'ok', meaning: 'Uploaded to Drive at 3:10 AM; data from 3:05 AM.',
    last_run: t('11-03T03:10:00'), next_run: t('11-04T03:40:00'),
    actions: [A('run', 'aico backup run ct150'), A('log', 'aico backup log ct150'), A('detail', '/status/backup/ct150-backup')],
    at: t('11-03T03:10:40'),
  },
  {
    id: 'davion-gem/vm-200', what: 'VM 200 agent-work', kind: 'vm', machine: 'davion-gem',
    state: 'off', meaning: 'Stopped. Start it from Hosts when you need it.',
    last_run: t('11-03T18:40:00'), at: t('11-03T18:40:00'),
  },
  {
    id: 'davion-gem/vm-180', what: 'VM 180 apps', kind: 'vm', machine: 'davion-gem',
    state: 'off', meaning: 'Off by your choice.',
    last_run: t('11-02T16:51:00'), at: t('11-02T16:51:00'),
  },
  {
    id: 'davion-gem/pve-storage', what: 'Proxmox storage', kind: 'check', machine: 'davion-gem',
    state: 'ok', meaning: 'local-lvm 41% used, 1.1 TB free.',
    last_run: t('11-03T20:10:00'), next_run: t('11-03T20:40:00'),
    actions: [A('run', 'aico host check storage --host davion-gem')],
    at: t('11-03T20:10:00'),
  },
  {
    id: 'davion-gem/watchdog', what: 'Workstation watchdog (off-host)', kind: 'check', machine: 'davion-gem',
    state: 'ok', meaning: 'Heard from davion-sidarli at 8:24 PM.',
    last_run: t('11-03T20:24:00'), next_run: t('11-03T20:29:00'),
    at: t('11-03T20:24:00'),
  },
  {
    id: 'davion-sidarli/tripwire', what: 'Tripwire files', kind: 'check', machine: 'davion-sidarli',
    state: 'ok', meaning: 'All 12 unchanged.',
    last_run: t('11-03T20:15:00'), next_run: t('11-03T20:45:00'),
    actions: [A('run', 'aico host check tripwire')],
    at: t('11-03T20:15:00'),
  },
  {
    id: 'davion-sidarli/grant-owner-chrome', what: 'Owner Chrome access', kind: 'grant', machine: 'davion-sidarli',
    state: 'ok', meaning: 'No grant open.',
    last_run: t('11-03T20:20:00'), next_run: t('11-03T20:50:00'),
    actions: [A('log', 'aico grant log owner-chrome')],
    at: t('11-03T20:20:00'),
  },
  {
    id: 'davion-sidarli/ollama', what: 'Ollama', kind: 'service', machine: 'davion-sidarli',
    state: 'off', meaning: 'Stopped on purpose.',
    last_run: t('11-01T12:00:00'), at: t('11-01T12:00:00'),
    actions: [A('run', 'sudo systemctl start ollama.service')],
  },
]
