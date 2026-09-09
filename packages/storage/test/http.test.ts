import { describe, expect, it } from "vitest";
import type {
  BlobStore,
  Digest,
  StoredBlob,
} from "../../contracts/src/index.js";
import {
  HttpBlobStore,
  createBlobGatewayHandler,
  digestBytes,
} from "../src/index.js";

class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();
  private sequence = 0;

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const key = `sealed/${++this.sequence}`;
    const copy = new Uint8Array(bytes);
    this.objects.set(key, copy);
    return { key, digest: await digestBytes(copy), size: copy.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("not found");
    return new Uint8Array(bytes);
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function gatewayFetch(
  handler: (request: Request) => Promise<Response>
): typeof fetch {
  return async (input, init) =>
    handler(new Request(input, init));
}

describe("private blob HTTP gateway", () => {
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
});
