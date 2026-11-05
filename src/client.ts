import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { loadConfig, type SkoolConfig } from "./config.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let buildIdCache: { id: string; fetchedAt: number } | null = null;
const BUILD_ID_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch the Next.js buildId from any Skool page by parsing __NEXT_DATA__.
 */
export async function getBuildId(config: SkoolConfig): Promise<string> {
  if (buildIdCache && Date.now() - buildIdCache.fetchedAt < BUILD_ID_TTL) {
    return buildIdCache.id;
  }

  const res = await fetch(config.baseUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: config.cookies,
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Skool homepage for buildId: ${res.status}`);
  }

  const html = await res.text();
  // Look for buildId in __NEXT_DATA__ JSON
  const match = html.match(/"buildId"\s*:\s*"([^"]+)"/);
  if (!match) {
    throw new Error("Could not extract buildId from Skool HTML");
  }

  buildIdCache = { id: match[1], fetchedAt: Date.now() };
  return match[1];
}

/**
 * Make an authenticated request to a Next.js data route.
 */
export async function nextDataRequest(
  path: string,
  queryParams?: Record<string, string>,
): Promise<unknown> {
  const config = await loadConfig();
  const buildId = await getBuildId(config);

  const url = new URL(`/_next/data/${buildId}${path}.json`, config.baseUrl);
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: config.cookies,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Next.js data request failed: ${res.status} ${res.statusText} — ${body.slice(0, 500)}`);
  }

  return res.json();
}

/**
 * Make an authenticated request to api2.skool.com.
 */
export async function api2Request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    queryParams?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  const config = await loadConfig();
  const { method = "GET", body, queryParams, signal } = options;

  const url = new URL(path, "https://api2.skool.com");
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Cookie: config.cookies,
    Accept: "application/json",
    Origin: "https://www.skool.com",
    Referer: "https://www.skool.com/",
  };

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`api2 request failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * PUT raw bytes to a pre-signed upload URL returned by Skool (no cookies sent).
 */
export async function putBinary(
  url: string,
  body: Uint8Array | ReadableStream,
  contentType: string,
  contentLength: number,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(contentLength), ...extraHeaders },
    body: body as BodyInit,
    duplex: "half",
  } as RequestInit);
  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status}`);
  }
}

/**
 * Generic authenticated fetch to any Skool URL — used by skool.request tool.
 */
export async function rawRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const config = await loadConfig();
  const { method = "GET", headers: extraHeaders = {}, body } = options;

  const res = await fetch(url, {
    method,
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: config.cookies,
      Accept: "application/json",
      ...extraHeaders,
    },
    body: body || undefined,
  });

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    responseHeaders[k] = v;
  });

  const text = await res.text();
  return { status: res.status, headers: responseHeaders, body: text };
}

/** Files above 8 MiB use resumable 8 MiB chunks; each failed chunk gets three retries.
 * 308 acknowledges an intermediate chunk. Only the final chunk may complete with 2xx.
 */
export const VIDEO_CHUNK_BYTES = 8 * 1024 * 1024;
export const VIDEO_CHUNK_THRESHOLD = VIDEO_CHUNK_BYTES;
export async function putFileBinary(url: string, file: FileHandle, contentType: string, size: number): Promise<void> {
  if (size <= VIDEO_CHUNK_THRESHOLD) {
    const stream = file.createReadStream({ autoClose: false });
    try { await putBinary(url, Readable.toWeb(stream) as ReadableStream, contentType, size); }
    finally { stream.destroy(); }
    return;
  }
  for (let start = 0; start < size; start += VIDEO_CHUNK_BYTES) {
    const length = Math.min(VIDEO_CHUNK_BYTES, size - start);
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const result = await file.read(bytes, read, length - read, start + read);
      if (!result.bytesRead) throw new Error("Video file changed during upload");
      read += result.bytesRead;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(url, { method: "PUT", headers: {
          "Content-Type": contentType, "Content-Length": String(length),
          "Content-Range": `bytes ${start}-${start + length - 1}/${size}`,
        }, body: bytes, redirect: "manual" });
        const intermediate = start + length < size;
        if (!(intermediate ? response.status === 308 : response.ok)) throw new Error("Video chunk upload failed");
        await response.body?.cancel();
        break;
      } catch { if (attempt === 3) throw new Error("Video chunk upload failed after three retries"); }
    }
  }
}
