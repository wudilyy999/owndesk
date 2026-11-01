// All outgoing channel calls go through here. Some platforms (QQ bot, WeChat official
// account) only accept calls from whitelisted IPs; when a relay is configured, calls to
// those hosts are sent through a small forwarder on a machine with a fixed IP
// (deploy/channel-relay). Everything else is called directly.
import { getSetting } from "@/lib/config"

export const RELAYED_HOSTS = new Set([
  "api.bot.qq.com",
  "bots.qq.com",
  "sandbox.api.sgroup.qq.com",
  "api.weixin.qq.com",
])

export async function relayTarget(url: string) {
  const target = new URL(url)
  const relay = await getSetting("channel.relayUrl")
  if (!relay || !RELAYED_HOSTS.has(target.host))
    return { url, headers: {} as Record<string, string> }
  const key = await getSetting("channel.relayKey")
  return {
    url: `${relay.replace(/\/+$/, "")}/forward/${target.host}${target.pathname}${target.search}`,
    headers: (key ? { "x-relay-key": key } : {}) as Record<string, string>,
  }
}

export async function egressFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000
) {
  const target = await relayTarget(url)
  return fetch(target.url, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...target.headers },
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  })
}
