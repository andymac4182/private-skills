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
