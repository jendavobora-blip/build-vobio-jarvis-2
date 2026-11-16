"use client"

import { useCallback, useEffect, useReducer, useRef } from "react"
import { initialRunState, runReducer } from "@/lib/jarvis/run-state"
import { buildDemoTimeline } from "@/lib/jarvis/demo-script"
import type { ChatRequestBody, RunEvent, Usage } from "@/lib/jarvis/types"

interface Callbacks {
  onLiveComplete?: (info: { prompt: string; answer: string; usage: Usage }) => void
}

export function useJarvisRun({ onLiveComplete }: Callbacks = {}) {
  const [state, dispatch] = useReducer(runReducer, initialRunState)
  const abortRef = useRef<AbortController | null>(null)
  const timersRef = useRef<number[]>([])
  const loopRef = useRef(false)
  const completeRef = useRef(onLiveComplete)
  completeRef.current = onLiveComplete

  const clearTimers = () => {
    timersRef.current.forEach((t) => window.clearTimeout(t))
    timersRef.current = []
  }

  const cancel = useCallback(() => {
    loopRef.current = false
    clearTimers()
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    dispatch({ type: "cancelled" })
  }, [])

  const reset = useCallback(() => {
    loopRef.current = false
    clearTimers()
    abortRef.current?.abort()
    abortRef.current = null
    dispatch({ type: "reset" })
  }, [])

  const playDemo = useCallback((prompt: string) => {
    clearTimers()
    dispatch({ type: "start", source: "demo", prompt })
    const timeline = buildDemoTimeline()
    for (const step of timeline) {
      timersRef.current.push(
        window.setTimeout(() => dispatch({ type: "event", event: { ...step.event, at: Date.now() } as RunEvent }), step.delay),
      )
    }
    const total = timeline[timeline.length - 1]?.delay ?? 0
    timersRef.current.push(
      window.setTimeout(() => {
        if (loopRef.current) playDemo(prompt)
      }, total + 3500),
    )
  }, [])

  const startDemo = useCallback(
    (prompt: string, loop: boolean) => {
      abortRef.current?.abort()
      abortRef.current = null
      loopRef.current = loop
      playDemo(prompt || "Ukázková vizualizace týmu agentů")
    },
    [playDemo],
  )

  const startLive = useCallback(async (body: ChatRequestBody) => {
    loopRef.current = false
    clearTimers()
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    dispatch({ type: "start", source: "live", prompt: body.message })

    let response: Response
    try {
      response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch {
      if (!controller.signal.aborted) dispatch({ type: "fail", message: "Server není dostupný. Zkontrolujte připojení." })
      return
    }

    if (!response.ok || !response.body) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null
      dispatch({ type: "fail", message: data?.error ?? `Požadavek selhal (${response.status}).` })
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let finalAnswer = ""
    let usage: Usage | null = null
    let sawDone = false
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const line = chunk.split("\n").find((l) => l.startsWith("data: "))
          if (!line) continue
          try {
            const event = JSON.parse(line.slice(6)) as RunEvent
            if (event.type === "final") finalAnswer = event.result.answer
            if (event.type === "usage") usage = event.total
            if (event.type === "done") sawDone = true
            dispatch({ type: "event", event })
          } catch {
            // Ignore a malformed frame rather than abort the whole run.
          }
        }
      }
    } catch {
      if (controller.signal.aborted) return
      dispatch({ type: "fail", message: "Spojení se serverem bylo přerušeno." })
      return
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
    if (!sawDone) dispatch({ type: "fail", message: "Stream skončil předčasně." })
    if (usage || finalAnswer) {
      completeRef.current?.({
        prompt: body.message,
        answer: finalAnswer,
        usage: usage ?? { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 },
      })
    }
  }, [])

  useEffect(
    () => () => {
      clearTimers()
      abortRef.current?.abort()
    },
    [],
  )

  return { state, startLive, startDemo, cancel, reset }
}
