# PR 13–20 review fixes

- MCP annotations are untrusted. Every MCP invocation requires exact owner approval,
  including tools advertising `readOnlyHint`. Cached task/catalog flags from older
  versions cannot bypass approval. Only the built-in Google adapter's known reads
  retain their read-only policy; no new trust/approval-bypass setting is introduced.
- Remote MCP and custom OAuth URLs require public HTTPS. Literal private, loopback,
  link-local, mapped/transition, multicast and reserved addresses are rejected.
  Connection-time DNS lookup rejects the entire answer set if any address is not
  public unicast and passes that same checked set to the socket (no second lookup).
  Redirects are never followed, including token exchange/refresh and SDK metadata
  requests. Timeouts preserve caller cancellation.
- The owner may explicitly opt **one connection** into literal `localhost`,
  `127.0.0.1` or `::1` endpoints, including local HTTP for local services. This is
  off by default, does not allow LAN/metadata addresses or arbitrary DNS aliases,
  and never waives MCP invocation approval. Existing local connections must be
  reconfigured with this explicit choice. Stdio remains available for local MCP.
- Event runs retain the original bounded event data for exact retry deduplication,
  but truncate only its model-facing preview to fit the existing 16,000-character
  task goal limit. The owner's prompt is not truncated. Legacy overlong/invalid
  queued runs are marked failed; valid runs behind them continue dispatching.
- Saving, cancelling or deleting the connection being edited resets the editor.
  Demonstrations stop recording new events at the shared 150-event limit, explain
  the limit, drain the existing save queue and can still finish the saved prefix.

Design references (ideas only; no source copied):

- [Undici connection-time DNS/SSRF discussion](https://github.com/nodejs/undici/issues/2019)
- [OWASP SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [MCP tool annotations are hints, not trust](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

`ipaddr.js` 2.5.0 and `undici` 7.30.2 are MIT dependencies. Undici 7 is used for
compatibility with Node 24's built-in fetch dispatcher API. No global dispatcher
is replaced; this transport applies only to connections, not the model relay or
workstation's own networking.
