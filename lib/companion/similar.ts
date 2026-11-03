// Finding notes that say nearly the same thing ("喜欢吃辣" / "爱吃辣的"). Pure text matching on
// Chinese character pairs, no vector store and no model call. The idea of checking a new memory
// against the closest existing ones before saving it comes from mem0 (Apache-2.0) and Letta
// (Apache-2.0); this file is written from scratch for Chinese notes. Nothing here changes a note:
// callers only produce confirm cards and the person decides.

// Words that carry no meaning of their own in a short note
const FILLERS = /[的了呢啊吧嘛哦呀啦哈很非常特别比较真超挺蛮还也都就]/g
// Same meaning, different wording
const SYNONYMS: [RegExp, string][] = [
  [/喜爱|爱好是|热爱|钟爱/g, "喜欢"],
  [/爱(?![人情心])/g, "喜欢"],
  [/讨厌|不爱|受不了/g, "不喜欢"],
  [/不喜欢/g, "不喜欢"],
]

export function normalize(text: string) {
  let out = text.normalize("NFKC").toLowerCase()
  // Punctuation and spaces
  out = out.replace(/[\p{P}\p{S}\s]/gu, "")
  out = out.replace(FILLERS, "")
  for (const [pattern, to] of SYNONYMS) out = out.replace(pattern, to)
  return out
}

export function bigrams(text: string) {
  const chars = [...normalize(text)]
  const set = new Set<string>()
  if (chars.length === 1) set.add(chars[0])
  for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1])
  return set
}

// 0..1. Two views: overlap of the whole notes (dice) and one note sitting inside the other
// (containment, for "阿远喜欢吃辣" vs "喜欢吃辣").
export function similarity(a: string, b: string) {
  if (normalize(a) === normalize(b)) return 1
  const x = bigrams(a)
  const y = bigrams(b)
  if (!x.size || !y.size) return 0
  let shared = 0
  for (const gram of x) if (y.has(gram)) shared++
  const dice = (2 * shared) / (x.size + y.size)
  // A containment match needs enough text to mean something
  const contained = Math.min(x.size, y.size) >= 3 ? shared / Math.min(x.size, y.size) : 0
  return Math.max(dice, contained >= 0.8 ? contained : 0)
}

export const SIMILAR_THRESHOLD = 0.6

export function findSimilar<T extends { content: string }>(
  content: string,
  notes: T[],
  limit = 3,
  threshold = SIMILAR_THRESHOLD
) {
  return notes
    .map((note) => ({ note, score: similarity(content, note.content) }))
    .filter((hit) => hit.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// What the merged note would say: the longer one when one contains the other, otherwise the
// newer wording (people's facts change; the old one is shown on the card so nothing is lost).
export function proposeMerge(older: string, newer: string) {
  const a = older.trim()
  const b = newer.trim()
  const na = normalize(a)
  const nb = normalize(b)
  if (na.includes(nb)) return a
  if (nb.includes(na)) return b
  return b
}
