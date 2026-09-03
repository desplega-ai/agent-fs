import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  MDXEditor,
  type MDXEditorMethods,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  imagePlugin,
  tablePlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  CodeMirrorEditor,
  frontmatterPlugin,
  markdownShortcutPlugin,
  diffSourcePlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ListsToggle,
  CreateLink,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  InsertCodeBlock,
  InsertFrontmatter,
  DiffSourceToggleWrapper,
  ConditionalContents,
  ChangeCodeMirrorLanguage,
  Separator,
} from "@mdxeditor/editor"
import { basicDark } from "cm6-theme-basic-dark"
import "@mdxeditor/editor/style.css"
import { useTheme } from "@/hooks/use-theme"
import { toast } from "@/stores/toast"
import { cn } from "@/lib/utils"
import { EditToolbar } from "./EditToolbar"

// Languages offered in the code block language picker. Any other fence
// language still opens in CodeMirror through the catch-all descriptor below
// and is written back unchanged.
const CODE_BLOCK_LANGUAGES: Record<string, string> = {
  "": "Plain text",
  txt: "Text",
  md: "Markdown",
  js: "JavaScript",
  jsx: "JSX",
  ts: "TypeScript",
  tsx: "TSX",
  json: "JSON",
  yaml: "YAML",
  toml: "TOML",
  sh: "Shell",
  bash: "Bash",
  py: "Python",
  rs: "Rust",
  go: "Go",
  sql: "SQL",
  css: "CSS",
  html: "HTML",
  xml: "XML",
  diff: "Diff",
  mermaid: "Mermaid",
}

interface RichMarkdownEditorProps {
  content: string
  className?: string
  /** Resolves to `true` when the write succeeded. */
  onSave: (content: string) => Promise<boolean>
  isSaving: boolean
  saveError: Error | null
  onClearError: () => void
  onCancel: () => void
  onDirtyChange: (dirty: boolean) => void
  /** The initial markdown could not be parsed; the parent falls back to the source editor. */
  onParseError: () => void
}

/**
 * MDXEditor trims the markdown it exports. Files almost always end with a
 * newline, so restore it and keep a no-op save byte-equal to the original.
 */
function matchTrailingNewline(original: string, markdown: string): string {
  if (original.endsWith("\n") && !markdown.endsWith("\n")) return markdown + "\n"
  return markdown
}

function Toolbar() {
  return (
    <DiffSourceToggleWrapper>
      <ConditionalContents
        options={[
          {
            when: (editor) => editor?.editorType === "codeblock",
            contents: () => <ChangeCodeMirrorLanguage />,
          },
          {
            fallback: () => (
              <>
                <UndoRedo />
                <Separator />
                <BoldItalicUnderlineToggles />
                <BlockTypeSelect />
                <Separator />
                <ListsToggle />
                <Separator />
                <CreateLink />
                <InsertImage />
                <InsertTable />
                <InsertThematicBreak />
                <InsertCodeBlock />
                <InsertFrontmatter />
              </>
            ),
          },
        ]}
      />
    </DiffSourceToggleWrapper>
  )
}

/**
 * WYSIWYG markdown editor (MDXEditor) for the "rich" edit mode. Loaded lazily
 * from `FileViewer`, so this module also imports MDXEditor's stylesheet.
 */
export default function RichMarkdownEditor({
  content, className, onSave, isSaving, saveError, onClearError, onCancel, onDirtyChange, onParseError,
}: RichMarkdownEditorProps) {
  const { resolvedTheme } = useTheme()
  const editorRef = useRef<MDXEditorMethods>(null)
  // `original` is the text on disk. `baseline` is what the editor holds after
  // its normalization pass; edits are measured against it so a reformatted
  // file does not open as "Unsaved".
  const originalRef = useRef(content)
  const baselineRef = useRef(content)
  const loadedRef = useRef(false)
  const warnedRef = useRef(false)
  const [isDirty, setIsDirty] = useState(false)
  // What the in-editor diff view compares against: the file as last written.
  const [diffBase, setDiffBase] = useState(content)

  useEffect(() => {
    onDirtyChange(isDirty)
  }, [isDirty, onDirtyChange])

  // beforeunload guard while dirty
  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [isDirty])

  const warnReformat = useCallback(() => {
    if (warnedRef.current) return
    warnedRef.current = true
    toast("Rich editor reformatted this file", {
      description: "Saving will rewrite its markdown formatting.",
      duration: 6000,
    })
  }, [])

  // MDXEditor trims the document it imports. Leading blank lines or extra
  // trailing newlines are dropped without any `onChange`, so check for them
  // here; every other reformat surfaces through the normalization pass below.
  useEffect(() => {
    if (matchTrailingNewline(content, content.trim()) !== content) warnReformat()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = useCallback((markdown: string, initialMarkdownNormalize: boolean) => {
    // Any change event proves the import succeeded. A file that round-trips
    // byte-identically never gets the normalization event, so do not rely on it.
    loadedRef.current = true
    const next = matchTrailingNewline(originalRef.current, markdown)
    if (initialMarkdownNormalize) {
      baselineRef.current = next
      setIsDirty(false)
      if (next !== originalRef.current) warnReformat()
      return
    }
    setIsDirty(next !== baselineRef.current)
  }, [warnReformat])

  // MDXEditor reports parse errors synchronously while it builds its editor
  // state, which can be inside a React render. Defer so the toast and the
  // parent's mode switch happen outside of it.
  const handleError = useCallback(({ error }: { error: string; source: string }) => {
    const initial = !loadedRef.current
    setTimeout(() => {
      toast.error("Rich editor cannot parse this file", { description: error, duration: 6000 })
      if (initial) onParseError()
    }, 0)
  }, [onParseError])

  const handleSave = useCallback(async () => {
    if (isSaving) return
    const markdown = matchTrailingNewline(originalRef.current, editorRef.current?.getMarkdown() ?? "")
    if (!isDirty || markdown === originalRef.current) {
      toast("No changes to save")
      setIsDirty(false)
      return
    }
    if (await onSave(markdown)) {
      originalRef.current = markdown
      baselineRef.current = markdown
      setDiffBase(markdown)
      setIsDirty(false)
    }
  }, [isDirty, isSaving, onSave])

  const handleCancel = useCallback(() => {
    if (isDirty && !window.confirm("Discard unsaved changes?")) return
    onCancel()
  }, [isDirty, onCancel])

  // Cmd/Ctrl+S from anywhere inside the editor (content, code blocks, source mode).
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault()
      void handleSave()
    }
  }, [handleSave])

  const plugins = useMemo(() => {
    const codeMirrorExtensions = resolvedTheme === "dark" ? [basicDark] : []
    return [
      toolbarPlugin({ toolbarContents: () => <Toolbar /> }),
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      imagePlugin(),
      tablePlugin(),
      codeBlockPlugin({
        defaultCodeBlockLanguage: "",
        // Catch-all so fences in languages outside the picker (mermaid, …)
        // open in CodeMirror instead of failing the import.
        codeBlockEditorDescriptors: [{ priority: -10, match: () => true, Editor: CodeMirrorEditor }],
      }),
      codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES, codeMirrorExtensions }),
      frontmatterPlugin(),
      // Source / diff view inside the editor. MDXEditor re-reads plugin params
      // on every render, so a new array after a save updates the diff base.
      diffSourcePlugin({ diffMarkdown: diffBase, viewMode: "rich-text", codeMirrorExtensions }),
      markdownShortcutPlugin(),
    ]
  }, [resolvedTheme, diffBase])

  return (
    <div className={cn("relative flex flex-col", className)} onKeyDown={handleKeyDown}>
      <EditToolbar
        isDirty={isDirty}
        isSaving={isSaving}
        saveError={saveError}
        onClearError={onClearError}
        onSave={() => void handleSave()}
        onCancel={handleCancel}
      />
      <div className="flex-1 min-h-0 flex flex-col">
        <MDXEditor
          ref={editorRef}
          className="mdx-rich-editor mdxeditor-full-height"
          contentEditableClassName="prose prose-neutral dark:prose-invert prose-sm leading-relaxed max-w-3xl mx-auto"
          markdown={content}
          onChange={handleChange}
          onError={handleError}
          plugins={plugins}
          // Match the conventions agents use so a rich-mode save rewrites as
          // little formatting as possible (mdast defaults are `*` bullets and
          // `***` rules).
          toMarkdownOptions={{ bullet: "-", rule: "-" }}
          readOnly={isSaving}
        />
      </div>
    </div>
  )
}
