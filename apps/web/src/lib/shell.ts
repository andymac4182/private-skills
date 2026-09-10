/** Quote one arbitrary value as one literal POSIX shell argument. */
export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Quote one arbitrary value as one literal PowerShell argument. */
export function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
