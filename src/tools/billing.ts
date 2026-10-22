import { z } from "zod";
import { api2Request } from "../client.js";

// READ-ONLY billing tools. GET only. Never calls payout-account, payout-account-session,
// reset, payment-method or any POST/PUT/DELETE billing endpoint.
//   GET /groups/{id}/billing-payout-data?offset&limit   -> balances + transfer (payout) history
//   GET /groups/{id}/get-billing-products-data?product_type=membership -> prices + membership_count

const cents = (n?: number) => (typeof n === "number" ? Math.round(n) / 100 : null);
const DEFAULT_GROUP = "5bb076b6d6254fb2a3f0e4347bbe47a8"; // /legion

type Transfer = { id?: string; amount?: number; currency?: string; status?: string; created?: number; created_at?: string; arrival_date?: number };

export const payoutsTool = {
  name: "skool_payouts",
  description:
    "Read-only Skool payout data for a group you own: balance (pending/available, in dollars) and payout (transfer) history. " +
    "Never triggers a payout or changes payout settings. Bank account is shown masked only.",
  inputSchema: {
    groupId: z.string().default(DEFAULT_GROUP),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  },
  async handler(args: { groupId: string; offset: number; limit: number }) {
    const d = (await api2Request(`/groups/${args.groupId}/billing-payout-data`, {
      method: "GET",
      queryParams: { offset: String(args.offset), limit: String(args.limit) },
    })) as {
      balances?: Record<string, { currency: string; balance?: number; pending?: number; available?: number; next_transfer?: number }>;
      transfers?: Record<string, { transfers: Transfer[] | null; has_more?: boolean }>;
      payout_account_status?: string;
    };
    const balances = Object.values(d.balances ?? {}).map((b) => ({
      currency: b.currency, balance: cents(b.balance), pending: cents(b.pending), available: cents(b.available), next_transfer: cents(b.next_transfer),
    }));
    const payouts = Object.entries(d.transfers ?? {}).flatMap(([cur, t]) =>
      (t.transfers ?? []).map((x) => ({
        id: x.id ?? null,
        currency: x.currency ?? cur,
        amount: cents(x.amount),
        status: x.status ?? null,
        created: x.created_at ?? (x.created ? new Date(x.created * 1000).toISOString() : null),
        arrival_date: x.arrival_date ? new Date(x.arrival_date * 1000).toISOString().slice(0, 10) : null,
      })),
    );
    const has_more = Object.values(d.transfers ?? {}).some((t) => t.has_more);
    return JSON.stringify({ payout_account_status: d.payout_account_status ?? null, balances, payouts, has_more }, null, 2);
  },
};

export const revenueTool = {
  name: "skool_revenue",
  description:
    "Read-only Skool revenue snapshot for a group you own: each membership price with its active membership count, and MRR " +
    "computed from those (annual prices divided by 12). Gross, before Skool/Stripe fees.",
  inputSchema: { groupId: z.string().default(DEFAULT_GROUP) },
  async handler(args: { groupId: string }) {
    const d = (await api2Request(`/groups/${args.groupId}/get-billing-products-data`, {
      method: "GET",
      queryParams: { product_type: "membership" },
    })) as { billing_products?: { id: string; currency: string; amount: number; recurring_interval?: string; metadata?: { membership_count?: number } }[] };
    const prices = (d.billing_products ?? []).map((p) => {
      const n = p.metadata?.membership_count ?? 0;
      const amt = p.amount / 100;
      const monthly = p.recurring_interval === "year" ? amt / 12 : p.recurring_interval === "month" ? amt : 0;
      return { id: p.id, currency: p.currency, amount: amt, interval: p.recurring_interval ?? "one_time", memberships: n, mrr: Math.round(monthly * n * 100) / 100 };
    });
    const mrr = Math.round(prices.reduce((s, p) => s + p.mrr, 0) * 100) / 100;
    const paying = prices.reduce((s, p) => s + p.memberships, 0);
    return JSON.stringify({ as_of: new Date().toISOString(), currency: prices[0]?.currency ?? "usd", paying_memberships: paying, mrr_gross: mrr, prices }, null, 2);
  },
};
