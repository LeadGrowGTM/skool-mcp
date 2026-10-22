import { z } from "zod";
import { api2Request } from "../client.js";

// READ-ONLY DM tools. GET only; no send/react/mark-read endpoints are called.
// Channels: GET /self/chat-channels?offset&limit (limit max 30)
// Messages: GET /channels/{id}/messages?before=N&after=N[&msg=anchorId]
//   before/after are COUNTS around the anchor message (default anchor = last read message).

type User = { id: string; name?: string; first_name?: string; last_name?: string };
type Msg = { id: string; created_at?: string; metadata?: { content?: string; src?: string; dst?: string } };
type Channel = {
  id: string;
  last_message_id?: string;
  last_message_at?: string;
  metadata?: { num_unread?: number; unread?: number; last_read?: string; last_read_at?: number };
  user?: User;
  group_id?: string;
  last_message?: Msg;
};

const shapeUser = (u?: User) =>
  u ? { id: u.id, handle: u.name, name: [u.first_name, u.last_name].filter(Boolean).join(" ") } : null;
const shapeMsg = (m: Msg) => ({
  id: m.id,
  created_at: m.created_at,
  from_user_id: m.metadata?.src ?? null,
  to_user_id: m.metadata?.dst ?? null,
  content: m.metadata?.content ?? "",
});

export const chatChannelsTool = {
  name: "skool_chat_channels",
  description:
    "Read-only list of the captain's Skool DM channels with unread state and last message. Never marks anything read. " +
    "Set include_last_message=false for a faster list without message text.",
  inputSchema: {
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(30).default(20),
    unread_only: z.boolean().default(false),
    include_last_message: z.boolean().default(true),
  },
  async handler(args: { offset: number; limit: number; unread_only: boolean; include_last_message: boolean }) {
    const data = (await api2Request("/self/chat-channels", {
      method: "GET",
      queryParams: { offset: String(args.offset), limit: String(args.limit), last: "true" },
    })) as { channels?: Channel[] };
    let chans = data.channels ?? [];
    if (args.unread_only) chans = chans.filter((c) => (c.metadata?.num_unread ?? 0) > 0);
    const out = [];
    for (const c of chans) {
      let last: ReturnType<typeof shapeMsg> | null = null;
      if (args.include_last_message && c.last_message_id) {
        const m = (await api2Request(`/channels/${c.id}/messages`, {
          method: "GET",
          queryParams: { before: "1", after: "0", msg: c.last_message_id },
        }).catch(() => null)) as { channel?: Channel; messages?: Msg[] } | null;
        const lm = m?.messages?.find((x) => x.id === c.last_message_id) ?? m?.channel?.last_message;
        if (lm) last = shapeMsg(lm);
      }
      out.push({
        id: c.id,
        other_user: shapeUser(c.user),
        group_id: c.group_id ?? null,
        unread: (c.metadata?.num_unread ?? 0) > 0,
        num_unread: c.metadata?.num_unread ?? 0,
        last_message_at: c.last_message_at ?? null,
        last_message: last,
      });
    }
    return JSON.stringify(
      { channels: out, next_offset: (data.channels?.length ?? 0) === args.limit ? args.offset + args.limit : null },
      null,
      2,
    );
  },
};

export const chatMessagesTool = {
  name: "skool_chat_messages",
  description:
    "Read-only messages for a Skool DM channel id, oldest first. Never marks anything read. " +
    "Default returns the latest messages. Paginate older with before_message_id = the returned oldest_message_id.",
  inputSchema: {
    channel_id: z.string(),
    limit: z.number().int().min(1).max(50).default(20),
    before_message_id: z.string().optional().describe("Return messages older than this message id"),
  },
  async handler(args: { channel_id: string; limit: number; before_message_id?: string }) {
    const get = (q: Record<string, string>) =>
      api2Request(`/channels/${args.channel_id}/messages`, { method: "GET", queryParams: q }) as Promise<{
        messages?: Msg[];
        has_more_before?: boolean;
        channel?: Channel;
      }>;
    let anchor = args.before_message_id;
    let data;
    if (!anchor) {
      // find latest message id, then anchor on it
      const head = await get({ before: "0", after: "1" });
      anchor = head.channel?.last_message_id;
      if (!anchor) return JSON.stringify({ messages: [], has_more_before: false, oldest_message_id: null });
      data = await get({ before: String(args.limit - 1), after: "0", msg: anchor });
    } else {
      data = await get({ before: String(args.limit), after: "0", msg: anchor });
      data.messages = (data.messages ?? []).filter((m) => m.id !== anchor);
    }
    const msgs = (data.messages ?? []).map(shapeMsg);
    return JSON.stringify(
      {
        channel_id: args.channel_id,
        other_user: shapeUser(data.channel?.user),
        num_unread: data.channel?.metadata?.num_unread ?? 0,
        messages: msgs,
        has_more_before: Boolean(data.has_more_before),
        oldest_message_id: msgs[0]?.id ?? null,
      },
      null,
      2,
    );
  },
};
