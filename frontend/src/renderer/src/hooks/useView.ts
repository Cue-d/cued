import { useContext } from 'react'
import { ViewContext } from '@/contexts/ViewContext'

export function useView() {
  const context = useContext(ViewContext)
  if (context === undefined) {
    throw new Error('useView must be used within a ViewProvider')
  }
  return context
}
