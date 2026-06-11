import { useEffect, useMemo, useRef, useState } from "react"
import type { SqlColumn } from "@/api/types"

/**
 * Hand-rolled SVG bar/line chart for query results — no charting dependency.
 * Theme-aware via CSS variables (--primary, --border, --muted-foreground).
 */

const MAX_BAR_POINTS = 200
const MAX_LINE_POINTS = 2000

const PAD = { top: 12, right: 16, bottom: 26, left: 56 }

/** Columns whose sampled values are all numbers (NULLs ignored). */
export function getNumericColumns(
  columns: SqlColumn[],
  rows: Record<string, unknown>[],
): string[] {
  const sample = rows.slice(0, 50)
  return columns
    .filter((col) => {
      let seen = false
      for (const row of sample) {
        const v = row[col.name]
        if (v === null || v === undefined) continue
        if (typeof v !== "number" || !Number.isFinite(v)) return false
        seen = true
      }
      return seen
    })
    .map((col) => col.name)
}

/** First text/date column to use as the X axis (null -> row index). */
export function getXColumn(
  columns: SqlColumn[],
  rows: Record<string, unknown>[],
): string | null {
  const numeric = new Set(getNumericColumns(columns, rows))
  const sample = rows.slice(0, 50)
  for (const col of columns) {
    if (numeric.has(col.name)) continue
    const ok = sample.some((row) => {
      const v = row[col.name]
      return typeof v === "string" || typeof v === "number"
    })
    if (ok) return col.name
  }
  return null
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return { ref, size }
}

/** ~`count` round-numbered ticks spanning [min, max]. */
function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) max = min === 0 ? 1 : min + Math.abs(min)
  const span = max - min
  const rawStep = span / count
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const normalized = rawStep / magnitude
  const step =
    (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude
  const ticks: number[] = []
  for (let t = Math.ceil(min / step) * step; t <= max + step / 1e6; t += step) {
    ticks.push(Math.abs(t) < step / 1e6 ? 0 : t)
  }
  return ticks
}

const compactFmt = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})

function formatTick(v: number): string {
  if (Math.abs(v) >= 1000) return compactFmt.format(v)
  return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 1 ? 2 : 1)
}

interface ResultsChartProps {
  columns: SqlColumn[]
  rows: Record<string, unknown>[]
  kind: "bar" | "line"
  yColumn: string
}

export function ResultsChart({ columns, rows, kind, yColumn }: ResultsChartProps) {
  const { ref, size } = useElementSize<HTMLDivElement>()

  const cap = kind === "bar" ? MAX_BAR_POINTS : MAX_LINE_POINTS
  const xColumn = useMemo(() => getXColumn(columns, rows), [columns, rows])

  const points = useMemo(() => {
    return rows.slice(0, cap).map((row, i) => {
      const rawY = row[yColumn]
      const y = typeof rawY === "number" && Number.isFinite(rawY) ? rawY : null
      const rawX = xColumn ? row[xColumn] : i + 1
      const label = rawX === null || rawX === undefined ? `#${i + 1}` : String(rawX)
      return { label, y }
    })
  }, [rows, cap, xColumn, yColumn])

  const yValues = points.flatMap((p) => (p.y === null ? [] : [p.y]))

  if (yValues.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        No numeric values in “{yColumn}” to plot.
      </div>
    )
  }

  const dataMin = Math.min(...yValues)
  const dataMax = Math.max(...yValues)
  // Bars are anchored at zero; lines track the data range.
  const yMin = kind === "bar" ? Math.min(0, dataMin) : dataMin
  const yMax = kind === "bar" ? Math.max(0, dataMax) : dataMax

  const { width, height } = size
  const innerW = Math.max(0, width - PAD.left - PAD.right)
  const innerH = Math.max(0, height - PAD.top - PAD.bottom)
  const span = yMax - yMin || 1

  const yScale = (v: number) => PAD.top + innerH - ((v - yMin) / span) * innerH
  const xScale = (i: number) =>
    PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW)

  const ticks = niceTicks(yMin, yMax, 4).filter((t) => t >= yMin && t <= yMax)

  // At most ~8 x labels, evenly spaced.
  const labelStep = Math.max(1, Math.ceil(points.length / 8))
  const xLabels = points
    .map((p, i) => ({ label: p.label, i }))
    .filter(({ i }) => i % labelStep === 0)

  const barWidth = points.length > 0 ? (innerW / points.length) * 0.8 : 0
  const barX = (i: number) => PAD.left + (i + 0.1) * (innerW / points.length)

  const linePath = points
    .map((p, i) => (p.y === null ? null : `${xScale(i)},${yScale(p.y)}`))
    .filter((s): s is string => s !== null)
    .map((coords, i) => `${i === 0 ? "M" : "L"}${coords}`)
    .join(" ")

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {rows.length > cap && (
        <p className="shrink-0 px-3 pt-2 text-[11px] text-muted-foreground">
          Chart shows the first {cap.toLocaleString()} of {rows.length.toLocaleString()} rows.
        </p>
      )}
      <div ref={ref} className="min-h-0 flex-1 p-2">
        {width > 0 && height > 0 && (
          <svg width={width} height={height} role="img" aria-label={`${kind} chart of ${yColumn}`}>
            {/* Horizontal grid + y tick labels */}
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={yScale(t)}
                  y2={yScale(t)}
                  stroke="var(--border)"
                  strokeWidth={1}
                  strokeDasharray={t === 0 ? undefined : "3 3"}
                />
                <text
                  x={PAD.left - 8}
                  y={yScale(t)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={10}
                  fill="var(--muted-foreground)"
                >
                  {formatTick(t)}
                </text>
              </g>
            ))}

            {/* X tick labels */}
            {xLabels.map(({ label, i }) => (
              <text
                key={i}
                x={kind === "bar" ? barX(i) + barWidth / 2 : xScale(i)}
                y={height - PAD.bottom + 14}
                textAnchor="middle"
                fontSize={10}
                fill="var(--muted-foreground)"
              >
                {label.length > 12 ? `${label.slice(0, 11)}…` : label}
              </text>
            ))}

            {kind === "bar" ? (
              points.map((p, i) => {
                if (p.y === null) return null
                const zero = yScale(Math.max(yMin, Math.min(yMax, 0)))
                const top = yScale(p.y)
                return (
                  <rect
                    key={i}
                    x={barX(i)}
                    y={Math.min(top, zero)}
                    width={Math.max(1, barWidth)}
                    height={Math.max(1, Math.abs(zero - top))}
                    rx={1}
                    fill="var(--primary)"
                    fillOpacity={0.85}
                  >
                    <title>{`${p.label}: ${p.y.toLocaleString()}`}</title>
                  </rect>
                )
              })
            ) : (
              <>
                <path d={linePath} fill="none" stroke="var(--primary)" strokeWidth={1.5} />
                {points.length <= 60 &&
                  points.map((p, i) =>
                    p.y === null ? null : (
                      <circle key={i} cx={xScale(i)} cy={yScale(p.y)} r={2.5} fill="var(--primary)">
                        <title>{`${p.label}: ${p.y.toLocaleString()}`}</title>
                      </circle>
                    ),
                  )}
              </>
            )}
          </svg>
        )}
      </div>
    </div>
  )
}
