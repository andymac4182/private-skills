# OpenClaw feed adapter

This package contains the dependency-free schema-v1 OpenClaw hosted-feed
adapter used by future Nitro/core integration. The wire contract is pinned to
the ClawHub `openclaw/clawhub` commit
`694ff719e9b161ea770fe2abfdc43f2ff5401fe4`; the hosted-feed specification
blob is `9c1cd5c2d67b598bc470e0044713ecfc9725df1c`.
The GitHub-backed skills specification blob at the same revision is
`33f89b51815b4b6a188f2dc6a3e83afcb2835585`.

It validates and deterministically serializes the exact v1 envelope, retains
public ClawHub versus public GitHub source identity, verifies declared
artifact/content digests, and provides a bounded HTTPS conditional-fetch cache
with last-known-good fallback. The tenant preview producer is private by
default and does not publish, authenticate, execute, or persist anything.

The package never treats a Private Skills `pskills-bundle-v1` digest as a
ClawHub artifact digest. A future admission adapter must package or transfer
the selected source through its own canonical bundle path and keep the two
digests separate. Current ClawHub v1 feeds are unsigned; this package does not
invent signatures or bootstrap a trust key from a feed.

## Current ClawHub skills-feed compatibility

The pinned RFC specifies `clawhub-official` and a 24-hour expiry horizon. The
observed producer schema and skills route at
`openclaw/clawhub@694ff719e9b161ea770fe2abfdc43f2ff5401fe4` use
`clawhub-official-skills`, while its publish workflow advertises a seven-day
wire expiry. The deployed public response also appends `-gzip` to the
digest-derived ETag for its compressed representation. These are separate
producer and CDN behaviors; the strict RFC profile remains unchanged.

`clawhub-live-skills-694ff719` is an explicit, server-selected compatibility
profile for this exact drift. It is bound to
`https://clawhub.ai/api/v1/feeds/skills` and the exact
`clawhub-official-skills` identity. It accepts only
`"sha256:<body-digest>-gzip"` or `W/"sha256:<body-digest>-gzip"` in addition to
the pinned ETag, verifies the body digest independently, checks a present
`X-Content-SHA256`, and caps the wire expiry at seven days. Local validity
still ends at the earlier of the declared expiry, `generatedAt + 24 hours`,
and the configured cache freshness. Internal snapshots retain the canonical
body ETag `"sha256:<body-digest>`, never the CDN validator.

The profile is omitted by default and is intentionally not an alias for
`clawhub-official` or a generic ETag relaxation. Re-review it when the upstream
spec and producer are reconciled.

The Node runtime selects this profile only when the server environment sets
`PSKILLS_OPENCLAW_TRUSTED_FEED_COMPATIBILITY=clawhub-live-skills-694ff719`
together with the exact URL and `PSKILLS_OPENCLAW_TRUSTED_FEED_ID=clawhub-official-skills`.
Invalid combinations disable the trusted-feed consumer; they do not fall back
to an unpinned URL or identity.

Primary references:

- [hosted-feed RFC at the pinned commit](https://github.com/openclaw/clawhub/blob/694ff719e9b161ea770fe2abfdc43f2ff5401fe4/specs/hosted-catalog-feed.md)
- [upstream skills-feed schema constant](https://github.com/openclaw/clawhub/blob/694ff719e9b161ea770fe2abfdc43f2ff5401fe4/packages/schema/src/catalogFeed.ts)
- [upstream skills-feed HTTP route](https://github.com/openclaw/clawhub/blob/694ff719e9b161ea770fe2abfdc43f2ff5401fe4/convex/httpApiV1/catalogFeedV1.ts)
