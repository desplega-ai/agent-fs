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
Screenshots are written to `test-results/`.
