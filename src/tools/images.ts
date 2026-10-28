import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
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

async function waitForFile(fileId: string): Promise<void> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const res = (await api2Request("/files", { queryParams: { ids: fileId } })) as {
      files?: { postprocessed_at?: unknown; metadata?: { read_url?: unknown } }[];
    };
    const file = res?.files?.[0];
    if (file?.postprocessed_at && file.metadata?.read_url) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Image ${fileId} was uploaded but Skool did not finish processing it in time`);
}

/**
 * Upload one local image to Skool's file store (owned by the group) and return its file id.
 * The file is not attached to anything until a post is created with it.
 */
export async function uploadImage(groupId: string, filePath: string): Promise<string> {
  const fileName = basename(filePath);
  const contentType = resolveImageContentType(fileName);
  const bytes = await readFile(filePath).catch(() => {
    throw new Error(`Image file not found or not readable: ${filePath}`);
  });
  if (bytes.length === 0) throw new Error(`Image file is empty: ${filePath}`);

  const created = parseCreatedFile(
    await api2Request("/files", {
      method: "POST",
      body: {
        file_name: fileName,
        content_type: contentType,
        content_length: bytes.length,
        content_disposition: "",
        ref: "",
        owner_id: groupId,
        large_thumbnail: false,
      },
    }),
  );

  const headers: Record<string, string> = created.acl ? { "x-amz-acl": created.acl } : {};
  await putBinary(created.writeUrl, bytes, created.contentType || contentType, bytes.length, headers);
  await waitForFile(created.fileId);
  return created.fileId;
}
