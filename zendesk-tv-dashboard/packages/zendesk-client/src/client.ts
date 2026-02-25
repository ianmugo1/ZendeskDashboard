import {
  backoffWithJitterMs,
  isRetryableStatusCode,
  parseRetryAfterMs,
  sleep
} from "./retry.js";
import type {
  SearchAllTicketsOptions,
  SearchTicketsOptions,
  ZendeskClientOptions,
  ZendeskCountResponse,
  ZendeskGroup,
  ZendeskGroupsListResponse,
  ZendeskGroupsResponse,
  ZendeskSearchResponse,
  ZendeskUser,
  ZendeskUsersListResponse,
  ZendeskUsersResponse
} from "./types.js";

interface RequestOptions {
  params?: Record<string, string | number | undefined>;
  timeoutMs?: number;
}

interface RequestErrorShape {
  error?: string | { title?: string; message?: string };
  description?: string;
  message?: string;
  details?: unknown;
}

function normalizeZendeskSubdomain(rawValue: string): string {
  const value = rawValue.trim().toLowerCase();
  if (!value) {
    return "";
  }

  const withoutProtocol = value.replace(/^https?:\/\//, "");
  const host = withoutProtocol.split("/")[0] ?? withoutProtocol;

  if (host.endsWith(".zendesk.com")) {
    return host.replace(/\.zendesk\.com$/, "");
  }

  return host;
}

function getZendeskErrorMessage(parsedBody: RequestErrorShape | string | null, status: number): string {
  if (typeof parsedBody === "string" && parsedBody.trim()) {
    return parsedBody.trim();
  }

  if (parsedBody && typeof parsedBody === "object") {
    if (typeof parsedBody.error === "string" && parsedBody.error.trim()) {
      return parsedBody.description ? `${parsedBody.error}: ${parsedBody.description}` : parsedBody.error;
    }

    if (parsedBody.error && typeof parsedBody.error === "object") {
      const title = typeof parsedBody.error.title === "string" ? parsedBody.error.title.trim() : "";
      const message = typeof parsedBody.error.message === "string" ? parsedBody.error.message.trim() : "";
      if (title && message) {
        return `${title}: ${message}`;
      }
      if (title) {
        return title;
      }
      if (message) {
        return message;
      }
    }

    if (typeof parsedBody.message === "string" && parsedBody.message.trim()) {
      return parsedBody.message.trim();
    }
  }

  return `Zendesk API request failed with status ${status}`;
}

export class ZendeskApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ZendeskApiError";
    this.status = status;
    this.body = body;
  }
}

export class ZendeskClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private lastRateLimitRemaining: number | null = null;
  private lastRateLimitLimit: number | null = null;
  private lastRateLimitResetSeconds: number | null = null;

  constructor(options: ZendeskClientOptions) {
    this.baseUrl = `https://${options.subdomain}.zendesk.com`;
    this.authHeader = Buffer.from(`${options.email}/token:${options.apiToken}`).toString("base64");
    this.maxRetries = options.maxRetries ?? 5;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ZendeskClient {
    const rawSubdomain = env.ZENDESK_SUBDOMAIN;
    const email = env.ZENDESK_EMAIL;
    const apiToken = env.ZENDESK_API_TOKEN;
    const subdomain = rawSubdomain ? normalizeZendeskSubdomain(rawSubdomain) : "";

    if (!subdomain || !email || !apiToken) {
      throw new Error("Missing Zendesk credentials. Set ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN.");
    }

    if (subdomain === "your-subdomain") {
      throw new Error("Invalid ZENDESK_SUBDOMAIN: replace placeholder 'your-subdomain' with your real Zendesk subdomain.");
    }

    return new ZendeskClient({ subdomain, email, apiToken });
  }

  async searchCount(query: string): Promise<number> {
    const payload = await this.request<ZendeskCountResponse>("/api/v2/search/count.json", {
      params: { query }
    });

    if (typeof payload.count === "number") {
      return payload.count;
    }

    if (typeof payload.count?.value === "number") {
      return payload.count.value;
    }

    throw new Error("Unexpected Zendesk count response format.");
  }

  async searchTickets(query: string, options: SearchTicketsOptions = {}): Promise<ZendeskSearchResponse> {
    const params: Record<string, string | number | undefined> = {
      query,
      per_page: options.perPage ?? 100,
      page: options.page
    };

    if (options.sortBy) {
      params.sort_by = options.sortBy;
    }

    if (options.sortOrder) {
      params.sort_order = options.sortOrder;
    }

    return this.request<ZendeskSearchResponse>("/api/v2/search.json", { params });
  }

  async searchAllTickets(query: string, options: SearchAllTicketsOptions = {}): Promise<ZendeskSearchResponse["results"]> {
    const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100);
    const limit = Math.max(options.limit ?? 500, 1);
    let page = 1;
    const allTickets: ZendeskSearchResponse["results"] = [];

    while (allTickets.length < limit) {
      const response = await this.searchTickets(query, {
        perPage: pageSize,
        page,
        sortBy: options.sortBy,
        sortOrder: options.sortOrder
      });

      if (response.results.length === 0) {
        break;
      }

      const room = limit - allTickets.length;
      allTickets.push(...response.results.slice(0, room));

      if (!response.next_page || response.results.length < pageSize) {
        break;
      }

      page += 1;
    }

    return allTickets;
  }

  async getUsersByIds(ids: number[]): Promise<Map<number, ZendeskUser>> {
    const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
    const usersMap = new Map<number, ZendeskUser>();

    for (let index = 0; index < uniqueIds.length; index += 100) {
      const chunk = uniqueIds.slice(index, index + 100);
      if (chunk.length === 0) {
        continue;
      }

      const payload = await this.request<ZendeskUsersResponse>("/api/v2/users/show_many.json", {
        params: { ids: chunk.join(",") }
      });

      for (const user of payload.users) {
        usersMap.set(user.id, user);
      }
    }

    return usersMap;
  }

  async listAgents(limit = 500): Promise<ZendeskUser[]> {
    const cappedLimit = Math.max(50, Math.min(limit, 5000));
    const users: ZendeskUser[] = [];
    let page = 1;
    const perPage = 100;

    while (users.length < cappedLimit) {
      const payload = await this.request<ZendeskUsersListResponse>("/api/v2/users.json", {
        params: {
          page,
          per_page: perPage
        }
      });

      if (payload.users.length === 0) {
        break;
      }

      users.push(...payload.users);

      if (!payload.next_page || payload.users.length < perPage) {
        break;
      }

      page += 1;
    }

    return users
      .filter((user) => {
        const role = (user.role ?? "").toLowerCase();
        return role === "agent" || role === "admin";
      })
      .slice(0, cappedLimit);
  }

  async getGroupsByIds(ids: number[]): Promise<Map<number, ZendeskGroup>> {
    const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
    const groupsMap = new Map<number, ZendeskGroup>();

    for (let index = 0; index < uniqueIds.length; index += 100) {
      const chunk = uniqueIds.slice(index, index + 100);
      if (chunk.length === 0) {
        continue;
      }

      const payload = await this.request<ZendeskGroupsResponse>("/api/v2/groups/show_many.json", {
        params: { ids: chunk.join(",") }
      });

      for (const group of payload.groups) {
        groupsMap.set(group.id, group);
      }
    }

    return groupsMap;
  }

  async listGroups(limit = 500): Promise<ZendeskGroup[]> {
    const cappedLimit = Math.max(25, Math.min(limit, 5000));
    const groups: ZendeskGroup[] = [];
    let page = 1;
    const perPage = 100;

    while (groups.length < cappedLimit) {
      const payload = await this.request<ZendeskGroupsListResponse>("/api/v2/groups.json", {
        params: {
          page,
          per_page: perPage
        }
      });

      if (payload.groups.length === 0) {
        break;
      }

      groups.push(...payload.groups);

      if (!payload.next_page || payload.groups.length < perPage) {
        break;
      }

      page += 1;
    }

    return groups.slice(0, cappedLimit);
  }

  getRateLimitSnapshot(): { remaining: number | null; limit: number | null; resetSeconds: number | null } {
    return {
      remaining: this.lastRateLimitRemaining,
      limit: this.lastRateLimitLimit,
      resetSeconds: this.lastRateLimitResetSeconds
    };
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Basic ${this.authHeader}`,
            "Content-Type": "application/json"
          },
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timeout);
        if (attempt <= this.maxRetries) {
          await sleep(backoffWithJitterMs(attempt));
          continue;
        }
        throw error;
      }

      clearTimeout(timeout);
      const remainingHeader = response.headers.get("x-rate-limit-remaining") ?? response.headers.get("ratelimit-remaining");
      const limitHeader = response.headers.get("x-rate-limit") ?? response.headers.get("ratelimit-limit");
      const resetHeader = response.headers.get("ratelimit-reset") ?? response.headers.get("x-rate-limit-reset");
      const remaining = remainingHeader ? Number.parseInt(remainingHeader, 10) : Number.NaN;
      const limit = limitHeader ? Number.parseInt(limitHeader, 10) : Number.NaN;
      const resetSeconds = resetHeader ? Number.parseInt(resetHeader, 10) : Number.NaN;
      this.lastRateLimitRemaining = Number.isNaN(remaining) ? this.lastRateLimitRemaining : remaining;
      this.lastRateLimitLimit = Number.isNaN(limit) ? this.lastRateLimitLimit : limit;
      this.lastRateLimitResetSeconds = Number.isNaN(resetSeconds) ? this.lastRateLimitResetSeconds : resetSeconds;

      if (response.ok) {
        return (await response.json()) as T;
      }

      let parsedBody: RequestErrorShape | string | null = null;
      try {
        parsedBody = (await response.json()) as RequestErrorShape;
      } catch {
        try {
          parsedBody = await response.text();
        } catch {
          parsedBody = null;
        }
      }

      if (isRetryableStatusCode(response.status) && attempt <= this.maxRetries) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        await sleep(retryAfterMs ?? backoffWithJitterMs(attempt));
        continue;
      }

      const errorMessage = getZendeskErrorMessage(parsedBody, response.status);

      throw new ZendeskApiError(errorMessage, response.status, parsedBody);
    }

    throw new Error("Zendesk API request failed after retries.");
  }
}
