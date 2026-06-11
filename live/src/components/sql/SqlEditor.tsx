import { useEffect, useRef } from "react"
import Editor, { type OnMount } from "@monaco-editor/react"
import { Spinner } from "@/components/ui/spinner"
import { useTheme } from "@/hooks/use-theme"

interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  /** Invoked on Cmd/Ctrl+Enter inside the editor. */
  onRun: () => void
}

export function SqlEditor({ value, onChange, onRun }: SqlEditorProps) {
  const { resolvedTheme } = useTheme()

  // Monaco commands capture their closure at mount; route through a ref so
  // Cmd/Ctrl+Enter always runs with the latest query/docs/limit.
  const onRunRef = useRef(onRun)
  useEffect(() => {
    onRunRef.current = onRun
  }, [onRun])

  const handleMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      onRunRef.current()
    })
  }

  return (
    <Editor
      language="sql"
      value={value}
      onChange={(v) => onChange(v ?? "")}
      theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
      onMount={handleMount}
      loading={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
      options={{
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        lineHeight: 20,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontLigatures: true,
        lineNumbers: "on",
        renderLineHighlight: "none",
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        scrollbar: {
          verticalScrollbarSize: 8,
          horizontalScrollbarSize: 8,
        },
        padding: { top: 8 },
        wordWrap: "on",
        automaticLayout: true,
        tabSize: 2,
      }}
    />
  )
}
