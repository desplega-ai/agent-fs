/** Route templates from App.tsx. Keep in sync when routes change. */
const DRIVE_VIEWS: [string, boolean][] = [
  ["file", true],
  ["detail", true],
  ["page", true],
  ["sql", false],
  ["members", false],
  ["shares", false],
  ["webhooks", false],
]

/** Both address forms of each drive view; the ID form first, as a name form matches it too. */
const DRIVE_TEMPLATES: [RegExp, string][] = DRIVE_VIEWS.flatMap(([view, withPath]): [RegExp, string][] => {
  const rest = withPath ? "(\\/.*)?" : "\\/?"
  const tail = withPath ? "/*" : ""
  return [
    [new RegExp(`^\\/${view}\\/~\\/[^/]+\\/[^/]+${rest}$`), `/${view}/~/:orgId/:driveId${tail}`],
    [new RegExp(`^\\/${view}\\/[^/]+\\/[^/]+${rest}$`), `/${view}/:orgName/:driveName${tail}`],
  ]
})

export const ROUTE_TEMPLATES: [RegExp, string][] = [
  [/^\/credentials\/?$/, "/credentials"],
  [/^\/files\/?$/, "/files"],
  [/^\/orgs\/[^/]+\/files(\/.*)?$/, "/orgs/:orgId/files/*"],
  ...DRIVE_TEMPLATES,
  [/^\/invite\/?$/, "/invite"],
  [/^\/invite\/[^/]+\/?$/, "/invite/:token"],
  [/^\/?$/, "/"],
]

/** Map a concrete path to its route template; unknown paths become "other". */
export function routeTemplate(pathname: string): string {
  for (const [pattern, template] of ROUTE_TEMPLATES) {
    if (pattern.test(pathname)) return template
  }
  return "other"
}
