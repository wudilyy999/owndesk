import type { MetadataRoute } from "next"

// Installable web app: "添加到主屏幕" opens the companion chat full screen.
// Icons are drawn by scripts/generate-pwa-icons.mjs.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/companion",
    name: "OwnDesk",
    short_name: "OwnDesk",
    description: "你的 AI 陪伴：聊天、她自己的生活和记忆",
    lang: "zh-CN",
    start_url: "/companion",
    scope: "/",
    display: "standalone",
    background_color: "#f8f5ee",
    theme_color: "#1e1915",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "聊天",
        url: "/companion",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  }
}
