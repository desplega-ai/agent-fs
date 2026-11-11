# Viewer browser regression tests

From `live/`:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm test:e2e
```

The tests serve the production build and intercept API requests with local fixtures.
They never connect to a live account. Monaco assets are served from the installed
package instead of the CDN. To use a preinstalled Chromium, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable.

Coverage: document/pane widths at 360, 390 and 768 px, independent table and fenced
code scrolling, table-row comment controls, and wrapping of long raw preview lines.
`presence.spec.ts` mocks the drive event stream (`/events?presence=1`) to cover the
presence avatars, the See cursors / See selections toggles, comment-card presence,
and the absence of presence requests on servers without the `presence` feature.
`viewer-header.spec.ts` checks that the file header's status badge and comment count never overlap the action icons at 390x844 and 360x740, and that the 1280 px header keeps the badge.
`full-page.spec.ts` checks that `/page/~/...` presents an HTML file (in the same sandbox as the file view) or a Markdown file alone at 1280x844 and 390x844: no sidebar, header, file tabs or star nudge, with the comments rail (`]`, the collapsed rail's button) on desktop and the floating comments toggle on a phone. A selection in the presented Markdown takes a comment, a presented HTML page gets the server's comment overlay and lists its comments, other files get a message, and Back to file (also for a name with `#`, `?` and `%`) lands on the file view. It also covers the signed-out redirect, and that Present (the button next to Open full page in the file view, the detail toolbar's, and `P`) is offered for Markdown and, on servers with `html-sites`, HTML, lands on the presented page with the browser full screen in the same tab, and that leaving it gives the screen back.
`markdown-edit.spec.ts` opens a long markdown file with `<slug>`-style placeholders in the rich editor: no parse error, placeholders stay text, the document scrolls with the wheel and the keyboard in rich and source mode while the edit toolbar stays in view, a save with no edits writes nothing, and an edit saves the placeholders unchanged.
`tree-reveal.spec.ts` opens a deep link into a drive with 240 previously expanded folders whose listings land slowly and out of order: the sidebar never paints blank, the target row and the row at the top hold still while those listings land, every row is 28 px, and fewer than 80 rows are mounted. A scroll away from the target while those listings land stays where the user put it, and collapsing a folder far above the viewport at the bottom of the sidebar leaves every visible row in place.
`credentials-prefill.spec.ts` checks that `/credentials?apiUrl=&apiKey=` only pre-fills the Connect form: the saved and active credentials stay as they were and no request goes to the new endpoint until Connect is clicked.
Screenshots are written to `test-results/`.
`invite.spec.ts` runs against an in-memory org (`tests/support/invite-fixture.ts`) served to several
browser contexts at once. It covers the Invite dialog,
pending invites, and the `/invite/:token` accept page: an admin invites a new email to two of three
drives, a fresh context registers through the link and sees exactly those two drives, and expired
and revoked links show the same message.
`webhooks.spec.ts` runs the drive's Webhooks page against an in-memory fixture (`tests/support/webhooks-fixture.ts`): an org admin creates a hook and sees its signing secret once with copy, tests it, disables and enables it, rotates the secret, redelivers a failed delivery from the log and deletes the hook. After each secret dialog closes it checks that the secret is gone from the DOM, web storage and the console. It also covers a drive admin (no org hooks, no org scope), a member who is not an admin (no menu entry, no page, no list request) and a server that refuses the list. `pnpm test:webhooks` covers the same secret rule for the React Query cache.
