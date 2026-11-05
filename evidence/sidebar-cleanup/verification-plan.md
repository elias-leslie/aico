# Sidebar cleanup verification

Baseline acceptance: successful full receipt at source 25bdcd1e, reused by ST. Source checkpoint: 461f08cd96c5919790fb69bcec7bec3016069749, descendant of the committed Logins and backup fixes.

The initial live list had 14 ended test chats. They are attributed in chats.md; chat-end-receipts.json records normal End responses and unchanged transcripts. No owner chat was targeted.

The initial Status badge counted 16. The baseline inventory lists all 87 non-ok rows, including 60 quiet unknown rows and 11 off rows. Backup work in another lane independently changes these counts; compare status-predeploy.json with status-after.json to attribute this release's two stopped-peer corrections.

Review was independent code review, with two reproduced and fixed findings. Live evidence must separately establish deployed source, absent ended chats, retained Recent/history, marked test start/end, actual stopped-peer rows, and 390x844 rendered captures plus mechanical uilint. A test pass alone is not runtime evidence.
