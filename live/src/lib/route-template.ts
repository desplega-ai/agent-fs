/** Route templates from App.tsx. Keep in sync when routes change. */
export const ROUTE_TEMPLATES: [RegExp, string][] = [
  [/^\/credentials\/?$/, "/credentials"],
  [/^\/files\/?$/, "/files"],
  [/^\/orgs\/[^/]+\/files(\/.*)?$/, "/orgs/:orgId/files/*"],
  [/^\/file\/~\/[^/]+\/[^/]+(\/.*)?$/, "/file/~/:orgId/:driveId/*"],
  [/^\/detail\/~\/[^/]+\/[^/]+(\/.*)?$/, "/detail/~/:orgId/:driveId/*"],
  [/^\/sql\/~\/[^/]+\/[^/]+\/?$/, "/sql/~/:orgId/:driveId"],
  [/^\/members\/~\/[^/]+\/[^/]+\/?$/, "/members/~/:orgId/:driveId"],
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
