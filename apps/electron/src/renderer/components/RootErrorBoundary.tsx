import { Component, type ErrorInfo, type ReactNode } from "react"

interface RootErrorBoundaryProps {
  children: ReactNode
}

interface RootErrorBoundaryState {
  error: Error | null
}

export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[RootErrorBoundary] Renderer crashed", {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    })
  }

  private reload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children
    }

    const showDetails = import.meta.env.DEV
    const errorDetails = this.state.error.stack ?? this.state.error.message

    return (
      <div className="min-h-screen flex items-center justify-center p-8" style={{ backgroundColor: "#151515" }}>
        <div className="w-full max-w-2xl p-6 rounded-lg border border-white/10" style={{ backgroundColor: "#1f1f1f" }}>
          <h2 className="text-lg font-semibold mb-2 text-white">Renderer crashed</h2>
          <p className="text-sm text-white/70 mb-4">
            The app hit an unexpected error. You can reload now. Logs were written to the main process output.
          </p>
          {showDetails && (
            <pre className="text-xs text-white/70 bg-black/40 rounded p-3 overflow-auto max-h-56 mb-4 whitespace-pre-wrap">
              {errorDetails}
            </pre>
          )}
          <button
            type="button"
            onClick={this.reload}
            className="px-3 py-2 rounded text-sm font-medium bg-white text-black hover:bg-white/90"
          >
            Reload app
          </button>
        </div>
      </div>
    )
  }
}
