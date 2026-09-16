import { describe, expect, it } from "vitest";
import type {
  BlobStore,
  Digest,
  RecoverableBlobStore,
  StorageObjectInspection,
  StoredBlob,
} from "../../contracts/src/index.js";
import {
  HttpBlobStore,
  createBlobGatewayHandler,
  digestBytes,
} from "../src/index.js";

class MemoryBlobStore implements RecoverableBlobStore {
  readonly objects = new Map<string, Uint8Array>();
  private sequence = 0;

  allocateObjectKey(): string {
    return `sealed/${String(++this.sequence).padStart(48, "0")}`;
  }

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const key = `sealed/${++this.sequence}`;
    const copy = new Uint8Array(bytes);
    this.objects.set(key, copy);
    return { key, digest: await digestBytes(copy), size: copy.byteLength };
  }

  async putAtKey(key: string, bytes: Uint8Array): Promise<StoredBlob> {
    const existing = await this.inspectObject(key);
    const copy = new Uint8Array(bytes);
    const digest = await digestBytes(copy);
    if (existing.state === "present") {
      if (existing.digest !== digest || existing.size !== copy.byteLength) throw new Error("stable key conflict");
      return { key, digest, size: copy.byteLength };
    }
    if (existing.state === "unknown") throw new Error("stable key unknown");
    this.objects.set(key, copy);
    return { key, digest, size: copy.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("not found");
    return new Uint8Array(bytes);
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async inspectObject(key: string): Promise<StorageObjectInspection> {
    const bytes = this.objects.get(key);
    if (!bytes) return { state: "absent", key };
    return { state: "present", key, digest: await digestBytes(bytes), size: bytes.byteLength };
  }
}

function gatewayFetch(
  handler: (request: Request) => Promise<Response>
): typeof fetch {
  return async (input, init) =>
    handler(new Request(input, init));
}

describe("private blob HTTP gateway", () => {
  it("keeps gateway finality unknown unless the host supplies a terminal proof", async () => {
    const defaultClient = new HttpBlobStore({ baseUrl: "https://gateway.example" });
    await expect(defaultClient.confirmWriteTerminated("sealed/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).resolves.toBe(false);

    const verifiedClient = new HttpBlobStore({
      baseUrl: "https://gateway.example",
      confirmWriteTerminated: async () => true,
    });
    await expect(verifiedClient.confirmWriteTerminated("sealed/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).resolves.toBe(true);
  });

  it("requires the dedicated gateway token and round-trips exact bytes", async () => {
    const store = new MemoryBlobStore();
    const handler = createBlobGatewayHandler({
      baseOrigin: "https://gateway.example",
      store,
      authorize: (request) =>
        request.headers.get("authorization") === "Bearer gateway-token",
    });
    const unauthenticated = await handler(
      new Request("https://gateway.example/internal/blobs", { method: "POST" })
    );
    expect(unauthenticated.status).toBe(401);

    const client = new HttpBlobStore({
      baseUrl: "https://gateway.example",
      token: "gateway-token",
      fetch: gatewayFetch(handler),
    });
    const bytes = new TextEncoder().encode("private exact bytes");
    const stored = await client.put(bytes);
    expect(stored.size).toBe(bytes.byteLength);
    expect(await client.getVerified(stored.key, stored.digest)).toEqual(bytes);
    await client.remove(stored.key);
    await expect(client.get(stored.key)).rejects.toThrow(/HTTP 502|HTTP 404/u);
  });

  it("pins HTTPS origins and permits loopback HTTP only when enabled", () => {
    expect(
      () => new HttpBlobStore({ baseUrl: "http://gateway.example" })
    ).toThrow(/HTTPS/u);
    expect(
      () =>
        new HttpBlobStore({
          baseUrl: "http://127.0.0.1:8787",
          allowLoopback: true,
        })
    ).not.toThrow();
  });

  it("uses portable manual redirects and rejects every 3xx response", async () => {
    const redirects: RequestRedirect[] = [];
    const client = new HttpBlobStore({
      baseUrl: "https://gateway.example",
      fetch: async (_input, init) => {
        redirects.push(init?.redirect ?? "follow");
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example/internal/blobs" },
        });
      },
    });

    await expect(client.put(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      status: 502,
    });
    expect(redirects).toEqual(["manual"]);
  });

  it("preserves the global receiver for receiver-sensitive fetch hosts", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const strictFetch: typeof fetch = function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit
    ): Promise<Response> {
      if (this !== globalThis) {
        throw new Error("fetch receiver was not globalThis");
      }
      return Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: {
            "content-length": String(bytes.byteLength),
          },
        })
      );
    };
    const client = new HttpBlobStore({
      baseUrl: "https://gateway.example",
      fetch: strictFetch,
    });

    await expect(client.get("sealed/receiver-test")).resolves.toEqual(bytes);
  });

  it("bounds streamed gateway request bodies before storage", async () => {
    const handler = createBlobGatewayHandler({
      baseOrigin: "https://gateway.example",
      maxBodyBytes: 4,
      store: new MemoryBlobStore(),
      authorize: () => true,
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    const response = await handler(
      new Request("https://gateway.example/internal/blobs", {
        method: "POST",
        body,
        // Node's Request requires this opt-in for a streaming request body.
        duplex: "half",
      } as RequestInit & { duplex: "half" })
    );
    expect(response.status).toBe(413);
  });

  it("rejects unsafe encoded keys before calling the backing store", async () => {
    const store = new MemoryBlobStore();
    const handler = createBlobGatewayHandler({
      baseOrigin: "https://gateway.example",
      store,
      authorize: () => true,
    });
    const response = await handler(
      new Request(
        "https://gateway.example/internal/blobs/%2e%2e%2foutside",
        { headers: { authorization: "Bearer gateway-token" } }
      )
    );
    expect(response.status).toBe(400);
    expect(store.objects.size).toBe(0);
  });

  it("round-trips a preallocated stable key through the private gateway", async () => {
    const store = new MemoryBlobStore();
    const handler = createBlobGatewayHandler({
      baseOrigin: "https://gateway.example",
      store,
      authorize: () => true,
    });
    const client = new HttpBlobStore({
      baseUrl: "https://gateway.example",
      fetch: gatewayFetch(handler),
    });
    const key = client.allocateObjectKey();
    const bytes = new TextEncoder().encode("stable gateway bytes");

    await expect(client.putAtKey(key, bytes)).resolves.toEqual({
      key,
      digest: await digestBytes(bytes),
      size: bytes.byteLength,
    });
    await expect(client.putAtKey(key, bytes)).resolves.toEqual({
      key,
      digest: await digestBytes(bytes),
      size: bytes.byteLength,
    });
    await expect(client.inspectObject("sealed/missing")).resolves.toEqual({
      state: "absent",
      key: "sealed/missing",
    });
  });
});
