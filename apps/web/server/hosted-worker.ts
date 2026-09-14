/**
 * Queue-producing registry routes that need a best-effort hosted-worker drain.
 * Keep source resolution exact: a successful queued resolve must start its
 * import, while similarly named paths must not trigger worker execution.
 */
export function shouldDrainHostedWorker(request: Request, response: Response): boolean {
  const path = new URL(request.url).pathname;
  return (response.status === 201 || response.status === 202) && request.method === 'POST' &&
    (path === '/v1/publish' || path === '/v1/imports' || path === '/v1/directory/import' || path === '/v1/proxy/resolve' ||
      path === '/v1/feeds/skills/import' || /^\/v1\/sources\/[^/]+\/resolve$/.test(path) ||
      /^\/v1\/skills\/[^/]+\/rescan$/.test(path) || /^\/v1\/drafts\/[^/]+\/publish$/.test(path));
}
