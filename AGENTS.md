# Mandatory CRM / Donut parity rule

For every feature change or bug fix, inspect whether the feature also exists in
Donut (`tmp_extension/quo-crm-extension/`). If it does, update and verify BOTH
interfaces in the same task. CRM-only fixes are not complete for shared features.
Use the same authenticated Edge Function/RPC for both clients; do not duplicate
AI prompts, bypass status/approval rules, or embed server secrets in Donut.

Verify UI, permission helpers, database RLS, Edge Functions, and generated types
from click through storage. Maintain `docs/CRM_EXTENSION_PARITY.md` when a shared
flow changes. Add behavioral regression coverage for the actual defect on both
surfaces where applicable. A changed Edge Function must be deployed or explicitly
reported as awaiting deployment; a merged frontend is not a backend deployment.

For EVERY extension source change, run `npm run extension:release -- <higher-version>
"Release notes"`, commit the generated manifest, release metadata and ZIP, and run
`npm run extension:check`. Do not claim an extension update is shipped until the
CRM is published and the user has installed/reloaded the manual ZIP.

Read `README.md` and `GEMINI.md` for architecture and house rules. Migrations are
manual: write idempotent SQL with a defect header and rollback section, notify the
user to apply it, and never run db push/reset against the shared project. Do not
hand-edit generated Supabase types. Preserve unrelated user changes.
