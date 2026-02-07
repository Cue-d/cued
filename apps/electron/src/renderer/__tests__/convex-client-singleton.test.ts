// @vitest-environment jsdom

import { StrictMode, act, createElement, useMemo } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

type MockConvexClient = {
  close: ReturnType<typeof vi.fn>
  url: string
}

const mocks = vi.hoisted(() => {
  const instances: MockConvexClient[] = []
  const ConvexReactClient = vi.fn(function (this: MockConvexClient, url: string) {
    this.url = url
    this.close = vi.fn()
    instances.push(this)
  })
  return { ConvexReactClient, instances }
})

vi.mock("convex/react", () => ({
  ConvexReactClient: mocks.ConvexReactClient,
}))

import {
  __resetConvexClientSingletonForTests,
  getOrCreateConvexClient,
} from "../lib/convex-client-singleton"

const MockConvexReactClient = mocks.ConvexReactClient
const instances = mocks.instances

function Harness({ url }: { url: string }) {
  useMemo(() => getOrCreateConvexClient(url), [url])
  return createElement("div", null, "ready")
}

function renderHarness(root: Root, url: string): void {
  act(() => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(Harness, { url })
      )
    )
  })
}

describe("convex client singleton", () => {
  beforeAll(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    __resetConvexClientSingletonForTests()
    instances.length = 0
    MockConvexReactClient.mockClear()
  })

  afterEach(() => {
    __resetConvexClientSingletonForTests()
    document.body.innerHTML = ""
  })

  afterAll(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  })

  it("reuses a single client across StrictMode unmount/remount", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)

    let root = createRoot(container)
    renderHarness(root, "https://example-a")

    expect(MockConvexReactClient).toHaveBeenCalledTimes(1)
    const firstClient = instances[0]
    expect(firstClient.close).toHaveBeenCalledTimes(0)

    act(() => {
      root.unmount()
    })

    root = createRoot(container)
    renderHarness(root, "https://example-a")

    expect(MockConvexReactClient).toHaveBeenCalledTimes(1)
    expect(firstClient.close).toHaveBeenCalledTimes(0)

    act(() => {
      root.unmount()
    })
  })

  it("closes the previous client when Convex URL changes", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)

    renderHarness(root, "https://example-a")
    const firstClient = instances[0]

    renderHarness(root, "https://example-b")

    expect(MockConvexReactClient).toHaveBeenCalledTimes(2)
    expect(firstClient.close).toHaveBeenCalledTimes(1)

    act(() => {
      root.unmount()
    })
  })
})
