import { defineHandler } from 'nitro'

export default defineHandler(() => Response.json({ ok: true, service: 'private-skills-marketing' }))
