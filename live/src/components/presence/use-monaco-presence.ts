import { useEffect, useMemo, useRef } from "react"
import type { editor, IPosition } from "monaco-editor"
import { useFileStat } from "@/hooks/use-file-stat"
import { sourceTextSpace, type TextSpace } from "@/lib/comment-anchor"
import { colorSlot, pointerAt, presenceName, resolvePointer, resolveSelection, selectionAt, slotColor } from "@/lib/presence"
import { presenceStore, useDocPresence, usePresenceEnabled, usePresenceMode, usePresenceSettings } from "@/stores/presence"
import { createPointerNode, paintPointerNode } from "./pointer"

const POINTER_IDLE_MS = 5_000
// monaco-editor is only imported for types (the editor loads lazily), so its
// enums are spelled as numbers.
const MOUSE_TARGET_CONTENT_TEXT = 6
const WIDGET_EXACT = 0

interface PointerWidget {
  widget: editor.IContentWidget
  node: HTMLElement
  position: IPosition
}

/**
 * Presence in a Monaco viewer or editor: publishes this tab's selection
 * (or caret) and the text under the mouse, and draws other people's
 * selections and carets (decorations) and pointers (content widgets).
 *
 * `text` is what the editor shows. `source` is the file text when that is a
 * transformed view of it (JSON shown formatted), as for comment anchors.
 */
export function useMonacoPresence(
  ed: editor.IStandaloneCodeEditor | null,
  { path, text, source }: { path: string; text: string; source?: string },
) {
  const enabled = usePresenceEnabled()
  const { data: stat } = useFileStat(path)
  const version = stat?.currentVersion
  const versionRef = useRef(version)
  useEffect(() => { versionRef.current = version }, [version])

  // Publish. The space is rebuilt from the model when it changed, so offsets
  // match the text even before React sees an edit.
  useEffect(() => {
    if (!enabled || !ed) return
    const owner = {}
    let cache: { model: editor.ITextModel; versionId: number; space: TextSpace } | null = null
    const spaceOf = (model: editor.ITextModel) => {
      const versionId = model.getVersionId()
      if (cache?.model !== model || cache.versionId !== versionId) cache = { model, versionId, space: sourceTextSpace(model.getValue()) }
      return cache.space
    }
    let idle: ReturnType<typeof setTimeout> | undefined
    const clearPointer = () => {
      clearTimeout(idle)
      presenceStore.clearPointer(owner)
    }
    const subscriptions = [
      ed.onDidChangeCursorSelection((e) => {
        const model = ed.getModel()
        if (!model) return
        const start = model.getOffsetAt(e.selection.getStartPosition())
        const end = model.getOffsetAt(e.selection.getEndPosition())
        presenceStore.setSelection(selectionAt(spaceOf(model), start, end, versionRef.current), owner)
      }),
      ed.onMouseMove((e) => {
        const model = ed.getModel()
        const pos = e.target.position
        clearTimeout(idle)
        idle = setTimeout(clearPointer, POINTER_IDLE_MS)
        // Past a line end or over the gutter is not over text.
        if (!model || !pos || e.target.type !== MOUSE_TARGET_CONTENT_TEXT) return presenceStore.clearPointer(owner)
        presenceStore.setPointer(pointerAt(spaceOf(model), model.getOffsetAt(pos), versionRef.current), owner)
      }),
      ed.onMouseLeave(clearPointer),
    ]
    return () => {
      subscriptions.forEach((s) => s.dispose())
      clearTimeout(idle)
      presenceStore.clearSelection(owner)
      presenceStore.clearPointer(owner)
    }
  }, [enabled, ed])

  // Resolve other people's positions in the shown text.
  const users = useDocPresence(path)
  const settings = usePresenceSettings()
  const mode = usePresenceMode()
  const view = useMemo(() => (enabled ? sourceTextSpace(text) : null), [enabled, text])
  const sourceSpace = useMemo(() => (enabled && source != null ? sourceTextSpace(source) : undefined), [enabled, source])
  const resolved = useMemo(() => {
    if (!view) return []
    return users.map((s) => ({
      userId: s.userId,
      slot: colorSlot(s.userId),
      name: presenceName(s),
      selection: s.selection ? resolveSelection(view, sourceSpace, s.selection, version) : null,
      pointer: s.pointer ? resolvePointer(view, sourceSpace, s.pointer, version) : null,
    }))
  }, [view, sourceSpace, users, version])
  const resolvedRef = useRef(resolved)
  useEffect(() => { resolvedRef.current = resolved }, [resolved])

  // Selections and carets: one decoration per person (range + caret after it).
  // One collection per editor, updated in place on every remote move.
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  useEffect(() => {
    if (!ed) return
    const collection = ed.createDecorationsCollection()
    decorationsRef.current = collection
    return () => {
      collection.clear()
      decorationsRef.current = null
    }
  }, [ed])
  useEffect(() => {
    const model = ed?.getModel()
    const collection = decorationsRef.current
    if (!ed || !model || !collection) return
    const decorations: editor.IModelDeltaDecoration[] = []
    for (const r of resolved) {
      if (!r.selection) continue
      const showRange = settings.showSelections && r.selection.start < r.selection.end
      if (!showRange && !settings.showCursors) continue
      const start = model.getPositionAt(r.selection.start)
      const end = model.getPositionAt(r.selection.end)
      decorations.push({
        range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column },
        options: {
          className: showRange ? `presence-sel-${r.slot}` : undefined,
          hoverMessage: showRange ? { value: r.name } : undefined,
          afterContentClassName: settings.showCursors ? `presence-caret presence-caret-${r.slot}` : undefined,
        },
      })
    }
    collection.set(decorations)
  }, [ed, resolved, settings.showSelections, settings.showCursors])

  // Pointers: a content widget per person, moved as they move.
  const widgetsRef = useRef(new Map<string, PointerWidget>())
  useEffect(() => {
    const model = ed?.getModel()
    const widgets = widgetsRef.current
    if (!ed || !model) return
    const wanted = new Map<string, { position: IPosition; color: string; name: string }>()
    // The snapshot poll is too slow for a moving pointer.
    if (settings.showCursors && mode === "stream") {
      for (const r of resolved) {
        if (r.pointer != null) wanted.set(r.userId, { position: model.getPositionAt(r.pointer), color: slotColor(r.slot), name: r.name })
      }
    }
    for (const [userId, w] of widgets) {
      if (wanted.has(userId)) continue
      ed.removeContentWidget(w.widget)
      widgets.delete(userId)
    }
    for (const [userId, want] of wanted) {
      let w = widgets.get(userId)
      if (w) {
        w.position = want.position
        ed.layoutContentWidget(w.widget)
      } else {
        const node = createPointerNode()
        const entry: PointerWidget = {
          node,
          position: want.position,
          widget: {
            getId: () => `presence-pointer-${userId}`,
            getDomNode: () => node,
            getPosition: () => ({ position: entry.position, preference: [WIDGET_EXACT] }),
          },
        }
        widgets.set(userId, entry)
        ed.addContentWidget(entry.widget)
        w = entry
      }
      paintPointerNode(w.node, want.color, want.name)
    }
  }, [ed, resolved, settings.showCursors, mode])
  useEffect(() => {
    const widgets = widgetsRef.current
    return () => {
      for (const w of widgets.values()) ed?.removeContentWidget(w.widget)
      widgets.clear()
    }
  }, [ed])

  // The header's people list scrolls to someone's selection, else their pointer.
  useEffect(() => {
    if (!enabled || !ed) return
    return presenceStore.registerRevealer((userId) => {
      const model = ed.getModel()
      const r = resolvedRef.current.find((x) => x.userId === userId)
      const offset = r?.selection?.caret ?? r?.pointer
      if (!model || offset == null) return false
      ed.revealPositionInCenter(model.getPositionAt(offset))
      return true
    })
  }, [enabled, ed])
}
