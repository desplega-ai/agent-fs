import { useEffect, useRef } from "react"
import Editor, { useMonaco, type OnMount } from "@monaco-editor/react"
import { Spinner } from "@/components/ui/spinner"
import { useTheme } from "@/hooks/use-theme"

/** A schema/table/column name offered as an editor autocomplete suggestion. */
export interface SqlCompletion {
  label: string
  detail?: string
  kind?: "table" | "schema" | "column"
}

interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  /** Invoked on Cmd/Ctrl+Enter inside the editor. */
  onRun: () => void
  /** Bound table / database names suggested as you type. */
  completions?: SqlCompletion[]
}

export function SqlEditor({ value, onChange, onRun, completions = [] }: SqlEditorProps) {
  const { resolvedTheme } = useTheme()
  const monaco = useMonaco()

  // Monaco commands capture their closure at mount; route through a ref so
  // Cmd/Ctrl+Enter always runs with the latest query/docs/limit.
  const onRunRef = useRef(onRun)
  useEffect(() => {
    onRunRef.current = onRun
  }, [onRun])

  // Latest completions, read live by the provider registered once below.
  const completionsRef = useRef(completions)
  useEffect(() => {
    completionsRef.current = completions
  }, [completions])

  // Register a SQL completion provider for bound tables/databases. Monaco's
  // built-in SQL keyword completion still applies alongside these.
  useEffect(() => {
    if (!monaco) return
    const provider = monaco.languages.registerCompletionItemProvider("sql", {
      triggerCharacters: [" ", ".", "\n", "("],
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position)
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        }
        const kindFor = (k?: SqlCompletion["kind"]) =>
          k === "schema"
            ? monaco.languages.CompletionItemKind.Module
            : k === "column"
              ? monaco.languages.CompletionItemKind.Field
              : monaco.languages.CompletionItemKind.Struct
        return {
          suggestions: completionsRef.current.map((c) => ({
            label: c.label,
            kind: kindFor(c.kind),
            insertText: c.label,
            detail: c.detail,
            range,
          })),
        }
      },
    })
    return () => provider.dispose()
  }, [monaco])

  const handleMount: OnMount = (editor, monaco) => {
    // addAction registers a reliable keybinding (addCommand's binding can be
    // shadowed by Monaco defaults). Cmd/Ctrl+Enter runs the query.
    editor.addAction({
      id: "agent-fs.run-query",
      label: "Run query",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => onRunRef.current(),
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
