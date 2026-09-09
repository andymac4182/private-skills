import { defineHandler } from 'nitro';
import { SERVICE_VERSION } from '../../../../packages/contracts/src/version';

export default defineHandler(() => Response.json({ ok: true, service: 'private-skills', version: SERVICE_VERSION }));
