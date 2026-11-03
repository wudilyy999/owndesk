"use client"
import { useEffect } from "react"

// Registers the service worker that makes the app installable (public/sw.js)
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
      console.error("service worker registration failed", error)
    })
  }, [])
  return null
}
