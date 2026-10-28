import { open, type FileHandle } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { api2Request, putBinary } from "../client.js";

export const MAX_IMAGES_PER_POST = 10;

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const POLL_ATTEMPTS = 15;
const POLL_INTERVAL_MS = 1000;

export function resolveImageContentType(fileName: string): string {
  const ct = IMAGE_CONTENT_TYPES[extname(fileName).toLowerCase()];
  if (!ct) {
    throw new Error(`Cannot determine image content type for "${fileName}": use a .png, .jpg, .jpeg, .gif, or .webp file`);
  }
  return ct;
}

export function assertImageCount(count: number): void {
  if (count > MAX_IMAGES_PER_POST) {
    throw new Error(`Too many images: ${count}; at most ${MAX_IMAGES_PER_POST} images per post`);
  }
}

export interface CreatedFile {
  fileId: string;
  writeUrl: string;
  contentType: string;
  acl: string;
}

export function parseCreatedFile(result: unknown): CreatedFile {
  const obj = (result ?? {}) as Record<string, unknown>;
  const file = (obj.file ?? {}) as Record<string, unknown>;
  if (typeof file.id !== "string" || !file.id) {
    throw new Error("File creation response did not include a file id");
  }
  if (typeof obj.write_url !== "string" || !obj.write_url) {
    throw new Error("File creation response did not include a write URL");
  }
  return {
    fileId: file.id,
    writeUrl: obj.write_url,
    contentType: typeof obj.content_type === "string" && obj.content_type ? obj.content_type : "",
    acl: typeof obj.acl === "string" ? obj.acl : "",
  };
}

export type ImageStatus = "processed" | "stillProcessing" | "statusUnknown";

async function waitForFile(fileId: string): Promise<ImageStatus> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const res = (await api2Request("/files", { queryParams: { ids: fileId } }).catch(() => null)) as {
      files?: { postprocessed_at?: unknown; metadata?: { read_url?: unknown } }[];
    } | null;
    const file = res?.files?.[0];
    if (!file) return "statusUnknown";
    if (file.postprocessed_at && file.metadata?.read_url) return "processed";
    if (i < POLL_ATTEMPTS - 1) await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return "stillProcessing";
}

export interface PreparedImage {
  fileName: string;
  contentType: string;
  size: number;
  handle: FileHandle;
}

export async function prepareImage(filePath: string): Promise<PreparedImage> {
  const fileName = basename(filePath);
  const contentType = resolveImageContentType(fileName);
  const handle = await open(filePath, "r").catch(() => {
    throw new Error(`Image file not found or not readable: ${filePath}`);
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Image path is not a file: ${filePath}`);
    if (info.size === 0) throw new Error(`Image file is empty: ${filePath}`);
    return { fileName, contentType, size: info.size, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Upload one local image to Skool's file store (owned by the group) and return its file id.
 * The file is not attached to anything until a post is created with it.
 */
export async function uploadImage(groupId: string, image: PreparedImage): Promise<{ fileId: string; status: ImageStatus }> {
  const created = parseCreatedFile(
    await api2Request("/files", {
      method: "POST",
      body: {
        file_name: image.fileName,
        content_type: image.contentType,
        content_length: image.size,
        content_disposition: "",
        ref: "",
        owner_id: groupId,
        large_thumbnail: false,
      },
    }),
  );

  const headers: Record<string, string> = created.acl ? { "x-amz-acl": created.acl } : {};
  const stream = image.handle.createReadStream({ autoClose: false });
  await putBinary(created.writeUrl, Readable.toWeb(stream) as ReadableStream, created.contentType || image.contentType, image.size, headers);
  const status = await waitForFile(created.fileId);
  return { fileId: created.fileId, status };
}
