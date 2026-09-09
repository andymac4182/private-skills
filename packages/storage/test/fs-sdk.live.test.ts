import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeFilesSdkBlobStore } from "../src/node.js";

const enabled = process.env.FILES_SDK_LIVE === "1";

describe.skipIf(!enabled)("Files SDK fs adapter round trip", () => {
  it("stores and retrieves an exact sealed object", async () => {
    const root = await mkdtemp(join(tmpdir(), "private-skills-storage-"));
    try {
      const store = await createNodeFilesSdkBlobStore({
        provider: "fs",
        root,
        prefix: "sealed",
      });
      const bytes = new TextEncoder().encode("real files-sdk fs adapter");
      const stored = await store.put(bytes);
      expect(await store.getVerified(stored.key, stored.digest)).toEqual(bytes);
      await store.remove(stored.key);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
