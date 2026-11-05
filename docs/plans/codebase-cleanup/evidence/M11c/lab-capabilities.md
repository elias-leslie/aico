# Agent Hub lab capabilities

Read only Agent Hub source: `backend/app/storage/lab_credentials.py`, `backend/app/api/lab_credentials.py`, `backend/app/cli/lab_credentials.py`, `packages/st-cli/agent_hub_st/lab_credentials.py`, and the lab/remote-host tests. No Neri repository, data or session was read.

Agent Hub `request_logs` contained 9 successful lab-list GETs, one account enrollment POST, one partial-edit PATCH, and one successful DELETE. Other logged attempts were refusals or validation failures. Local CLI operations have no corresponding HTTP route hit, so their frequency is unknown; the coordinator explicitly required their contracts and Aico ports them.

| Capability | Aico behavior |
| --- | --- |
| Target/actor identity and separate actor accounts | Same `secret://lab/TARGET/ACTOR` reference and `_lab_TARGET--ACTOR` file; roles within a lab remain separate actors. |
| Synthetic, temporary and account bundles | Preserved; temporary entries require an expiry, expired entries cannot be handed off. |
| Enrollment, refresh and reference listing | `lab enroll`, `lab refresh`, `lab refs`; private input, metadata-only replies. |
| Required and optional field selection | Preserved in `lab run`; duplicated actors/fields, missing required fields and cross-target selections fail before handoff. |
| Descriptor handoff | Same wire document and `AGENT_HUB_LAB_CREDENTIAL_FD`; absolute child, restricted environment, no child output. |
| Owner account list/add/replace/edit/remove | Lab section on Logins; write-only fields, partial edits, confirmed remove, retained account fields and site/password rule. |
| Revocation accounts | Distinct named actor rows, without a separate revocation mechanism. Existing files stay indexed; six expired Agent Hub rows were skipped by the live migration. |
| Checkout or lease to a hunt | No such capability exists in the inspected Agent Hub implementation. Aico uses coordinator-assigned session targets. |
| Rotation | Refresh replaces the saved bundle; it does not change an account on a target system. |
| Audit | Agent Hub had route logs, no dedicated credential audit table. Aico records set, rotate, use, reveal, grants, assignment and remove without values. |

Provider/tool migration used Agent Hub's existing configured database/decryptor. It wrote values directly to private store files, kept source rows, and emitted only the names/counts report in `migration.json`. Two Gemini rows are retained under distinct names. The two app service entries are verifiers only, as the coordinator directed; their raw tokens remain in the owning apps. The release-signing key remains local and outside Logins.
