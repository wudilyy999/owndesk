// Deterministic "constellation" glyphs. A seed always draws the same small
// night-sky tile: a handful of stars on a 5×5 lattice joined into a figure,
// with one bright star. Pure functions, so they render on the server.

function fnv1a(input: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Hues that read well as a night sky, light or dark UI
const HUES = [232, 214, 196, 252, 272, 292, 168, 150, 42, 58, 18, 340]

export type Star = { x: number; y: number; r: number }
export type GlyphSpec = {
  hue: number
  stars: Star[]
  edges: [number, number][]
}

const LATTICE = [6, 11, 16, 21, 26]

export function glyphSpec(seed: string): GlyphSpec {
  const random = mulberry32(fnv1a(seed || "owndesk"))
  const hue = HUES[Math.floor(random() * HUES.length)]
  const count = 4 + Math.floor(random() * 3)

  // Distinct lattice cells, jittered so figures don't look gridded
  const cells = new Set<number>()
  while (cells.size < count) cells.add(Math.floor(random() * 25))
  const stars = [...cells].map((cell) => ({
    x: LATTICE[cell % 5] + (random() - 0.5) * 2.4,
    y: LATTICE[Math.floor(cell / 5)] + (random() - 0.5) * 2.4,
    r: 0.9 + random() * 0.6,
  }))

  // Walk the stars nearest-first to make a figure that doesn't cross itself much
  const order = [0]
  const left = new Set(stars.map((_, i) => i).slice(1))
  while (left.size) {
    const last = stars[order[order.length - 1]]
    let best = -1
    let bestDistance = Infinity
    for (const i of left) {
      const d = (stars[i].x - last.x) ** 2 + (stars[i].y - last.y) ** 2
      if (d < bestDistance) {
        bestDistance = d
        best = i
      }
    }
    order.push(best)
    left.delete(best)
  }
  const edges: [number, number][] = order.slice(1).map((star, i) => [order[i], star])
  // Sometimes close a loop or branch, like real asterisms
  if (count > 4 && random() > 0.45)
    edges.push([order[0], order[2 + Math.floor(random() * (count - 2))]])

  // The brightest star
  const bright = Math.floor(random() * count)
  stars[bright].r = 2

  return { hue, stars, edges }
}
