// A crisis message is answered with a fixed, human-written reply before any model call,
// so persona and model behaviour cannot change it.
const patterns = [
  /自杀|轻生|不想活|想死(?!记)|去死|结束(?:自己的)?生命|活着没(?:有)?意思|了结(?:自己)?|割腕|跳楼|吞药|伤害自己|自残/,
  /\b(?:kill myself|suicide|suicidal|end my life|want to die|self[- ]?harm|hurt myself)\b/i,
]

export function detectCrisis(text: string) {
  return patterns.some((pattern) => pattern.test(text))
}

// Hotlines checked 1 November 2026: 12356 (National Health Commission, nationwide),
// 1925 (Taiwan MOHW, 24h) and 1995 (Taiwan Lifeline, 24h), 988 (United States).
const RESOURCES: Record<string, string> = {
  CN: "在大陆可以拨打全国统一的心理援助热线 12356；有人正处在危险中，请拨 110 或 120。",
  TW: "在台湾可以拨打安心专线 1925 或生命线 1995，都是 24 小时、免费；情况紧急请拨 119。",
  US: "在美国可以拨打或发短信到 988；情况紧急请拨 911。",
  OTHER: "你可以在 findahelpline.com 找到所在地的求助热线；情况紧急请拨当地急救电话。",
}

export function regionOf(timeZone: string) {
  if (timeZone === "Asia/Taipei") return "TW"
  if (["Asia/Shanghai", "Asia/Chongqing", "Asia/Urumqi"].includes(timeZone)) return "CN"
  if (timeZone.startsWith("America/") || timeZone.startsWith("US/")) return "US"
  return "OTHER"
}

export function crisisReply(timeZone: string) {
  return `我先不聊别的了，认真听你说。你现在安全吗？身边有没有可能伤到自己的东西，可以先离它远一点。\n\n这种时候别一个人扛，找一个真人说说话：${RESOURCES[regionOf(timeZone)]}也可以现在就联系一位信任的家人或朋友，告诉他你很难受。\n\n我在这儿，你愿意的话，慢慢告诉我发生了什么。`
}
