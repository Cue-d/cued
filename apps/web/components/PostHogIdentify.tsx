"use client"

import { useEffect, useRef } from "react"
import { useAuth } from "@workos-inc/authkit-nextjs/components"
import { posthog } from "./PostHogProvider"

export function PostHogIdentify() {
  const { user } = useAuth()
  const identified = useRef(false)

  useEffect(() => {
    if (user && process.env.NEXT_PUBLIC_POSTHOG_KEY) {
      posthog.identify(user.id, {
        email: user.email,
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined,
      })
      identified.current = true
    } else if (!user && identified.current && process.env.NEXT_PUBLIC_POSTHOG_KEY) {
      posthog.reset()
      identified.current = false
    }
  }, [user])

  return null
}
