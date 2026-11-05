import { z } from "zod";
import { open, stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLessonVideo, assertLessonId } from "./classroom.js";
import { basename, extname } from "node:path";
import { api2Request, putFileBinary } from "../client.js";

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

export interface UploadVideoArgs {
  groupId: string;
  filePath?: string;
  sourceUrl?: string;
  fileName?: string;
  contentType?: string;
  referenceType?: string;
  lessonId?: string;
}

export const uploadVideoTool = {
  name: "skool_upload_video",
  description: "Upload a local or HTTP(S) video under 30GB. lessonId implies module and attaches the video using a full lesson update. module is an unproven lesson reference value.",
  inputSchema: {
    groupId: z.string().min(1),
    filePath: z.string().optional(),
    sourceUrl: z.string().optional(),
    fileName: z.string().optional(),
    contentType: z.string().optional(),
    referenceType: z.enum(["post", "comment", "module"]).default("post"),
    lessonId: z.string().regex(/^[a-fA-F0-9]{32}$/).optional(),
  },
  async handler(args: UploadVideoArgs) {
    if (Boolean(args.filePath) === Boolean(args.sourceUrl)) throw new Error("Provide exactly one of filePath or sourceUrl");
    if (!args.groupId) throw new Error("groupId is required");
    if (args.lessonId !== undefined) assertLessonId(args.lessonId);
    if (args.referenceType && !["post", "comment", "module"].includes(args.referenceType)) throw new Error("Invalid referenceType");
    let source: URL | undefined;
    if (args.sourceUrl) {
      try { source = new URL(args.sourceUrl); } catch { throw new Error("sourceUrl must be an http(s) URL"); }
      if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) throw new Error("sourceUrl must be an http(s) URL without credentials");
    }
    const fileName = args.fileName || basename(source ? source.pathname : args.filePath!);
    if (!VIDEO_CONTENT_TYPES[extname(fileName).toLowerCase()]) throw new Error("Cannot determine video content type: unsupported video extension");
    const contentType = resolveVideoContentType(fileName, args.contentType);
    const referenceType = args.lessonId ? "module" : args.referenceType ?? "post";
    let temp: string | undefined;
    let filePath = args.filePath!;
    try {
      if (source) {
        const response = await fetch(source, { credentials: "omit" });
        if (!response.ok || !response.body) throw new Error("Video source download failed");
        const declared = response.headers.get("content-length");
        if (declared !== null) {
          try { assertVideoSize(Number(declared)); } catch (error) { await response.body.cancel(); throw error; }
        }
        temp = await mkdtemp(join(tmpdir(), "skool-video-"));
        filePath = join(temp, "video");
        const output = await open(filePath, "w");
        let size = 0;
        try {
          for await (const chunk of response.body) {
            size += chunk.length;
            assertVideoSize(size);
            await output.writeFile(chunk);
          }
        } finally { await output.close(); }
        if (declared !== null && size !== Number(declared)) throw new Error("Video source length mismatch");
      }
      const info = await stat(filePath).catch(() => { throw new Error("Video file not found"); });
      if (!info.isFile()) throw new Error("Video path is not a file");
      assertVideoSize(info.size);
      const handle = await open(filePath, "r");
      let videoId: string;
      try {
        const created = parseCreatedVideo(await api2Request("/videos", { method: "POST", body: {
          group_id: args.groupId, file_name: fileName, content_type: contentType,
          content_length: info.size, reference_type: referenceType,
        } }));
        await putFileBinary(created.uploadUrl, handle, contentType, info.size);
        videoId = created.videoId;
      } finally { await handle.close(); }
      if (args.lessonId) await setLessonVideo({ lessonId: args.lessonId, videoId });
      return JSON.stringify({ videoId, fileName, contentType, contentLength: info.size,
        referenceType, uploaded: true, ...(args.lessonId ? { lessonAttached: true } : {}) }, null, 2);
    } finally { if (temp) await rm(temp, { recursive: true, force: true }); }
  },
};

/** Backwards-compatible wrapper using the same validation and upload implementation. */
export const postsUploadVideoTool = { ...uploadVideoTool, name: "skool_posts_upload_video" };
