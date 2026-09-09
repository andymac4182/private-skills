import { defineHandler } from 'nitro';
export default defineHandler(() => Response.json({ ok: true, service: 'private-skills', version: '0.1.0' }));
