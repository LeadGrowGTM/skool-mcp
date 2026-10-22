#!/usr/bin/env node
// Read-only CLI for the Skool MCP tools: node scripts/skool-read.mjs <notifications|channels|messages> '<json args>'
import { notificationsTool } from "../dist/tools/notifications.js";
import { chatChannelsTool, chatMessagesTool } from "../dist/tools/chat.js";
const tools = { notifications: notificationsTool, channels: chatChannelsTool, messages: chatMessagesTool };
const [name, json = "{}"] = process.argv.slice(2);
const t = tools[name];
if (!t) { console.error("usage: skool-read.mjs <notifications|channels|messages> '<json>'"); process.exit(2); }
console.log(await t.handler(JSON.parse(json)));
