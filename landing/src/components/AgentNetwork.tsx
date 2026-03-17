import { useEffect, useRef } from "react"

interface Node {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  pulse: number
  pulseSpeed: number
  isAgent: boolean
}

interface Packet {
  fromIdx: number
  toIdx: number
  progress: number
  speed: number
}

const NODE_COUNT = 40
const AGENT_COUNT = 6
const CONNECTION_DIST = 180
const PARALLAX = 0.4

export function AgentNetwork() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef(0)
  const nodesRef = useRef<Node[]>([])
  const packetsRef = useRef<Packet[]>([])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")!
    if (!ctx) return

    function resize() {
      canvas!.width = window.innerWidth
      canvas!.height = window.innerHeight
    }

    function initNodes() {
      const nodes: Node[] = []
      for (let i = 0; i < NODE_COUNT; i++) {
        nodes.push({
          x: Math.random() * canvas!.width,
          y: Math.random() * canvas!.height * 2.5,
          vx: (Math.random() - 0.5) * 0.3,
          vy: (Math.random() - 0.5) * 0.15,
          radius: i < AGENT_COUNT ? 3 : 1.5,
          pulse: Math.random() * Math.PI * 2,
          pulseSpeed: 0.02 + Math.random() * 0.02,
          isAgent: i < AGENT_COUNT,
        })
      }
      nodesRef.current = nodes
    }

    function spawnPacket() {
      const nodes = nodesRef.current
      const agents = nodes.filter((_, i) => i < AGENT_COUNT)
      if (agents.length < 2) return

      // Pick two visible agent-ish nodes
      const fromIdx = Math.floor(Math.random() * AGENT_COUNT)
      let toIdx = fromIdx
      while (toIdx === fromIdx) toIdx = Math.floor(Math.random() * AGENT_COUNT)

      packetsRef.current.push({
        fromIdx,
        toIdx,
        progress: 0,
        speed: 0.005 + Math.random() * 0.008,
      })
    }

    function onScroll() {
      scrollRef.current = window.scrollY
    }

    resize()
    initNodes()
    window.addEventListener("resize", () => { resize(); initNodes() })
    window.addEventListener("scroll", onScroll, { passive: true })

    const packetInterval = setInterval(spawnPacket, 800)

    let animId: number
    function draw() {
      const nodes = nodesRef.current
      const packets = packetsRef.current
      const scrollY = scrollRef.current * PARALLAX

      ctx.clearRect(0, 0, canvas!.width, canvas!.height)

      // Update nodes
      for (const node of nodes) {
        node.x += node.vx
        node.y += node.vy
        node.pulse += node.pulseSpeed

        // Soft boundary bounce
        if (node.x < 0 || node.x > canvas!.width) node.vx *= -1
        if (node.y < -100 || node.y > canvas!.height * 2.5) node.vy *= -1
      }

      // Draw connections
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          const ay = a.y - scrollY
          const by = b.y - scrollY
          const dx = a.x - b.x
          const dy = ay - by
          const dist = Math.sqrt(dx * dx + dy * dy)

          if (dist < CONNECTION_DIST) {
            const alpha = (1 - dist / CONNECTION_DIST) * 0.12
            ctx.beginPath()
            ctx.moveTo(a.x, ay)
            ctx.lineTo(b.x, by)
            ctx.strokeStyle = `rgba(0, 255, 0, ${alpha})`
            ctx.lineWidth = 0.5
            ctx.stroke()
          }
        }
      }

      // Draw nodes
      for (const node of nodes) {
        const ny = node.y - scrollY
        if (ny < -20 || ny > canvas!.height + 20) continue

        const pulseAlpha = node.isAgent
          ? 0.4 + Math.sin(node.pulse) * 0.3
          : 0.15 + Math.sin(node.pulse) * 0.1

        // Glow for agent nodes
        if (node.isAgent) {
          const grad = ctx.createRadialGradient(node.x, ny, 0, node.x, ny, 20)
          grad.addColorStop(0, `rgba(0, 255, 0, ${pulseAlpha * 0.3})`)
          grad.addColorStop(1, "rgba(0, 255, 0, 0)")
          ctx.beginPath()
          ctx.arc(node.x, ny, 20, 0, Math.PI * 2)
          ctx.fillStyle = grad
          ctx.fill()
        }

        ctx.beginPath()
        ctx.arc(node.x, ny, node.radius, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(0, 255, 0, ${pulseAlpha})`
        ctx.fill()
      }

      // Draw packets (bright dots traveling between agents)
      for (let i = packets.length - 1; i >= 0; i--) {
        const p = packets[i]
        p.progress += p.speed

        if (p.progress >= 1) {
          packets.splice(i, 1)
          continue
        }

        const from = nodes[p.fromIdx]
        const to = nodes[p.toIdx]
        const x = from.x + (to.x - from.x) * p.progress
        const y = (from.y + (to.y - from.y) * p.progress) - scrollY

        if (y < -20 || y > canvas!.height + 20) continue

        // Bright packet with trail
        const grad = ctx.createRadialGradient(x, y, 0, x, y, 8)
        grad.addColorStop(0, "rgba(0, 255, 0, 0.9)")
        grad.addColorStop(0.5, "rgba(0, 255, 0, 0.3)")
        grad.addColorStop(1, "rgba(0, 255, 0, 0)")
        ctx.beginPath()
        ctx.arc(x, y, 8, 0, Math.PI * 2)
        ctx.fillStyle = grad
        ctx.fill()

        ctx.beginPath()
        ctx.arc(x, y, 2, 0, Math.PI * 2)
        ctx.fillStyle = "rgba(255, 255, 255, 0.9)"
        ctx.fill()
      }

      animId = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      cancelAnimationFrame(animId)
      clearInterval(packetInterval)
      window.removeEventListener("resize", resize)
      window.removeEventListener("scroll", onScroll)
    }
  }, [])

  return (
    <div className="fixed inset-0 -z-10 opacity-60">
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  )
}
