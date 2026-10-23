#!/usr/bin/env node
// Read-only CLI for the Skool MCP tools: node scripts/skool-read.mjs <notifications|channels|messages|payouts|revenue> '<json args>'
import { z } from "zod";
import { notificationsTool } from "../dist/tools/notifications.js";
import { chatChannelsTool, chatMessagesTool } from "../dist/tools/chat.js";
import { payoutsTool, revenueTool } from "../dist/tools/billing.js";
const tools = { notifications: notificationsTool, channels: chatChannelsTool, messages: chatMessagesTool, payouts: payoutsTool, revenue: revenueTool };
const [name, json = "{}"] = process.argv.slice(2);
const t = tools[name];
if (!t) { console.error("usage: skool-read.mjs <notifications|channels|messages|payouts|revenue> '<json>'"); process.exit(2); }
console.log(await t.handler(z.object(t.inputSchema).parse(JSON.parse(json))));
