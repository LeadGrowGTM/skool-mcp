import { z } from "zod";
import { api2Request } from "../client.js";
import { loadConfig } from "../config.js";

// READ-ONLY. GET https://api2.skool.com/self/notifications?type=all[&cursor=...]
// Does not mark anything read (no POST/PUT is ever issued here).

type RawNotif = {
  id: string;
  action?: string;
  unread?: boolean;
  created_at?: string;
  group_id?: string;
  metadata?: { data?: string };
};

function category(action: string): string {
  if (action.startsWith("mention")) return "mention";
  if (action.includes("reply")) return "reply";
  if (action.startsWith("comment")) return "comment";
  if (action.includes("member") || action.includes("join")) return "new_member";
  if (action.startsWith("upvote") || action.includes("like")) return "like";
  if (action === "new-post") return "new_post";
  return "other";
}

export const notificationsTool = {
  name: "skool_notifications",
  description:
    "Read-only list of the captain's Skool notifications (mentions, replies, comments on his posts, new members, likes, etc.) " +
    "with id, timestamp, link and read/unread. Never marks anything read. Paginate with the returned cursor.",
  inputSchema: {
    cursor: z.string().optional().describe("Cursor from a previous call's next_cursor"),
    categories: z
      .array(z.enum(["mention", "reply", "comment", "new_member", "like", "new_post", "other"]))
      .optional()
      .describe("Only return these categories (default: all)"),
    unread_only: z.boolean().default(false).describe("Only unread notifications"),
  },
  async handler(args: { cursor?: string; categories?: string[]; unread_only?: boolean }) {
    const config = await loadConfig();
    const q: Record<string, string> = { type: "all" };
    if (args.cursor) q.cursor = args.cursor;
    const data = (await api2Request("/self/notifications", { method: "GET", queryParams: q })) as {
      messages?: RawNotif[];
      has_more?: boolean;
      cursor?: string;
    };
    let items = (data.messages ?? []).map((m) => {
      let d: Record<string, unknown> = {};
      try { d = JSON.parse(m.metadata?.data ?? "{}"); } catch { /* ignore */ }
      const action = String(m.action ?? d.action ?? "");
      const href = (d.link_as as string) || (d.link_href as string) || "";
      return {
        id: m.id,
        category: category(action),
        action,
        unread: Boolean(m.unread),
        created_at: m.created_at,
        link: href ? new URL(href, config.baseUrl).toString() : null,
        actor_user_id: d.src_user_id ?? null,
        actor_name: d.display_name ?? null,
        text: d.text ?? null,
        content: d.content ?? null,
        post_id: d.post_id ?? null,
        root_post_id: d.root_post_id ?? null,
        group_id: m.group_id ?? d.group_id ?? null,
        group_name: d.group_display_name ?? null,
      };
    });
    if (args.categories?.length) items = items.filter((i) => args.categories!.includes(i.category));
    if (args.unread_only) items = items.filter((i) => i.unread);
    return JSON.stringify(
      { notifications: items, has_more: Boolean(data.has_more), next_cursor: data.has_more ? data.cursor : null },
      null,
      2,
    );
  },
};
