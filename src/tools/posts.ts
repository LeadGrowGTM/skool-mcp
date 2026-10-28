import { z } from "zod";
import { nextDataRequest, api2Request } from "../client.js";
import { loadConfig } from "../config.js";
import { assertImageCount, prepareImage, uploadImage, type PreparedImage } from "./images.js";
import { assertVideoCount, normalizeVideoLinks } from "./videos.js";

export interface PostVideoOptions {
  videoIds?: string[];
  videoLink?: string;
  videoLinks?: string[];
}

export function buildPostMetadata(opts: {
  title?: string;
  content: string;
  label?: string;
  attachments?: string;
} & PostVideoOptions): Record<string, unknown> {
  const videoIds = opts.videoIds ?? [];
  const videoLinks = normalizeVideoLinks(opts.videoLink, opts.videoLinks);
  assertVideoCount(videoIds, videoLinks);
  const metadata: Record<string, unknown> = {
    action: 0,
    content: opts.content,
    video_ids: videoIds.join(","),
  };
  if (opts.title !== undefined) metadata.title = opts.title;
  if (opts.label) metadata.labels = opts.label;
  if (opts.attachments) metadata.attachments = opts.attachments;
  if (videoLinks.length) metadata.video_links = videoLinks.join("\n");
  return metadata;
}

export function buildCommentPayload(args: {
  postId: string;
  groupId: string;
  content: string;
} & PostVideoOptions): Record<string, unknown> {
  return {
    post_type: "comment",
    group_id: args.groupId,
    parent_id: args.postId,
    root_id: args.postId,
    metadata: buildPostMetadata({ content: args.content, videoIds: args.videoIds, videoLink: args.videoLink, videoLinks: args.videoLinks }),
  };
}

export function buildCreatePayload(args: {
  groupId: string;
  title: string;
  content: string;
  label?: string;
  attachmentIds?: string[];
} & PostVideoOptions): Record<string, unknown> {
  return {
    post_type: "generic",
    group_id: args.groupId,
    metadata: buildPostMetadata({
      title: args.title,
      content: args.content,
      label: args.label,
      attachments: args.attachmentIds?.length ? args.attachmentIds.join(",") : undefined,
      videoIds: args.videoIds,
      videoLink: args.videoLink,
      videoLinks: args.videoLinks,
    }),
  };
}

export const postsListTool = {
  name: "skool_posts_list",
  description:
    "List posts in a community feed. Supports category filtering and pagination. Returns post title, content preview, author, likes, and comment count.",
  inputSchema: {
    community: z.string().optional().describe("Community slug. Uses default from config if omitted."),
    category: z.string().optional().describe("Category/label UUID to filter by"),
    page: z.number().default(1).describe("Page number (1-based)"),
    sort: z.enum(["newest-cm", "newest", "top"]).default("newest-cm").describe("Sort order: newest-cm (recent activity), newest (created), top (most liked)"),
  },
  async handler(args: { community?: string; category?: string; page: number; sort: string }) {
    const config = await loadConfig();
    const slug = args.community || config.defaultCommunity;
    if (!slug) throw new Error("No community specified and no defaultCommunity in config");

    const params: Record<string, string> = {
      group: slug,
      p: String(args.page),
      s: args.sort,
    };
    if (args.category) {
      params.c = args.category;
    }

    const data = (await nextDataRequest(`/${slug}`, params)) as {
      pageProps?: Record<string, unknown>;
    };

    const props = data?.pageProps;
    if (!props) throw new Error("No pageProps in response");

    return JSON.stringify(props, null, 2);
  },
};

export const postsGetTool = {
  name: "skool_posts_get",
  description:
    "Get a single post with its full content and comments. Provide the post slug (name field from posts list).",
  inputSchema: {
    community: z.string().optional().describe("Community slug. Uses default from config if omitted."),
    postSlug: z.string().describe("The post slug/name (from the 'name' field in posts list)"),
  },
  async handler(args: { community?: string; postSlug: string }) {
    const config = await loadConfig();
    const slug = args.community || config.defaultCommunity;
    if (!slug) throw new Error("No community specified and no defaultCommunity in config");

    const data = (await nextDataRequest(`/${slug}/${args.postSlug}`, {
      group: slug,
      p: args.postSlug,
    })) as { pageProps?: Record<string, unknown> };

    const props = data?.pageProps;
    if (!props) throw new Error("No pageProps in response");

    return JSON.stringify(props, null, 2);
  },
};

export const postsCreateTool = {
  name: "skool_posts_create",
  description:
    "Create a new post in a community. Requires auth cookies. Posts to api2.skool.com. Attach local images with images (each is uploaded to the group, then attached). Attach an uploaded video with videoIds (from skool_posts_upload_video) or an external video with videoLink/videoLinks (YouTube, Vimeo, Loom, or Wistia).",
  inputSchema: {
    groupId: z.string().describe("The group UUID"),
    title: z.string().describe("Post title"),
    content: z.string().describe("Post body content"),
    label: z.string().optional().describe("Category label UUID"),
    attachmentIds: z.array(z.string()).optional().describe("Uploaded file ids to attach (from the /files upload flow)"),
    images: z.array(z.string()).optional().describe("Local image file paths (.png, .jpg, .jpeg, .gif, .webp; at most 10) to upload and attach to the post"),
    videoIds: z.array(z.string()).optional().describe("Uploaded video ids from skool_posts_upload_video"),
    videoLink: z.string().optional().describe("One YouTube, Vimeo, Loom, or Wistia URL"),
    videoLinks: z.array(z.string()).optional().describe("YouTube, Vimeo, Loom, or Wistia URLs"),
  },
  async handler(args: {
    groupId: string;
    title: string;
    content: string;
    label?: string;
    attachmentIds?: string[];
    images?: string[];
    videoIds?: string[];
    videoLink?: string;
    videoLinks?: string[];
  }) {
    const images = args.images ?? [];
    if (args.images !== undefined) assertImageCount((args.attachmentIds?.length ?? 0) + images.length);
    // Validate the rest of the payload before uploading anything.
    buildCreatePayload(args);
    const prepared: PreparedImage[] = [];
    try {
      for (const image of images) prepared.push(await prepareImage(image));
      const uploaded: string[] = [];
      const stillProcessing: { fileId: string; path: string }[] = [];
      for (const [index, image] of prepared.entries()) {
        const { fileId, processed } = await uploadImage(args.groupId, image);
        uploaded.push(fileId);
        if (!processed) stillProcessing.push({ fileId, path: images[index] });
      }

      const result = await api2Request("/posts?notify=false&follow=true", {
        method: "POST",
        body: buildCreatePayload({ ...args, attachmentIds: [...(args.attachmentIds ?? []), ...uploaded] }),
      });

      return JSON.stringify(images.length ? { post: result, stillProcessing } : result, null, 2);
    } finally {
      await Promise.all(prepared.map((image) => image.handle.close()));
    }
  },
};

export const postsCommentTool = {
  name: "skool_posts_comment",
  description:
    "Add a comment to a post. Requires auth cookies. Creates a comment post via POST /posts on api2.skool.com (the former POST /comments route returns 404).",
  inputSchema: {
    postId: z.string().describe("The post UUID to comment on"),
    groupId: z.string().describe("The group UUID"),
    content: z.string().describe("Comment text content"),
    videoIds: z.array(z.string()).optional().describe("Uploaded video ids from skool_posts_upload_video"),
    videoLink: z.string().optional().describe("One YouTube, Vimeo, Loom, or Wistia URL"),
    videoLinks: z.array(z.string()).optional().describe("YouTube, Vimeo, Loom, or Wistia URLs"),
  },
  async handler(args: {
    postId: string;
    groupId: string;
    content: string;
    videoIds?: string[];
    videoLink?: string;
    videoLinks?: string[];
  }) {
    const result = await api2Request("/posts", {
      method: "POST",
      body: buildCommentPayload(args),
    });

    return JSON.stringify(result, null, 2);
  },
};
