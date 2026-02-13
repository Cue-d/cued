import { useState, useCallback, useEffect } from "react"
import type { PermissionStatus } from "../../shared/electron-api"
import { useElectron } from "./use-electron"

export function usePermissions() {
  const electron = useElectron()
  const [permissions, setPermissions] = useState<PermissionStatus | null>(null)
  const [isChecking, setIsChecking] = useState(true)

  const check = useCallback(async () => {
    setIsChecking(true)
    try {
      const status = await electron.permissions.check()
      setPermissions(status)
    } catch (error) {
      console.error("Failed to check permissions:", error)
    } finally {
      setIsChecking(false)
    }
  }, [electron])

  // Check on mount
  useEffect(() => {
    check()
  }, [check])

  // Re-check when window regains focus
  useEffect(() => {
    const handleFocus = () => { check() }
    window.addEventListener("focus", handleFocus)
    return () => window.removeEventListener("focus", handleFocus)
  }, [check])

  return { permissions, isChecking, recheck: check }
}
