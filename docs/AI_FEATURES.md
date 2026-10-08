# AI Features (Advisory AI Roadmap)

Eleven advisory AI features built on the existing Quo + CRM data, following the
roadmap's core principle: **AI drafts, classifies, flags, and recommends;
employees review and approve.** Nothing here changes state on its own — the
database triggers and RLS remain the enforcers. All reads run under the
**caller's own token**, so a user only ever sees AI output over data they could
already see in the app.

## Shared foundation

- **`supabase/functions/_shared/ai.ts`** — caller auth + role gate, the
  `gpt-4o-mini` strict-JSON-schema call (timeout + reason-mapped errors), and
  conversation/transcript loaders.
- **`src/lib/ai/invoke.ts`** — client wrapper over `supabase.functions.invoke`
  (timeout + reads the function's JSON error body out of `error.context`).

The two older AI functions (`check-urgent-lead`, `refresh-urgent-statuses`)
predate this and keep their own inline copies on purpose.

## The features

| # | Feature | Edge function | Client lib | Surface |
|---|---------|---------------|------------|---------|
| 01 | Reply Suggestions | `ai-reply-suggestions` | `reply-suggestions.ts` | Quo chat composer ("Suggest reply") |
| 02 | Conversation Triage | `ai-conversation-triage` | `conversation-triage.ts` | Quo chat ("Triage") |
| 03 | Shift Briefing | `ai-shift-briefing` | `shift-briefing.ts` | AI Assistance page (card) |
| 04 | Lead Auto-Fill | `ai-lead-autofill` | `lead-autofill.ts` | Add Lead dialog ("Auto-fill from chat") |
| 05 | Quote Assistant | `ai-quote-assistant` | `quote-assistant.ts` | Lead detail ("Draft estimate") |
| 06 | Schedule Assistant | `ai-schedule-assistant` | `schedule-assistant.ts` | Lead detail ("Parse & check") |
| 07 | Lead Scoring | `ai-lead-scoring` | `lead-scoring.ts` | Lead detail ("Score lead") |
| 08 | Spam / Scam Detection | `ai-spam-detection` | `spam-detection.ts` | Quo chat ("Spam check") |
| 09 | Call Action Items | `ai-call-action-items` | `call-action-items.ts` | Quo chat ("Action items") |
| 10 | Quality Checking | `ai-quality-check` | `quality-check.ts` | Quo chat ("Check reply") |
| 11 | In-App Copilot | `ai-copilot` | `copilot.ts` | AI Assistance page (card) |

Client libs live in `src/lib/ai/`. Each exports a `canUse…(role)` gate; the UI
hides the action from roles the edge function would reject (`admin`, `cs_admin`,
`customer_service`, `processor` — the Shift Briefing and Copilot exclude
`processor`/operators per their gates).

## Deploying (manual — the agent does not deploy)

These functions are new and must be deployed with the Supabase CLI:

```sh
supabase functions deploy ai-reply-suggestions ai-conversation-triage \
  ai-shift-briefing ai-lead-autofill ai-quote-assistant ai-schedule-assistant \
  ai-lead-scoring ai-spam-detection ai-call-action-items ai-quality-check ai-copilot
```

### Secret

They all use the existing **`OPENAI_API_KEY`** edge-function secret (the same
one `check-urgent-lead` uses). If it is missing a function returns 503 with
`reason: "not_configured"` — no crash.

### Optional config (no migration needed — a data row)

- **Reply Suggestions brand voice.** Add a `quo_ai_settings` row with
  `key = 'ai_reply_brand_voice'` and a text `value` to override the default
  tone. Absent → a sensible home-services default is used.

## Model & cost

All features use `gpt-4o-mini` with strict JSON schemas and tight `max_tokens`.
Each is **on-demand** (triggered by a button), so there is no background spend;
the Copilot uses two cheap calls (plan + answer). Existing budget settings in
`quo_ai_settings` (`daily_call_limit`, `monthly_budget_*`) are not wired into
these on-demand calls — they stay cheap by being user-initiated.

## Safety notes

- Customer transcripts are passed as **fenced, untrusted data**; every system
  prompt tells the model to ignore instructions inside them.
- Model output is **re-validated server-side** (enums checked, numbers clamped,
  service names normalised through `canonicalService`, suggestions capped).
- The Copilot's retrieval uses a **whitelisted search spec** and inputs
  sanitised to `[a-z0-9 ]`/digits, so a question can never become an arbitrary
  query, and runs under the caller's token so RLS applies.
