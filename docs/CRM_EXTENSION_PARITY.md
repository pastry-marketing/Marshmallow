# CRM / Donut parity contract

Every shared fix must update both clients, use the same authenticated backend,
and include behavior tests. `AGENTS.md` and `GEMINI.md` make this mandatory.

| Flow | CRM | Donut | Shared authority / verification |
| --- | --- | --- | --- |
| Technician intelligence | Technicians → Processing Workflow; map selection up to 8 | Native Technician Intelligence panel for the captured phone, reviewed-label saving, full-workflow link for batch selection/flag approvals/chat actions | `technician-chat-assessment`: Admin/Processor only; identical AI prompt, evidence checks, counts and labels. Missing history is unavailable, not misconduct. |
| Technician flags | Admin applies; Processor requests review | Opens full workflow for the same reviewed actions | Existing `request_technician_change` approval RPC and technician flag trigger; never write flags directly in Donut. |
| Urgent lead review | Latest customer agreement, corrections and missing details | Same check; displays issues, corrections and flags; opens saved-lead review for confirmed corrections/approval | `check-urgent-lead`, urgent verification/review RPCs and database status gate. No duplicate prompt or approval bypass. |
| Address lookup | Authenticated lookup, labelled provider and preserved units | Same function for Find Address, coverage preview and submission coordinates | `geocode-lead-address`: Google only when configured, free Census fallback. Preserve Apt/Suite/Unit/#. |
| Lead submission | Saves stored record before AI follow-up; mutation errors distinguished from follow-up errors | In-flight guard, reserved job ID through acknowledgement, uncertain retries reuse ID; draft cleanup does not redefine a saved lead as failed | Existing unique lead job ID and RLS. Selected photo-upload failures are reported explicitly. |
| Coverage | Admin coverage/source analytics; map and lead coverage badges | Intake coverage preview; Admin link to the full coverage analytics report | Existing coverage RPC/lead columns/trigger. Technician phone and status counts use actual stored data. |
| Photos | Single combined-image copy; original-file technician handoff | Original file attachment handoff to exact technician chat | Authenticated signed storage URLs; user's Quo Send action completes delivery. |
| Release updates | Latest/installed version, date/time, automatic notice and ZIP instructions | Installed version/date, update notice in panel/settings | `extension-release.json`, bundled `release.json`, manifest and version-correlated bridge. |

## Release verification checklist

1. Test each changed flow on both surfaces and an excluded role.
2. Run Vitest, changed-file lint, app typecheck and the production build.
3. Verify backend source against deployed versions, and deploy changed functions.
4. If a schema migration is required, write idempotent SQL with rollback and ask
   the user to apply it manually; never push/reset the shared database.
5. Run `npm run extension:release -- <higher-version> "Release notes"`, commit
   generated metadata/manifest/ZIP, then run `npm run extension:check`.
6. State what still needs API credentials, live QA, CRM Publish, or manual ZIP reload.
   A test/build/HTTP 200 is not proof that every reported business task works.

## Quo configuration

Open [Marshmallow Edge Function Secrets](https://supabase.com/dashboard/project/kxiqholnmhkwhdkhtopp/functions/secrets).
Add `QUO_API_KEY` with the **raw Quo API key**. Do not prefix it with `Bearer`:
the [Quo API](https://www.quo.com/docs/api-reference/messages/list-messages) uses
the key directly in its server-side Authorization header. Optionally set
`QUO_API_BASE_URL` to `https://api.quo.com/v1` for all Quo sync functions.

`OPENAI_API_KEY` enables AI review. `QUO_WEBHOOK_SECRET` is a separate webhook
signature secret; do not replace it with the Quo API key. Never put these keys in
CRM frontend environment variables, extension Settings or the ZIP. Quo and AI
requests run in authenticated Edge Functions.

Secrets become available without redeploying. Retry a technician with a valid
saved Quo link, then check the returned source, message count and quoted evidence.
If history is still missing, confirm the key can access the saved phone line and
sync the conversation from the CRM. The native Donut panel uses the same endpoint.

## Free address lookup

Google Maps' public website is not a Geocoding API credential. This project keeps
US Census geocoding as its no-key/free fallback. If Google Geocoding is wanted,
configure `GOOGLE_MAPS_API_KEY` (or `GOOGLE_GEOCODING_API_KEY`) server-side with the
Geocoding API enabled; Google's API billing/free allowance is separate from Maps
website use. Both clients display the actual provider, never claim a Census result
was Google-verified, and preserve secondary unit details.
