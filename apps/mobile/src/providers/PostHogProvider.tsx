import React, { useEffect, useRef } from "react"
import { PostHogProvider as PHProvider, usePostHog } from "posthog-react-native"
import { useAuth } from "./AuthProvider"

const POSTHOG_KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY
const POSTHOG_HOST = process.env.EXPO_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com"

function PostHogIdentify() {
  const { user } = useAuth()
  const posthog = usePostHog()
  const identified = useRef(false)

  useEffect(() => {
    if (user && posthog && !identified.current) {
      const name = [user.first_name, user.last_name].filter(Boolean).join(" ")
      posthog.identify(user.id, {
        email: user.email,
        ...(name ? { name } : {}),
      })
      identified.current = true
    } else if (!user && identified.current) {
      posthog?.reset()
      identified.current = false
    }
  }, [user, posthog])

  return null
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  if (!POSTHOG_KEY) {
    return <>{children}</>
  }

  return (
    <PHProvider
      apiKey={POSTHOG_KEY}
      options={{
        host: POSTHOG_HOST,
        enableSessionReplay: true,
      }}
      autocapture={{
        captureTouches: true,
        captureScreens: true,
      }}
    >
      <PostHogIdentify />
      {children}
    </PHProvider>
  )
}
