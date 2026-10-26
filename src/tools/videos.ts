import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { api2Request, putBinary } from "../client.js";

/** Skool web client limit for post/comment videos: size must be under 30 GB. */
export const MAX_VIDEO_BYTES = 32212254720; // 30 * 1024^3
export const MAX_VIDEO_BYTES_LABEL = "30GB";
export const MAX_VIDEOS_PER_POST = 10;

const VIDEO_CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
};

export function assertVideoSize(sizeBytes: number): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error("Video file is empty");
  }
  if (sizeBytes >= MAX_VIDEO_BYTES) {
    throw new Error(
      `Video file is too large: ${sizeBytes} bytes; Skool allows videos under ${MAX_VIDEO_BYTES_LABEL} (${MAX_VIDEO_BYTES} bytes) for posts`,
    );
  }
}

export function resolveVideoContentType(fileName: string, explicit?: string): string {
  if (explicit) {
    if (!explicit.startsWith("video/")) {
      throw new Error(`Invalid video content type "${explicit}": must start with "video/"`);
    }
    return explicit;
  }
  const ct = VIDEO_CONTENT_TYPES[extname(fileName).toLowerCase()];
  if (!ct) {
    throw new Error(
      `Cannot determine video content type for "${fileName}": use a .mp4, .mov, .webm, .m4v, .avi, or .mkv file, or pass contentType explicitly`,
    );
  }
  return ct;
}

const VIDEO_LINK_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "vimeo.com",
  "www.vimeo.com",
  "player.vimeo.com",
  "loom.com",
  "www.loom.com",
  "wi.st",
]);

export function assertVideoLink(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid video link "${url}": not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Invalid video link "${url}": must be an http(s) URL`);
  }
  const host = parsed.hostname.toLowerCase();
  if (VIDEO_LINK_HOSTS.has(host) || host.endsWith(".wistia.com") || host === "wistia.com") {
    return;
  }
  throw new Error(
    `Unsupported video link "${url}": Skool supports YouTube, Vimeo, Loom, and Wistia links`,
  );
}

export function normalizeVideoLinks(videoLink?: string, videoLinks?: string[]): string[] {
  const links = [...(videoLinks ?? []), ...(videoLink ? [videoLink] : [])];
  for (const link of links) assertVideoLink(link);
  return links;
}

export function assertVideoCount(videoIds: string[], videoLinks: string[]): void {
  if (videoIds.length + videoLinks.length > MAX_VIDEOS_PER_POST) {
    throw new Error(
      `Too many videos: ${videoIds.length + videoLinks.length}; Skool allows at most ${MAX_VIDEOS_PER_POST} videos per post`,
    );
  }
}

export interface CreatedVideo {
  videoId: string;
  uploadUrl: string;
}

export function parseCreatedVideo(result: unknown): CreatedVideo {
  const obj = (result ?? {}) as Record<string, unknown>;
  const data = (obj.data ?? obj) as Record<string, unknown>;
  const videoId = data.videoId ?? data.video_id ?? data.id;
  const uploadUrl = data.uploadUrl ?? data.upload_url;
  if (typeof videoId !== "string" || !videoId) {
    throw new Error("Video creation response did not include a video id");
  }
  if (typeof uploadUrl !== "string" || !uploadUrl) {
    throw new Error("Video creation response did not include an upload URL");
  }
  return { videoId, uploadUrl };
}

export const postsUploadVideoTool = {
  name: "skool_posts_upload_video",
  description:
    "Upload a local video file to Skool (Mux) for a group and return its video id. Pass the id in skool_posts_create videoIds to attach it to a post. The file must be under 30GB. This creates an upload on Skool; processing may still be in progress when it returns.",
  inputSchema: {
    groupId: z.string().describe("The group UUID"),
    filePath: z.string().describe("Local path to the video file"),
    fileName: z.string().optional().describe("File name to register on Skool (defaults to the file's base name)"),
    contentType: z.string().optional().describe("Video MIME type (inferred from extension if omitted)"),
    referenceType: z.enum(["post", "comment"]).default("post").describe("What the video will be attached to"),
  },
  async handler(args: {
    groupId: string;
    filePath: string;
    fileName?: string;
    contentType?: string;
    referenceType: string;
  }) {
    const fileName = args.fileName || basename(args.filePath);
    const contentType = resolveVideoContentType(fileName, args.contentType);

    const info = await stat(args.filePath).catch(() => {
      throw new Error(`Video file not found: ${args.filePath}`);
    });
    if (!info.isFile()) throw new Error(`Video path is not a file: ${args.filePath}`);
    assertVideoSize(info.size);

    const bytes = await readFile(args.filePath);

    const created = parseCreatedVideo(
      await api2Request("/videos", {
        method: "POST",
        body: {
          group_id: args.groupId,
          file_name: fileName,
          content_type: contentType,
          content_length: info.size,
          reference_type: args.referenceType,
        },
      }),
    );

    await putBinary(created.uploadUrl, bytes, contentType);

    return JSON.stringify(
      {
        videoId: created.videoId,
        fileName,
        contentType,
        contentLength: info.size,
        referenceType: args.referenceType,
        uploaded: true,
      },
      null,
      2,
    );
  },
};
