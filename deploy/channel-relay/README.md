# Channel relay

Zero-dependency egress forwarder for a fixed-IP server. See `docs/channels.md` ("固定出口 IP").

```bash
RELAY_KEY=$(openssl rand -hex 24) docker compose up -d --build
```

- `RELAY_KEY` (required, 16+ chars) — sent by owndesk as `x-relay-key`.
- `RELAY_HOSTS` — comma-separated hosts it may forward to (default: QQ and WeChat API hosts).
- `APP_UPSTREAM` — optional; also passes `/api/channels/qq` and `/api/channels/wechat-oa` to owndesk.

Put HTTPS in front of it. Tests: `tests/channel-relay.test.ts`.
