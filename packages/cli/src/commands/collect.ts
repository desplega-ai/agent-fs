export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
