import { describe, expect, test } from "bun:test";
import { ZoteroClient, type ZoteroClientEvent, type ZoteroItem } from "../client";

interface MockResponseConfig {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

function createResponse(config: MockResponseConfig): Response {
  const status = config.status ?? 200;
  const headers = new Headers(config.headers ?? {});

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const body =
    typeof config.body === "string" || config.body === undefined
      ? config.body
      : JSON.stringify(config.body);

  return new Response(body, { status, headers });
}

describe("ZoteroClient", () => {
  test("ping succeeds on 2xx response", async () => {
    const calls: string[] = [];

    const client = new ZoteroClient(
      { userId: "12345", apiKey: "secret", baseUrl: "https://api.test" },
      {
        fetchImpl: async (input) => {
          calls.push(String(input));
          return createResponse({ body: [] });
        },
        sleep: async () => {},
      },
    );

    await expect(client.ping()).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/users/12345/items");
    expect(calls[0]).toContain("limit=1");
  });

  test("getCollections returns key-name map", async () => {
    const client = new ZoteroClient(
      { userId: "12345", apiKey: "secret", baseUrl: "https://api.test" },
      {
        fetchImpl: async () =>
          createResponse({
            body: [
              { key: "AAA", data: { name: "Adaptogens" } },
              { key: "BBB", data: { name: "Clinical Trials" } },
            ],
          }),
        sleep: async () => {},
      },
    );

    const collections = await client.getCollections();

    expect(collections.get("AAA")).toBe("Adaptogens");
    expect(collections.get("BBB")).toBe("Clinical Trials");
    expect(collections.size).toBe(2);
  });

  test("getItemsSince paginates via Link header and yields all items", async () => {
    const responses = new Map<string, Response>([
      [
        "https://api.test/users/12345/items?since=100&format=json&limit=100",
        createResponse({
          headers: {
            link: '<https://api.test/users/12345/items?since=100&format=json&limit=100&start=100>; rel="next"',
          },
          body: [
            { key: "A", version: 101, data: { title: "Study A" } },
            { key: "B", version: 102, data: { title: "Study B" } },
          ] satisfies ZoteroItem[],
        }),
      ],
      [
        "https://api.test/users/12345/items?since=100&format=json&limit=100&start=100",
        createResponse({
          body: [{ key: "C", version: 103, data: { title: "Study C" } }] satisfies ZoteroItem[],
        }),
      ],
    ]);

    const calls: string[] = [];
    const client = new ZoteroClient(
      { userId: "12345", apiKey: "secret", baseUrl: "https://api.test" },
      {
        fetchImpl: async (input) => {
          const url = String(input);
          calls.push(url);
          const response = responses.get(url);
          if (!response) {
            throw new Error(`Unexpected URL: ${url}`);
          }
          return response;
        },
        sleep: async () => {},
      },
    );

    const items: ZoteroItem[] = [];
    for await (const item of client.getItemsSince(100)) {
      items.push(item);
    }

    expect(calls).toHaveLength(2);
    expect(items.map((item) => item.key)).toEqual(["A", "B", "C"]);
  });

  test("handles 429 Retry-After and 5xx exponential backoff", async () => {
    const waits: number[] = [];
    const events: ZoteroClientEvent[] = [];
    let callCount = 0;

    const client = new ZoteroClient(
      { userId: "12345", apiKey: "secret", baseUrl: "https://api.test" },
      {
        fetchImpl: async () => {
          callCount += 1;

          if (callCount === 1) {
            return createResponse({ status: 429, headers: { "retry-after": "0.25" }, body: "rate" });
          }

          if (callCount === 2) {
            return createResponse({ status: 500, body: "server" });
          }

          return createResponse({ body: [] });
        },
        sleep: async (ms) => {
          waits.push(ms);
        },
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    await expect(client.getCollections()).resolves.toBeInstanceOf(Map);
    expect(callCount).toBe(3);
    expect(waits).toContain(250);
    expect(waits).toContain(1000);
    expect(events.some((event) => event.type === "retry" && event.reason === "429")).toBe(true);
    expect(events.some((event) => event.type === "retry" && event.reason === "5xx")).toBe(true);
  });

  test("getDeletedSince returns deleted item keys and library version from header", async () => {
    const client = new ZoteroClient(
      { userId: "12345", apiKey: "secret", baseUrl: "https://api.test" },
      {
        fetchImpl: async () =>
          createResponse({
            headers: { "last-modified-version": "4287" },
            body: { items: ["AAA", "BBB"] },
          }),
        sleep: async () => {},
      },
    );

    await expect(client.getDeletedSince(4200)).resolves.toEqual({
      keys: ["AAA", "BBB"],
      libraryVersion: 4287,
    });
  });
});
