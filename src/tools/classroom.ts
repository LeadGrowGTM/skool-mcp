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
    lessonId: z.string().regex(/^[a-fA-F0-9]{32}$/).optional().describe("Lesson UUID to include its video details"),
  },
  async handler(args: { community?: string; courseSlug: string; lessonId?: string }) {
    const config = await loadConfig();
    const slug = args.community || config.defaultCommunity;
    if (!slug) throw new Error("No community specified and no defaultCommunity in config");

    const params: Record<string, string> = { group: slug, course: args.courseSlug };
    if (args.lessonId) params.md = args.lessonId;
    let data = (await nextDataRequest(`/${slug}/classroom/${args.courseSlug}`, params)) as { pageProps?: Record<string, unknown> };
    const redirect = data.pageProps?.__N_REDIRECT;
    if (typeof redirect === "string" && !args.lessonId) {
      const url = new URL(redirect, "https://www.skool.com");
      const md = url.searchParams.get("md");
      if (md && /^[a-fA-F0-9]{32}$/.test(md)) {
        data = await nextDataRequest(`/${slug}/classroom/${args.courseSlug}`, { ...params, md }) as typeof data;
      }
    }
    const props = data?.pageProps;
    if (props?.__N_REDIRECT) throw new Error("Classroom redirected without an accessible lesson");
    if (!props) throw new Error("No pageProps in response");

    return JSON.stringify(props, null, 2);
  },
};
