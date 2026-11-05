import { z } from "zod";
import { nextDataRequest, api2Request } from "../client.js";
import { loadConfig } from "../config.js";

export const coursesListTool = {
  name: "skool_courses_list",
  description:
    "List courses in a community classroom. Returns course names and metadata.",
  inputSchema: {
    community: z.string().optional().describe("Community slug. Uses default from config if omitted."),
    groupId: z.string().optional().describe("Group UUID — if provided, uses api2.skool.com for richer data"),
  },
  async handler(args: { community?: string; groupId?: string }) {
    // If groupId is given, prefer api2 for structured data
    if (args.groupId) {
      const result = await api2Request(`/groups/${args.groupId}/courses`);
      return JSON.stringify(result, null, 2);
    }

    const config = await loadConfig();
    const slug = args.community || config.defaultCommunity;
    if (!slug) throw new Error("No community specified and no defaultCommunity in config");

    const data = (await nextDataRequest(`/${slug}/classroom`, {
      group: slug,
    })) as { pageProps?: Record<string, unknown> };

    const props = data?.pageProps;
    if (!props) throw new Error("No pageProps in response");

    return JSON.stringify(props, null, 2);
  },
};

export const lessonsListTool = {
  name: "skool_lessons_list",
  description:
    "List lessons/modules in a specific course. Uses the Next.js classroom data route with course parameter.",
  inputSchema: {
    community: z.string().optional().describe("Community slug. Uses default from config if omitted."),
    courseSlug: z.string().describe("The course slug/name to list lessons for"),
  },
  async handler(args: { community?: string; courseSlug: string }) {
    const config = await loadConfig();
    const slug = args.community || config.defaultCommunity;
    if (!slug) throw new Error("No community specified and no defaultCommunity in config");

    const data = (await nextDataRequest(`/${slug}/classroom/${args.courseSlug}`, {
      group: slug,
      course: args.courseSlug,
    })) as { pageProps?: Record<string, unknown> };

    const props = data?.pageProps;
    if (!props) throw new Error("No pageProps in response");

    return JSON.stringify(props, null, 2);
  },
};

export function assertLessonId(id: string): void {
  if (!/^[a-fA-F0-9]{32}$/.test(id)) throw new Error("lessonId must be 32 hexadecimal characters");
}

export async function setLessonVideo(args: { lessonId: string; videoId: string; videoLink?: string }): Promise<unknown> {
  assertLessonId(args.lessonId);
  if (!args.videoId.trim()) throw new Error("videoId is required");
  if (args.videoLink !== undefined) {
    let url: URL;
    try { url = new URL(args.videoLink); } catch { throw new Error("Invalid videoLink"); }
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Invalid videoLink");
  }
  const response = await api2Request(`/courses/${args.lessonId}`) as Record<string, unknown>;
  const lesson = (response?.course ?? response?.data ?? response) as Record<string, unknown>;
  // Fail closed: never issue a partial PUT when the read lacks required lesson state.
  const fields = ["title", "desc", "resources", "transcript", "privacy", "min_tier", "state"];
  if (!lesson || fields.some(key => !Object.prototype.hasOwnProperty.call(lesson, key))) {
    throw new Error("Lesson read is missing fields required for a full update");
  }
  return api2Request(`/courses/${args.lessonId}`, { method: "PUT", body: {
    ...lesson, video_id: args.videoId, ...(args.videoLink !== undefined ? { video_link: args.videoLink } : {}),
  } });
}

export const lessonsSetVideoTool = {
  name: "skool_lessons_set_video",
  description: "Read a lesson and set its video with a full PUT preserving privacy and lesson state.",
  inputSchema: {
    lessonId: z.string().regex(/^[a-fA-F0-9]{32}$/),
    videoId: z.string().min(1),
    videoLink: z.string().optional(),
  },
  async handler(args: { lessonId: string; videoId: string; videoLink?: string }) {
    return JSON.stringify(await setLessonVideo(args), null, 2);
  },
};
