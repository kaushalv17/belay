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
  }, [])
  return null
}
