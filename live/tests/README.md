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
Screenshots are written to `test-results/`.
`invite.spec.ts` runs against an in-memory org (`tests/support/invite-fixture.ts`) served to several
browser contexts at once. It covers the Invite dialog,
pending invites, and the `/invite/:token` accept page: an admin invites a new email to two of three
drives, a fresh context registers through the link and sees exactly those two drives, and expired
and revoked links show the same message.
