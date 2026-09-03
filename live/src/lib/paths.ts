/**
 * Drive-relative path helpers shared by the create / upload / rename flows.
 * Paths are stored without leading or trailing slashes. The drive root is "".
 */

/** Strip leading and trailing slashes. */
export function cleanPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "")
}

/** Parent folder of a path ("" for a top-level entry). */
export function parentOf(path: string): string {
  const clean = cleanPath(path)
  const idx = clean.lastIndexOf("/")
  return idx === -1 ? "" : clean.slice(0, idx)
}

/** Last path segment. */
export function basenameOf(path: string): string {
  const clean = cleanPath(path)
  const idx = clean.lastIndexOf("/")
  return idx === -1 ? clean : clean.slice(idx + 1)
}

/** Join a folder and a relative path, tolerating empty parts and stray slashes. */
export function joinPath(folder: string, relative: string): string {
  const a = cleanPath(folder)
  const b = cleanPath(relative)
  if (!a) return b
  if (!b) return a
  return `${a}/${b}`
}

/**
 * Normalize user-typed relative input such as ` sub//dir/name.md `. Returns
 * an error message instead of a path when the input is empty or escapes the
 * base folder.
 */
export function normalizeRelativePath(input: string): { path: string } | { error: string } {
  const segments = input
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (segments.length === 0) return { error: "Enter a name." }
  if (segments.some((s) => s === "." || s === "..")) {
    return { error: "Paths cannot contain . or .. segments." }
  }
  return { path: segments.join("/") }
}

/**
 * Every folder listing from the drive root ("") down to the immediate parent
 * of `path`. Writing `a/b/c.md` returns `["", "a", "a/b"]`: each of those
 * listings may need to show a folder that did not exist before.
 */
export function ancestorListings(path: string): string[] {
  const parent = parentOf(path)
  const chain = [""]
  if (!parent) return chain
  let acc = ""
  for (const seg of parent.split("/")) {
    acc = acc ? `${acc}/${seg}` : seg
    chain.push(acc)
  }
  return chain
}
