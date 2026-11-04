# Pages

An HTML file in a drive is a **page**. When a signed-in member opens it in the web app, the page can learn who is viewing it, read files in its folder and save data files under `<its folder>/data/` as that member, after the member allows it once. This is enough for a task list with "done" buttons, a feedback form or a dashboard that keeps state.

The page never holds a credential. The web app frames it in a sandbox with an opaque origin and hands it a private channel (a `MessagePort`); every request runs in the web app with the member's own access, and the server checks the member's role as for any other request. A viewer-role member can read but not write.

## The API

Servers that list `page-bridge` in `/health` `features` add `window.agentfs` to a page the web app opens. The script goes right after the page's doctype (or at the very top when there is none), before anything of the page's own, so any inline script can use it and the page keeps its document mode:

```js
await agentfs.ready                  // resolves once the web app has answered the page
await agentfs.requestIdentity()      // { name, email, kind: "member" }, or null if the member keeps the page read-only
agentfs.me()                         // the last answer of requestIdentity(), synchronous
await agentfs.read(path)             // { content, version }: the whole text file, and the version of those bytes
await agentfs.stat(path)             // { version, size, modifiedAt }, or null when the file does not exist
await agentfs.write(path, content, { expectedVersion, message })   // { version }
```

Every call is refused until `ready` resolves. A failed call rejects with an `Error` whose `code` is the server's (`EDIT_CONFLICT`, `NOT_FOUND`, `VALIDATION_ERROR`, `PERMISSION_DENIED`), `CONFLICT` when a file kept changing while it was read, or `NOT_ALLOWED` when the web app refuses the request itself.

## Example: a task list

The page keeps its state in `data/state.json` next to it. A write names the version it read; a write with a stale `expectedVersion` fails with `EDIT_CONFLICT`, so the page reads again and retries. Every version stays in the file's history.

```html
<!doctype html>
<h1>Tasks</h1>
<p id="who"></p>
<ul id="tasks"></ul>
<script>
  const TASKS = ["Draft the brief", "Review the numbers", "Send the summary"]
  let state = { done: [] }
  let version = 0 // 0 = the file does not exist yet

  async function load() {
    if (!(await agentfs.stat("data/state.json"))) return
    const file = await agentfs.read("data/state.json")
    state = JSON.parse(file.content)
    version = file.version
  }

  function render() {
    const list = document.getElementById("tasks")
    list.replaceChildren(...TASKS.map((task, i) => {
      const item = document.createElement("li")
      const box = document.createElement("input")
      box.type = "checkbox"
      box.checked = state.done.includes(i)
      box.onchange = () => toggle(i)
      item.append(box, " ", task) // text, never innerHTML
      return item
    }))
  }

  async function toggle(i) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const done = state.done.includes(i) ? state.done.filter((d) => d !== i) : [...state.done, i]
      try {
        const saved = await agentfs.write("data/state.json", JSON.stringify({ done }), {
          expectedVersion: version,
          message: `Toggled: ${TASKS[i]}`,
        })
        state = { done }
        version = saved.version
        return render()
      } catch (err) {
        if (err.code !== "EDIT_CONFLICT") throw err
        await load() // someone else saved first: start from their state
      }
    }
    render()
  }

  agentfs.ready.then(async () => {
    const viewer = await agentfs.requestIdentity()
    document.getElementById("who").textContent = viewer ? `Signed in as ${viewer.name}` : "Read-only"
    await load()
    render()
  })
</script>
```

## Rules

- **Paths are relative to the page's folder**: `data/state.json`, `notes.md`. No leading `/`, no empty, `.` or `..` segments, no backslash or NUL, at most 512 characters. Paths are used as written; `%2e%2e` is a file name, not `..`.
- **Reads** see every file in the page's folder and below it, up to 1 MB per file, text only.
- **Writes** go only under `data/` in the page's folder, only to `json`, `txt`, `md`, `csv`, `yaml`, `yml` and `ndjson` files, at most 256 KB of UTF-8. A page cannot change itself, its scripts or anything outside `data/`.
- **`expectedVersion` is required** on every write: the `version` you read, or `0` to create a file. A stale version fails with `EDIT_CONFLICT`. Every write is a new version in the file's history, with the member as author and your `message`.
- At most 16 requests in flight and 2 MB per request (as JSON), enough for 256 KB of content however much of it JSON escapes.
- Pages at the drive root get no access: `requestIdentity()` answers `null` and `read`, `stat` and `write` fail with `NOT_ALLOWED`.

## Consent

`requestIdentity()` shows a banner above the page: "This page, and any page or script in `<folder>`, will know your name and email and can save data files under `<folder>/data/` as you, until you revoke it." **Allow** answers with the viewer and lets the page write; **Keep read-only** answers `null` and writes fail with `NOT_ALLOWED`. The choice to allow is remembered in that browser for the member's account, drive and folder, and a "Revoke" link above the page withdraws it from the next request on, in every open view. Reads need no consent. The consent covers the whole folder, so keep pages you did not write out of it.

## Data is untrusted input

Every member with write access who allowed a page in the folder can write its data files, and so can any member with write access through the CLI or API. Treat what a page reads back as untrusted: render it with `textContent` or `createTextNode`, never `innerHTML`, and validate its shape before you use it.

## Public viewers

A folder shared with `share-create <folder> --writable` (`writable: true` in the API; drive editors and admins only, not the drive root) gets a link at `/page/<token>/` instead of `/site/<token>/`. It opens a small host page on the API server that frames the folder's page (`index.html`, else its only page; `/page/<token>/<name>.html` for another page in the folder) and answers `window.agentfs` for people who are not signed in:

- **Identity.** The first `requestIdentity()` asks the viewer for a name and email in a dialog over the page and answers `{ name, email, kind: "guest" }`, or `null` when they cancel. The browser remembers them for that link only, for 180 days, in a cookie; a "Not you?" link on the page forgets them. A different link, or another browser, asks again. Revoking the link ends every remembered guest.
- **Attribution is self-reported.** Anyone can type any name and email; nothing is checked or looked up. A guest is not a member, even with a member's email.
- **Writes run as the person who created the link**, with their current role: if they lose write access to the drive, the link stops saving. The version's author is the creator and its message starts with the guest: `Guest David Example <david@example.com>: Done: task 1`.
- **Reads need no name**: `read` and `stat` work for anyone with the link, as the folder is public through it anyway. `write` fails with `NOT_ALLOWED` until the viewer has given a name.
- **Cookies are required.** A browser that blocks them is told so, and the page stays read-only.
- The rules above apply unchanged (paths, `data/`, extensions, 256 KB of UTF-8 content, `expectedVersion`); the request itself may be up to 2 MB, so content full of characters JSON escapes still fits.
- **Writes to one file run one at a time**, whichever link they come through, so two viewers who read the same version get one success and one `EDIT_CONFLICT`. At most 8 writes can be pending for one file and 16 for one link, whatever files they name; more fail at once with `NOT_ALLOWED` ("Too many pending writes, try again").
- **Each link saves at most 60 files a minute and 20 MB a day** (`NOT_ALLOWED` beyond).
- The queue and these budgets live in the server's memory: agent-fs runs as one process per deployment, and a restart resets the budgets.

Anyone with the link can save data files under `data/`, so share it only with people you would let edit them, and keep the expiry short.

## Where the API exists

- **In the web app**, for a signed-in member who opens the page.
- **Through a writable link** (`/page/<token>/`), for public viewers. See above.
- **Not when the page is opened directly** or through a plain share or site link: `window.agentfs` is then missing, or never becomes ready. Write pages that still render something useful read-only.
- **Links to other pages must open in a new tab** (`target="_blank"`). The sandbox does not let a page navigate the app itself, and a link that navigates the frame loses the channel: the next page gets no API.
