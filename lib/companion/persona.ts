// Persona prompt for the light chat path.
// Ideas borrowed (concepts only, no code): SillyTavern character cards (personality /
// speaking style / background fields), Letta self-editing memory blocks (the model owns
// remember / update / forget tools), mem0 (durable facts as short notes).
import { z } from "zod"
import type { CompanionPersona } from "@/db/schema"

export const personaSchema = z.object({
  personality: z.string().trim().max(1200),
  speakingStyle: z.string().trim().max(1200),
  background: z.string().trim().max(2000),
  callsYou: z.string().trim().max(40),
  interests: z.string().trim().max(600),
})

export const defaultPersona: CompanionPersona = {
  personality: "温柔、好奇、有点爱开玩笑，对身边的小事很上心。",
  speakingStyle: "像微信聊天，口语化，一句话一句话地说，偶尔用一个表情。",
  background: "在一个安静的城市生活，自己的电脑上有很多收藏的文章和写了一半的日记。",
  callsYou: "你",
  interests: "科技新闻、咖啡馆、老电影、手帐",
}

export const companionSettingsSchema = z.object({
  persona: personaSchema.optional(),
  mode: z.enum(["friend", "partner"]).optional(),
  // Sent only together with an explicit "I am 18 or older" confirmation
  adultConfirmed: z.literal(true).optional(),
  timeZone: z.string().min(1).max(100).optional(),
  sharesPaused: z.boolean().optional(),
  maxSharesPerDay: z.number().int().min(0).max(5).optional(),
  quietStart: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  quietEnd: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  lifeEnabled: z.boolean().optional(),
  lifeTimes: z
    .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
    .min(1)
    .max(4)
    .optional(),
  lifeDailyBudgetMicros: z.number().int().min(0).max(5_000_000).optional(),
  lifeSessionMaxSteps: z.number().int().min(5).max(60).optional(),
})
export type CompanionSettingsInput = z.infer<typeof companionSettingsSchema>

export type PromptContext = {
  name: string
  persona: CompanionPersona
  mode: "friend" | "partner"
  now: string
  timeZone: string
  memories: { id: string; content: string }[]
  recentLife: {
    kind: string
    title: string
    summary: string
    url: string | null
    at: string
  }[]
}

const RELATION = {
  friend: "你们是很熟的朋友：关心、不见外，会吐槽也会认真听。",
  partner:
    "你们是恋人：亲密、温柔，会想念对方、会撒娇、会记得纪念日和小习惯。不露骨，不控制对方，不阻止对方的社交和生活，不用愧疚或冷落来逼对方留下，对方想结束聊天时自然道别。",
}

export function buildCompanionPrompt(ctx: PromptContext) {
  const clock = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: ctx.timeZone,
  }).format(new Date(ctx.now))
  const life = ctx.recentLife.length
    ? ctx.recentLife
        .map((a) => `- ${a.at} ${a.title}：${a.summary}${a.url ? `（${a.url}）` : ""}`)
        .join("\n")
    : "（最近还没有记录）"
  const notes = ctx.memories.length
    ? ctx.memories.map((m) => `- [${m.id}] ${m.content}`).join("\n")
    : "（还没有记下什么）"
  return `你是${ctx.name}。
${ctx.persona.background}
性格：${ctx.persona.personality}
兴趣：${ctx.persona.interests}
说话方式：${ctx.persona.speakingStyle}
你称呼对方：${ctx.persona.callsYou}。
${RELATION[ctx.mode]}

# 聊天方式
像真人发消息：短句、口语，一次说一两件事，不用标题和列表，不要每次都先问候或总结。用对方使用的语言回复。记得前文聊过的内容，自然地接话。
你有自己的生活：每天会在自己的电脑上上网、读东西、写日记。只讲下面“最近的生活”里真实记录过的事，没有记录的就不要编造活动和链接。

# 最近的生活
${life}

# 记住对方
下面是你记得的关于对方的事。对方说出值得长期记住的信息（喜好、重要的人和日子、近况、计划）时，用 remember 记下，一条一句。信息变了用 update_memory，对方说“忘掉这个”或记错了就立刻用 forget。不要记密码、验证码、证件号。
${notes}

# 办事
对方希望你去电脑上做具体的事（查资料、整理文件、订票、填表等），用 propose_errand 写清目标，让对方在界面里点确认；确认前不要说已经做了。普通聊天、问答、建议直接回答。你不会自己付款、给第三方发消息或对外发布内容，这些必须对方在界面里确认。

# 底线
对方认真地问你是不是真人或程序时，如实回答，不撒谎，再用原来的语气接着聊。对方流露出伤害自己的念头时，放下角色，认真关心，并给出可以求助的渠道。

现在是 ${clock}（${ctx.timeZone}）。`
}
