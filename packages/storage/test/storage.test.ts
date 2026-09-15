import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  BundleValidationError,
  FilesSdkBlobStore,
  MAX_FILE_BYTES,
  decodeBundle,
  digestBytes,
  encodeBundle,
  parseSkillMetadata,
  validateBundle,
} from "../src/index.js";

class InMemoryFilesClient {
  readonly objects = new Map<string, Uint8Array>();
  readonly uploads: Array<{ key: string; options?: Record<string, unknown> }> = [];

  async upload(key: string, body: Uint8Array, options?: Record<string, unknown>): Promise<void> {
    this.uploads.push({ key, options });
    if (this.objects.has(key)) throw new Error("overwrite");
    this.objects.set(key, new Uint8Array(body));
  }

  async download(key: string): Promise<{ size: number; arrayBuffer: () => Promise<ArrayBuffer> }> {
    const body = this.objects.get(key);
    if (!body) throw new Error("not found");
    return {
      size: body.byteLength,
      arrayBuffer: async () => body.slice().buffer,
    };
  }

  async head(key: string): Promise<{ size: number }> {
    const body = this.objects.get(key);
    if (!body) throw new Error("not found");
    return { size: body.byteLength };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const toBase64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const zeroBytesToBase64 = (byteLength: number): string => {
  const bytes = new Uint8Array(byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize)
    );
  }
  return btoa(binary);
};

const skill = (frontmatter = "name: hello-world\ndescription: A safe skill"): {
  format: "pskills-bundle-v1";
  files: { path: string; content: string }[];
} => {
  return {
    format: "pskills-bundle-v1",
    files: [
      { path: "z.txt", content: toBase64("last") },
      {
        path: "SKILL.md",
        content: toBase64(`---\n${frontmatter}\n---\n\nUse this skill.`),
      },
    ],
  };
};

describe("canonical skill bundles", () => {
  it("sorts file entries and fixes property order", async () => {
    const first = encodeBundle(skill());
    const second = encodeBundle({
      format: "pskills-bundle-v1",
      files: [...skill().files].reverse(),
    });
    expect([...first]).toEqual([...second]);
    expect(decodeBundle(first).files[0]?.path).toBe("SKILL.md");
    expect(await digestBytes(first)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("keeps canonical base64 bytes, including binary assets", () => {
    const bundle = {
      format: "pskills-bundle-v1" as const,
      files: [{ path: "asset.bin", content: "AP+A/w==" }],
    };
    expect(validateBundle(bundle)).toEqual(bundle);
    expect(() =>
      validateBundle({
        format: "pskills-bundle-v1",
        files: [{ path: "asset.bin", content: "not utf8 text" }],
      })
    ).toThrow(/base64/u);
    expect(() =>
      validateBundle({
        format: "pskills-bundle-v1",
        files: [{ path: "asset.bin", content: "Zh==" }],
      })
    ).toThrow(/base64/u);
  });

  it("validates a 3.5 MiB base64 file linearly and rejects bad padding", () => {
    const content = zeroBytesToBase64(3.5 * 1024 * 1024);
    expect(content.length).toBe(4_893_356);
    expect(
      validateBundle({
        format: "pskills-bundle-v1",
        files: [{ path: "asset.bin", content }],
      }).files[0]?.content
    ).toBe(content);

    // The final quartet for an all-zero file is AA==. These variants retain
    // the large input size while exercising padding placement and pad bits.
    expect(() =>
      validateBundle({
        format: "pskills-bundle-v1",
        files: [{ path: "asset.bin", content: `${content.slice(0, -2)}=A` }],
      })
    ).toThrow(/base64/u);
    expect(() =>
      validateBundle({
        format: "pskills-bundle-v1",
        files: [{ path: "asset.bin", content: `${content.slice(0, -3)}B==` }],
      })
    ).toThrow(/base64/u);
  });

  it("accepts a file at the supported 10 MiB decoded limit", () => {
    const content = zeroBytesToBase64(MAX_FILE_BYTES);
    expect(content.length).toBe(13_981_016);
    expect(() =>
      validateBundle({
        format: "pskills-bundle-v1",
        files: [{ path: "asset.bin", content }],
      })
    ).not.toThrow();
  });

  it("matches the frozen base64 protocol vector", async () => {
    const content =
      "LS0tCm5hbWU6IGhlbGxvCmRlc2NyaXB0aW9uOiBBIGhhcm1sZXNzIGV4YW1wbGUgc2tpbGwgZm9yIHJlZ2lzdHJ5IHZlcmlmaWNhdGlvbi4KLS0tCgojIEhlbGxvCgpVc2UgdGhpcyBza2lsbCB0byBncmVldCB0aGUgdXNlciB3aXRoIGEgc2hvcnQgZnJpZW5kbHkgbWVzc2FnZS4K";
    const bytes = encodeBundle({
      format: "pskills-bundle-v1",
      files: [{ path: "SKILL.md", content }],
    });
    expect(new TextDecoder().decode(bytes)).toBe(
      `{"format":"pskills-bundle-v1","files":[{"path":"SKILL.md","content":"${content}"}]}`
    );
    expect(await digestBytes(bytes)).toBe(
      "sha256:889118ca6b91622b659ad5f157391c334427f24077c04f71164212667938deff"
    );
    expect(parseSkillMetadata(decodeBundle(bytes))).toMatchObject({
      skillName: "hello",
      description: "A harmless example skill for registry verification.",
    });
  });

  it("rejects non-canonical JSON ordering on decode", () => {
    const bytes = new TextEncoder().encode(
      '{"format":"pskills-bundle-v1","files":[{"content":"YQ==","path":"a.txt"}]}'
    );
    expect(() => decodeBundle(bytes)).toThrow(/canonical/u);
  });

  it("rejects traversal, aliases, and unsafe Windows names", () => {
    for (const path of ["../x", "a/../../x", "a\\b", "CON", "a/.", "a//b"]) {
      expect(() => validateBundle({ ...skill(), files: [{ path, content: "x" }] })).toThrow(
        BundleValidationError
      );
    }
    expect(() =>
      validateBundle({
        format: "pskills-bundle-v1",
        files: [
          { path: "e\u0301.txt", content: "x" },
          { path: "é.txt", content: "x" },
        ],
      })
    ).toThrow(BundleValidationError);
  });

  it("parses standard metadata and denies plugin execution payloads", () => {
    expect(parseSkillMetadata(skill())).toMatchObject({
      skillName: "hello-world",
      description: "A safe skill",
    });
    expect(() =>
      parseSkillMetadata(skill("name: hello\ndescription: safe\nplugins: true"))
    ).toThrow(/plugin/u);
    expect(() =>
      parseSkillMetadata(skill("name: Invalid\ndescription: safe"))
    ).toThrow(/name/u);
    expect(() =>
      validateBundle({
        format: "pskills-bundle-v1",
        files: [{ path: ".claude-plugin/plugin.json", content: "{}" }],
      })
    ).toThrow(/plugin/u);
    expect(() =>
      validateBundle({
        format: "pskills-bundle-v1",
        files: [{ path: ".mcp.json", content: "e30=" }],
      })
    ).toThrow(/plugin/u);
    expect(() =>
      parseSkillMetadata(skill('name: hello\ndescription: "\\u0000"'))
    ).toThrow(/control|unsafe/u);
  });

  it("accepts standard Agent Skills block scalars and metadata maps", async () => {
    const fixture = await readFile(
      new URL("./fixtures/standard-skill.md", import.meta.url),
      "utf8"
    );
    const metadata = parseSkillMetadata({
      format: "pskills-bundle-v1",
      files: [{ path: "SKILL.md", content: toBase64(fixture) }],
    });

    expect(metadata.skillName).toBe("standard-multiline");
    expect(metadata.description).toBe(
      "Create and update project files safely.\n\nUse this skill when a task needs the repository workflow.\n"
    );
    expect(metadata.frontmatter.compatibility).toBe(
      "Requires a standard Agent Skills host with repository file access."
    );
    expect(metadata.frontmatter["allowed-tools"]).toBe(
      "Bash(git:*) Bash(rg:*)"
    );
    expect(metadata.frontmatter.metadata).toMatchObject({
      author: "Example Team",
      license: "Apache-2.0",
      version: "1.0",
    });
  });

  it("accepts bounded structured extension frontmatter without rewriting the bundle", () => {
    const source = [
      "name: twitter-automation",
      "description: Automate bounded Twitter workflows",
      "version: 1.0",
      "tags:",
      "  - twitter",
      "  - automation",
      "routing:",
      "  category: social",
      "  triggers:",
      "    - tweet",
      "    - x",
      "  enabled: false",
    ].join("\n");
    const bundle = skill(source);
    const original = JSON.stringify(bundle);

    const metadata = parseSkillMetadata(bundle);

    expect(metadata.frontmatter.version).toBe(1);
    expect(metadata.frontmatter.tags).toEqual(["twitter", "automation"]);
    expect(metadata.frontmatter.routing).toMatchObject({
      category: "social",
      triggers: ["tweet", "x"],
      enabled: false,
    });
    expect(JSON.stringify(bundle)).toBe(original);
  });

  it("keeps known fields scalar and rejects malformed structured extensions", () => {
    const rejected = [
      "name: [hello]\ndescription: safe",
      "name: hello\ndescription:\n  text: safe",
      "name: hello\ndescription: safe\nlicense:\n  - Apache-2.0",
      "name: hello\ndescription: safe\ntags:\n  - null",
      "name: hello\ndescription: safe\nrouting:\n  plugins: enabled",
      "name: hello\ndescription: safe\ntags: &labels [one]\nother: *labels",
    ];
    for (const frontmatter of rejected) {
      expect(() => parseSkillMetadata(skill(frontmatter))).toThrow(
        /frontmatter|plugin|unsafe|scalar|alias|anchor/u,
      );
    }
  });

  it("accepts bounded OpenClaw metadata in a canonical bundle", () => {
    const source = [
      "name: openclaw-fixture",
      "description: A bounded OpenClaw fixture",
      "metadata:",
      "  openclaw:",
      "    primaryEnv: DEMO_TOKEN",
      "    requires:",
      "      env:",
      "        - DEMO_TOKEN",
      "      bins:",
      "        - node",
      "    nested:",
      "      enabled: true",
    ].join("\n");
    const canonical = encodeBundle(skill(source));
    const metadata = parseSkillMetadata(decodeBundle(canonical));
    expect(metadata).toMatchObject({
      skillName: "openclaw-fixture",
      description: "A bounded OpenClaw fixture",
    });
    expect(metadata.frontmatter.metadata).toMatchObject({
      openclaw: {
        primaryEnv: "DEMO_TOKEN",
        requires: { env: ["DEMO_TOKEN"], bins: ["node"] },
        nested: { enabled: true },
      },
    });
  });

  it("keeps OpenClaw nested metadata inert and bounded", () => {
    expect(() => parseSkillMetadata(skill([
      "name: openclaw-fixture",
      "description: safe",
      "metadata:",
      "  openclaw:",
      "    hooks:",
      "      - run",
    ].join("\n")))).toThrow(/unsafe|blocked|hook/u);
    expect(() => parseSkillMetadata(skill([
      "name: openclaw-fixture",
      "description: safe",
      "metadata:",
      "  openclaw:",
      "    requires: &requires",
      "      env: [DEMO_TOKEN]",
      "    duplicate: *requires",
    ].join("\n")))).toThrow(/alias|anchor|unsafe/u);
  });

  it("rejects nested executable shapes and YAML object features", () => {
    const rejected = [
      "name: hello\ndescription: safe\nmetadata:\n  plugins: enabled",
      "name: hello\ndescription: safe\nmetadata:\n  owner:\n    name: team",
      "name: hello\ndescription: safe\nmetadata:\n  count: 1",
      "name: hello\ndescription: &description safe",
      "name: hello\ndescription: *description",
      "name: hello\ndescription: !!str safe",
      "name: hello\ndescription: safe\nmetadata:\n  - author",
    ];
    for (const frontmatter of rejected) {
      expect(() => parseSkillMetadata(skill(frontmatter))).toThrow(
        /frontmatter|plugin|unsafe|scalar/u
      );
    }
  });

  it("retains duplicate-key and frontmatter bounds checks", () => {
    expect(() =>
      parseSkillMetadata(
        skill("name: hello\ndescription: safe\nName: duplicate")
      )
    ).toThrow(/duplicate|frontmatter/u);
    const tooLarge = "name: hello\ndescription: |\n  " + "x".repeat(130_000);
    expect(() => parseSkillMetadata(skill(tooLarge))).toThrow(/limit|frontmatter/u);
  });
});

describe("Files SDK BlobStore boundary", () => {
  it("uses fresh keys, round-trips bytes, and detects tampering", async () => {
    const client = new InMemoryFilesClient();
    const store = new FilesSdkBlobStore({ client, prefix: "private" });
    const bytes = new TextEncoder().encode("sealed bytes");
    const first = await store.put(bytes);
    const second = await store.put(bytes);
    expect(first.key).not.toBe(second.key);
    expect(await store.get(first.key)).toEqual(bytes);

    client.objects.set(first.key, new TextEncoder().encode("tampered"));
    await expect(store.get(first.key)).rejects.toThrow(/digest/u);
  });

  it("enforces the configured maximum before upload", async () => {
    const client = new InMemoryFilesClient();
    const store = new FilesSdkBlobStore({ client, maxBytes: 2 });
    await expect(store.put(new Uint8Array([1, 2, 3]))).rejects.toThrow(/limit/u);
    expect(client.objects.size).toBe(0);
  });

  it("persists the stable key before an ambiguous upload and makes a retry idempotent", async () => {
    class PutThenThrowsClient extends InMemoryFilesClient {
      failOnce = true;

      override async upload(key: string, body: Uint8Array, options?: Record<string, unknown>): Promise<void> {
        await super.upload(key, body, options);
        if (this.failOnce) {
          this.failOnce = false;
          throw new Error("provider response lost after write");
        }
      }
    }
    const client = new PutThenThrowsClient();
    const store = new FilesSdkBlobStore({ client, prefix: "private" });
    const key = store.allocateObjectKey();
    const bytes = new TextEncoder().encode("ambiguous upload");

    await expect(store.putAtKey(key, bytes)).rejects.toThrow(/response lost/u);
    await expect(store.inspectObject(key)).resolves.toMatchObject({
      state: "present",
      key,
      size: bytes.byteLength,
    });
    await expect(store.putAtKey(key, bytes)).resolves.toEqual({
      key,
      digest: await digestBytes(bytes),
      size: bytes.byteLength,
    });
    expect(client.uploads).toHaveLength(1);
  });

  it("keeps an unknown provider read distinct from confirmed absence", async () => {
    const client = new InMemoryFilesClient();
    client.head = async () => { throw new Error("provider timeout"); };
    const store = new FilesSdkBlobStore({ client });

    await expect(store.inspectObject("sealed/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).resolves.toEqual({
      state: "unknown",
      key: "sealed/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      reason: "provider-error",
    });
  });
});
