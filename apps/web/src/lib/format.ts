export function formatDate(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function formatBytes(size?: number) {
  if (size === undefined || !Number.isFinite(size)) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`
}

export function shortDigest(value?: string) {
  if (!value) return '—'
  return value.length > 24 ? `${value.slice(0, 16)}…${value.slice(-8)}` : value
}

export function titleCase(value: string) {
  return value.split(/[-_ ]+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

