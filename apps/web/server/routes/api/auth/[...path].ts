import { defineHandler } from 'nitro';
import { handleRegistryRequest } from '../../../runtime';

export default defineHandler(event => {
  const context = event.context as { cloudflare?: { env?: Record<string, string | undefined> } };
  return handleRegistryRequest(event.req, context.cloudflare?.env);
});
