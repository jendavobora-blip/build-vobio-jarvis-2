"use client"

import { useEffect, useRef, useState } from "react"
import type * as Three from "three"
import { AGENTS, AGENT_ORDER } from "@/lib/jarvis/agents"
import { nextGraphicsQuality, type GraphicsQuality } from "@/lib/jarvis/graphics-quality"
import type { RunState } from "@/lib/jarvis/run-state"
import type { AgentId } from "@/lib/jarvis/types"

type DisplayStatus = "loading" | "3d" | "fallback" | "reduced"

interface SpatialVisualizationProps {
  kind: "core" | "agents"
  run?: RunState
  onInspect?: (id: AgentId) => void
  onDisplayChange?: (rendering: boolean) => void
}

export function SpatialVisualization({ kind, run, onInspect, onDisplayChange }: SpatialVisualizationProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const runRef = useRef(run)
  const inspectRef = useRef(onInspect)
  const displayRef = useRef(onDisplayChange)
  runRef.current = run
  inspectRef.current = onInspect
  displayRef.current = onDisplayChange
  const [status, setStatus] = useState<DisplayStatus>("loading")
  const [fps, setFps] = useState<number | null>(null)
  const [quality, setQuality] = useState<GraphicsQuality>("high")

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    let disposed = false
    let generation = 0
    let frame = 0
    let teardown: (() => void) | undefined

    const start = async () => {
      const currentGeneration = ++generation
      if (motion.matches) {
        setStatus("reduced")
        displayRef.current?.(false)
        return
      }

      try {
        const THREE = await import("three")
        if (disposed || generation !== currentGeneration) return
        let renderer: Three.WebGLRenderer
        try {
          renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power" })
        } catch {
          setStatus("fallback")
          displayRef.current?.(false)
          return
        }

        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
        camera.position.set(0, 0, kind === "core" ? 7 : 9)
        const group = new THREE.Group()
        scene.add(group)
        const geometries: Three.BufferGeometry[] = []
        const materials: Three.Material[] = []
        const nodes = new Map<AgentId, Three.Mesh>()
        const links = new Map<string, Three.Line>()
        const ownGeometry = <T extends Three.BufferGeometry>(value: T) => { geometries.push(value); return value }
        const ownMaterial = <T extends Three.Material>(value: T) => { materials.push(value); return value }

        const createSphere = (radius: number, color: string, wireframe: boolean) =>
          new THREE.Mesh(
            ownGeometry(new THREE.IcosahedronGeometry(radius, wireframe ? 2 : 1)),
            ownMaterial(new THREE.MeshBasicMaterial({ color, wireframe, transparent: true, opacity: wireframe ? 0.65 : 0.9 })),
          )

        if (kind === "core") {
          group.add(createSphere(0.65, "#48e5fa", false))
          group.add(createSphere(1.05, "#22d3ee", true))
          for (let i = 0; i < 3; i++) {
            const ring = new THREE.Mesh(
              ownGeometry(new THREE.TorusGeometry(1.4 + i * 0.25, 0.012, 5, 64)),
              ownMaterial(new THREE.MeshBasicMaterial({ color: "#67e8f9", transparent: true, opacity: 0.55 })),
            )
            ring.rotation.set(i * 0.8, i * 0.6, 0)
            group.add(ring)
          }
        } else {
          AGENT_ORDER.forEach((id, index) => {
            const node = createSphere(index === 0 ? 0.32 : 0.23, AGENTS[id].color, index !== 0)
            if (index > 0) {
              const angle = ((index - 1) / 6) * Math.PI * 2
              node.position.set(Math.cos(angle) * 2.4, Math.sin(angle) * 1.65, index % 2 ? 0.55 : -0.55)
            }
            node.userData.agentId = id
            nodes.set(id, node)
            group.add(node)
          })
          for (const [from, origin] of nodes) {
            for (const [to, destination] of nodes) {
              if (from === to) continue
              const geometry = ownGeometry(new THREE.BufferGeometry().setFromPoints([origin.position.clone(), destination.position.clone()]))
              const line = new THREE.Line(geometry, ownMaterial(new THREE.LineBasicMaterial({ color: AGENTS[from].color, transparent: true, opacity: 0.55 })))
              line.visible = false
              links.set(`${from}:${to}`, line)
              group.add(line)
            }
          }
        }

        let currentQuality: GraphicsQuality = "high"
        let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5)
        const resize = () => {
          const width = container.clientWidth
          const height = container.clientHeight
          if (!width || !height) return
          renderer.setPixelRatio(pixelRatio)
          renderer.setSize(width, height, false)
          camera.aspect = width / height
          camera.updateProjectionMatrix()
        }
        const observer = new ResizeObserver(resize)
        observer.observe(container)
        renderer.domElement.className = "block size-full"
        renderer.domElement.setAttribute("aria-hidden", "true")
        container.appendChild(renderer.domElement)
        resize()

        const raycaster = new THREE.Raycaster()
        const pointer = new THREE.Vector2()
        const onPointer = (event: PointerEvent) => {
          if (kind !== "agents") return
          const bounds = renderer.domElement.getBoundingClientRect()
          if (!bounds.width || !bounds.height) return
          pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1)
          raycaster.setFromCamera(pointer, camera)
          const hit = raycaster.intersectObjects([...nodes.values()])[0]
          const id = hit?.object.userData.agentId as AgentId | undefined
          if (id) inspectRef.current?.(id)
        }
        const onContextLost = (event: Event) => {
          event.preventDefault()
          setStatus("fallback")
          displayRef.current?.(false)
          cancelAnimationFrame(frame)
        }
        renderer.domElement.addEventListener("pointerup", onPointer)
        renderer.domElement.addEventListener("webglcontextlost", onContextLost)
        let sampleStart = performance.now()
        let frames = 0
        let lastFrame = sampleStart
        let poorSamples = 0

        const draw = (now: number) => {
          if (disposed) return
          if (!document.hidden) {
            const elapsed = Math.min((now - lastFrame) / 1000, 0.1)
            group.rotation.y += elapsed * (kind === "core" ? 0.35 : 0.12)
            group.rotation.x = Math.sin(now / 4000) * 0.14
            for (const [id, node] of nodes) {
              const state = runRef.current?.agents[id].status
              node.scale.setScalar(state === "thinking" ? 1.25 : 1)
            }
            const activeLinks = new Set(runRef.current?.links.map((link) => `${link.from}:${link.to}`) ?? [])
            for (const [key, line] of links) line.visible = activeLinks.has(key)
            renderer.render(scene, camera)
            frames++
            if (now - sampleStart >= 5000) {
              const measured = Math.round((frames * 1000) / (now - sampleStart))
              setFps(measured)
              const target = nextGraphicsQuality(currentQuality, measured)
              poorSamples = target !== currentQuality ? poorSamples + 1 : 0
              if (poorSamples >= 2) {
                currentQuality = target
                setQuality(target)
                poorSamples = 0
                if (target === "fallback") {
                  setStatus("fallback")
                  displayRef.current?.(false)
                  return
                }
                pixelRatio = 1
                resize()
              }
              frames = 0
              sampleStart = now
            }
          } else {
            frames = 0
            sampleStart = now
          }
          lastFrame = now
          frame = requestAnimationFrame(draw)
        }

        teardown = () => {
          cancelAnimationFrame(frame)
          observer.disconnect()
          renderer.domElement.removeEventListener("pointerup", onPointer)
          renderer.domElement.removeEventListener("webglcontextlost", onContextLost)
          geometries.forEach((geometry) => geometry.dispose())
          materials.forEach((material) => material.dispose())
          renderer.dispose()
          renderer.domElement.remove()
        }
        setStatus("3d")
        displayRef.current?.(true)
        frame = requestAnimationFrame(draw)
      } catch (error) {
        console.error("[jarvis] 3D visualization failed", error)
        if (!disposed && generation === currentGeneration) {
          setStatus("fallback")
          displayRef.current?.(false)
        }
      }
    }

    const onMotionChange = () => {
      generation++
      teardown?.()
      teardown = undefined
      setStatus("loading")
      displayRef.current?.(false)
      setFps(null)
      setQuality("high")
      void start()
    }
    motion.addEventListener("change", onMotionChange)
    void start()
    return () => {
      disposed = true
      generation++
      motion.removeEventListener("change", onMotionChange)
      teardown?.()
    }
  }, [kind])

  return (
    <div className={kind === "core" ? "absolute inset-0" : "space-y-2"}>
      <div ref={containerRef} style={{ visibility: status === "3d" ? "visible" : "hidden" }} className={kind === "core" ? "size-full" : "glass h-64 w-full overflow-hidden rounded-3xl"} />
      {kind === "agents" && (
        <p className="text-xs text-muted-foreground" role="status">
          {status === "3d" ? `3D WebGL · ${fps === null ? "měřím výkon…" : `${fps} FPS (průměr za 5 s)`} · kvalita ${quality === "low" ? "úsporná" : "standardní"}. Klepněte na bod nebo použijte karty níže.` : status === "loading" ? "Načítám 3D vizualizaci…" : status === "reduced" ? "Omezení pohybu je zapnuto. Použijte přístupné 2D karty níže." : "3D není dostupné nebo výkon nestačí. Použijte 2D karty níže."}
        </p>
      )}
    </div>
  )
}
