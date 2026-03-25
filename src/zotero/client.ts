export interface ZoteroItemData {
  itemType?: string;
  title?: string;
  [key: string]: unknown;
}

export interface ZoteroItem {
  key: string;
  version: number;
  data: ZoteroItemData;
  [key: string]: unknown;
}

export interface ZoteroCollection {
  key: string;
  data?: {
    name?: string;
    [key: string]: unknown;
  };
  name?: string;
  [key: string]: unknown;
}

export interface ZoteroClientConfig {
  userId: string;
  apiKey: string;
  baseUrl?: string;
}

export type ZoteroClientEvent =
  | {
      type: "request";
      url: string;
      attempt: number;
    }
  | {
      type: "retry";
      url: string;
      attempt: number;
      reason: "429" | "5xx";
      waitMs: number;
      status: number;
    }
  | {
      type: "response";
      url: string;
      attempt: number;
      status: number;
    };

interface ZoteroClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  onEvent?: (event: ZoteroClientEvent) => void;
}

interface RequestResult<T> {
  data: T;
  response: Response;
}

const DEFAULT_BASE_URL = "https://api.zotero.org";
const DEFAULT_MIN_INTERVAL_MS = 100;
const RETRY_BACKOFF_MS = [1000, 2000, 4000] as const;
const MAX_429_RETRIES = 5;

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  const segments = linkHeader.split(",");
  for (const segment of segments) {
    const [rawUrl, ...params] = segment.split(";");
    if (!rawUrl) {
      continue;
    }

    const hasNextRel = params.some((part) => /rel\s*=\s*"?next"?/i.test(part.trim()));
    if (!hasNextRel) {
      continue;
    }

    const match = rawUrl.trim().match(/^<(.+)>$/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function parseRetryAfterToMs(retryAfter: string | null): number {
  if (!retryAfter) {
    return 1000;
  }

  const asSeconds = Number(retryAfter);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.round(asSeconds * 1000);
  }

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return Math.max(delta, 0);
  }

  return 1000;
}

export class ZoteroClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly onEvent?: (event: ZoteroClientEvent) => void;
  private nextRequestEarliestAt = 0;

  public constructor(
    private readonly config: ZoteroClientConfig,
    options: ZoteroClientOptions = {},
  ) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.onEvent = options.onEvent;
  }

  public async *getItemsSince(version: number): AsyncGenerator<ZoteroItem> {
    let nextUrl = this.url(`/users/${this.config.userId}/items`, {
      since: String(version),
      format: "json",
      limit: "100",
    });

    while (nextUrl) {
      const { data, response } = await this.requestJson<ZoteroItem[]>(nextUrl);
      for (const item of data) {
        yield item;
      }

      nextUrl = parseNextLink(response.headers.get("link"));
    }
  }

  public async getItem(key: string): Promise<ZoteroItem> {
    const { data } = await this.requestJson<ZoteroItem>(
      this.url(`/users/${this.config.userId}/items/${key}`, { format: "json" }),
    );
    return data;
  }

  public async getChildItems(parentKey: string): Promise<ZoteroItem[]> {
    const { data } = await this.requestJson<ZoteroItem[]>(
      this.url(`/users/${this.config.userId}/items/${parentKey}/children`, {
        format: "json",
      }),
    );
    return data;
  }

  public async getCollections(): Promise<Map<string, string>> {
    const { data } = await this.requestJson<ZoteroCollection[]>(
      this.url(`/users/${this.config.userId}/collections`, { format: "json" }),
    );

    const map = new Map<string, string>();
    for (const collection of data) {
      const name = collection.data?.name ?? collection.name;
      if (collection.key && typeof name === "string") {
        map.set(collection.key, name);
      }
    }

    return map;
  }

  public async ping(): Promise<boolean> {
    try {
      await this.requestText(
        this.url(`/users/${this.config.userId}/items`, {
          limit: "1",
          format: "json",
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private url(path: string, query: Record<string, string>): string {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const waitMs = this.nextRequestEarliestAt - now;
    if (waitMs > 0) {
      await this.sleepImpl(waitMs);
    }
    this.nextRequestEarliestAt = Math.max(Date.now(), this.nextRequestEarliestAt) + this.minIntervalMs;
  }

  private async requestJson<T>(url: string): Promise<RequestResult<T>> {
    const result = await this.request(url);
    const text = await result.response.text();

    if (text.length === 0) {
      return { data: [] as T, response: result.response };
    }

    const parsed = JSON.parse(text) as T;
    return { data: parsed, response: result.response };
  }

  private async requestText(url: string): Promise<RequestResult<string>> {
    const result = await this.request(url);
    return {
      data: await result.response.text(),
      response: result.response,
    };
  }

  private async request(url: string): Promise<{ response: Response }> {
    const headers = new Headers({
      "Zotero-API-Key": this.config.apiKey,
    });

    let fiveXXRetries = 0;
    let tooManyRequestRetries = 0;
    let attempt = 1;

    while (true) {
      await this.throttle();
      this.onEvent?.({ type: "request", url, attempt });

      const response = await this.fetchImpl(url, { headers });
      this.onEvent?.({ type: "response", url, attempt, status: response.status });

      if (response.status === 429) {
        if (tooManyRequestRetries >= MAX_429_RETRIES) {
          throw await this.httpError(url, response);
        }

        tooManyRequestRetries += 1;
        const waitMs = parseRetryAfterToMs(response.headers.get("retry-after"));
        this.onEvent?.({
          type: "retry",
          url,
          attempt,
          reason: "429",
          waitMs,
          status: response.status,
        });
        await this.sleepImpl(waitMs);
        attempt += 1;
        continue;
      }

      if (response.status >= 500 && response.status <= 599) {
        if (fiveXXRetries >= RETRY_BACKOFF_MS.length) {
          throw await this.httpError(url, response);
        }

        const waitMs = RETRY_BACKOFF_MS[fiveXXRetries];
        fiveXXRetries += 1;

        this.onEvent?.({
          type: "retry",
          url,
          attempt,
          reason: "5xx",
          waitMs,
          status: response.status,
        });
        await this.sleepImpl(waitMs);
        attempt += 1;
        continue;
      }

      if (!response.ok) {
        throw await this.httpError(url, response);
      }

      return { response };
    }
  }

  private async httpError(url: string, response: Response): Promise<Error> {
    const body = await response.text();
    const bodyPreview = body.length > 500 ? `${body.slice(0, 500)}…` : body;
    return new Error(
      `Zotero API request failed (${response.status}) for ${url}${
        bodyPreview ? `: ${bodyPreview}` : ""
      }`,
    );
  }
}
