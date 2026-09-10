import { describe, expect, it } from 'vitest'
import { quotePosix, quotePowerShell } from './shell'

describe('shell argument quoting', () => {
  it('keeps metacharacters and embedded quotes inside one POSIX argument', () => {
    const value = "owner/repo/skill$(touch /tmp/pwned)'"
    expect(quotePosix(value)).toBe("'owner/repo/skill$(touch /tmp/pwned)'\\'''")
  })

  it('uses PowerShell single-quote escaping for one literal argument', () => {
    expect(quotePowerShell("owner/repo/skill'$(Write-Host pwned)")).toBe("'owner/repo/skill''$(Write-Host pwned)'")
  })
})
