import { Component, type ErrorInfo, type ReactNode } from "react"
import { Button } from "@cued/ui"

interface PageErrorBoundaryProps {
  children: ReactNode
  resetKey?: string
}

interface PageErrorBoundaryState {
  error: Error | null
}

export class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  state: PageErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): PageErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[PageErrorBoundary] Page render failed", {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    })
  }

  componentDidUpdate(prevProps: PageErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  private retry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children
    }

    const showDetails = import.meta.env.DEV

    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="w-full max-w-xl rounded-lg border border-white/10 bg-card p-5">
          <h2 className="text-base font-semibold mb-2">Couldn&apos;t load this page</h2>
          <p className="text-sm text-muted-foreground mb-4">
            A temporary data error occurred. You can retry without restarting the app.
          </p>
          {showDetails && (
            <pre className="text-xs text-white/70 bg-black/40 rounded p-3 overflow-auto max-h-56 mb-4 whitespace-pre-wrap">
              {this.state.error.stack ?? this.state.error.message}
            </pre>
          )}
          <div className="flex gap-2">
            <Button type="button" onClick={this.retry}>
              Retry
            </Button>
            <Button type="button" variant="secondary" onClick={() => window.location.reload()}>
              Reload app
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
