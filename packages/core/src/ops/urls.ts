export function buildAppUrl(
  baseUrl: string,
  orgId: string,
  driveId: string,
  path: string
): string {
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  return `${baseUrl}/file/~/${orgId}/${driveId}/${cleanPath}`;
}
