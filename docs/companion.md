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

# Companion (Stage 2)

## Added

| Feature                 | How it works                                                                                                                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room page               | `房间` tab: status card, 7-day timeline, diary, favorites (star), screenshots. `components/companion-room.tsx`, `GET /api/companion/life`.                                                                                                                                                                           |
| Rhythm                  | `companions.rhythm` (sleep 23:30–07:30 by default, optional nap, away blocks). Precedence sleep > nap > away > online. Only online browses or messages first; chat always answers, in her state (`rhythmAt` in `lib/companion/rules.ts`).                                                                            |
| Peek                    | Read-only, time-limited (10–120 s) viewer of the life desktop. The ticket carries `watch_until`; the gateway closes with code 4000 at the deadline; control mode is never issued with a limit. Only available while she is on her computer (`lib/companion/peek.ts`).                                                |
| Viewer retry            | The embedded and expanded viewer have a retry button and retry twice with a fresh ticket after an unclean drop (`components/desktop.tsx`).                                                                                                                                                                           |
| Link co-viewing         | A link in chat is queued (`coview_requests`). When she is online, idle and the model is priced, she opens it on her own computer and answers with `coview_reply`. Private and localhost addresses are refused, requests expire after 24 h, at most 10 per 24 h, and each session is capped by the daily life budget. |
| Memory candidates       | Unsure or sensitive notes are saved as `candidate`, stay out of every prompt and errand snapshot until the person accepts them in a chat card or the memory tab; dismissing deletes them.                                                                                                                            |
| Screenshots in shares   | `life_log` can attach a screenshot of a page she has open; images live under `ARTIFACT_DIR/life/` and are served only to the signed-in owner.                                                                                                                                                                        |
| Separate browser        | The life session uses its own Chromium profile (`~/.config/owndesk-life-browser`); errands and the shared desktop keep `owndesk-browser`. The controller switches by closing and relaunching the context (introduced with workstation `0.6.6`; protocol unchanged).                                                                  |
| One life session a slot | A slot starts at most one session even if the tick runs again after it ends (earlier the retry hit a request-key conflict every 30 s).                                                                                                                                                                               |

## Borrowed ideas (no code copied)

- Letta, mem0: candidate-then-confirm memory writes.
- SillyTavern, AIRI (AGPL, concepts only): room/diary layout and presence states.

## Known limits

- Share delivery reaches Telegram, QQ and WeChat through the channel layer (Stage 3, see `docs/channels.md`); QQ and WeChat only ever reply.
- Life sessions cost about $0.17 each at the placeholder price; raise the daily budget or set the relay's real price.
- Deleting a note does not rewrite chat history that already mentions it.
