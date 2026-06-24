'use client'

import { useEffect, useRef } from 'react'
import { APP_JS } from './_data/appJs'

/**
 * Runs the original v7 landing-page IIFE once, after the server-rendered
 * markup is in the DOM. The script is a self-contained IIFE (no
 * DOMContentLoaded dependency), so injecting it post-mount reproduces the
 * exact v7 behavior: nav shadow, scroll reveals, marquee, live ledger,
 * primitive dial, canvas globe, code typing, and the waitlist form.
 */
export default function LandingScripts() {
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    const s = document.createElement('script')
    s.text = APP_JS
    document.body.appendChild(s)

    // Paddle.js (Billing): load once per mount. When the backend returns a
    // default-payment-link URL containing ?_ptxn=..., Paddle auto-detects it
    // and opens the checkout overlay. Also lets us open checkout
    // programmatically once the in-app upgrade flow is wired.
    if (!document.getElementById('paddle-js')) {
      const p = document.createElement('script')
      p.id = 'paddle-js'
      p.src = 'https://cdn.paddle.com/paddle/v2/paddle.js'
      p.async = true
      p.onload = () => {
        try {
          const Paddle = (window as any).Paddle
          if (Paddle && typeof Paddle.Initialize === 'function') {
            Paddle.Initialize({ token: 'live_2f6c5a2fc2044c85ff7a5fdc010' })
          }
        } catch (e) {
          /* no-op: checkout simply won't open if Paddle fails to load */
        }
      }
      document.head.appendChild(p)
    }
  }, [])
  return null
}
