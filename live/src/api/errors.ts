export function isUnknownOperationError(error: unknown, op: string): boolean {
  if (!(error instanceof Error)) return false
  return error.message === `Unknown operation: ${op}`
}
