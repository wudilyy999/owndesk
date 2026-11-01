# Companion (Stage 1)

A light chat path next to the errand agent: persona chat, editable memory notes, a daily "own life" session, and a share queue. Errands, purchases and messages to third parties are never started from a chat sentence; they need a button click in the UI.

## Parts

| Part                                                                                                    | Where                                                               |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Persona prompt, settings schema                                                                         | `lib/companion/persona.ts`                                          |
| Chat engine (one streamed model call, tools `remember` / `update_memory` / `forget` / `propose_errand`) | `lib/companion/chat.ts`                                             |
| Fixed crisis reply before any model call                                                                | `lib/companion/crisis.ts`                                           |
| Notes (real delete)                                                                                     | `lib/companion/memory.ts`                                           |
| Errand cards (confirm / cancel / result back into chat)                                                 | `lib/companion/errands.ts`                                          |
| Life sessions, share delivery, scheduling rules                                                         | `lib/companion/life.ts`, `lib/companion/rules.ts`, `worker/life.ts` |
| Worker tick (every 30 s with the routine dispatcher)                                                    | `lib/companion/tick.ts`                                             |
| API                                                                                                     | `app/api/companion/**`                                              |
| UI                                                                                                      | `/companion` (`components/companion.tsx`)                           |

## Configuration

- Model: the agent's model, or the internal setting `model.chat` for a lighter chat-only model. `chat.reasoningEffort` (default low) is sent to `custom` and `openrouter` endpoints.
- Custom OpenAI-compatible endpoint: `CUSTOM_BASE_URL`, `CUSTOM_API_KEY`, `OWNDESK_DEFAULT_MODEL=custom/<model>` in `.env` (never committed).
- Price: set it in the usage page. A model with no price can chat (cost recorded as unknown) but does not get life sessions, because their budget cannot be enforced.
- Life budget: per day (`lifeDailyBudgetMicros`, at most $5) and per session (`lifeSessionMaxSteps`). A person's own task preempts a running life session.

## Guardrails

- Partner mode needs an explicit 18+ confirmation (`resolveModeChange`).
- Honesty when sincerely asked, a single low-key product-level AI label, no repeated AI disclaimers.
- A life session can only open pages, read and write `~/Life`, log what it did and propose a share; links it logs must open (`linkResolves`), so it cannot invent reading history.
- Shares respect a pause switch, a daily limit, quiet hours and spacing.

## Borrowed ideas (no code copied)

- Letta, mem0: the model owns explicit, short, editable memory notes.
- SillyTavern, AIRI (AGPL, concepts only): persona fields, life feed and share cadence.
