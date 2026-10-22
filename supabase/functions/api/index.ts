// TASTE The Show — ticketing API (Supabase Edge Function)
//
// Routes (all under /functions/v1/api/...):
//   GET  /status          public  — is online ticket sales switched on?
//   POST /checkout        public  — reserve seats + start a Stripe embedded checkout
//   GET  /order?id=...    public  — order status + tickets (the order id is the secret link)
//   GET  /ticket?id=...   public  — a single ticket (the share-with-a-friend link)
//   POST /stripe-webhook  Stripe  — confirms payments even if the buyer closes the tab
//   POST /staff           staff   — dashboard, guest list, door check-in, comps, settings
//
// Secrets (Supabase → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY   required to sell tickets
//   STRIPE_WEBHOOK_SECRET                       recommended
//   SITE_URL                                    optional (defaults to the GitHub Pages URL)
//   RESEND_API_KEY, EMAIL_FROM                  optional — email tickets (with QR codes) to buyers

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import QRCode from "npm:qrcode@1.5.4";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});
const STRIPE_API = env("STRIPE_API_BASE", "https://api.stripe.com");
const SITE_URL = env("SITE_URL", "https://thecreatorie.github.io/thetasteshow").replace(/\/+$/, "");
const TZ = "America/Los_Angeles";
const HOLD_MINUTES = 33; // Stripe sessions expire after 31 min; seats are held slightly longer.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fmtShowDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function friendlyDbError(message: string) {
  if (message.includes("sold_out:")) return `Sorry — ${message.split("sold_out:")[1]} just sold out or doesn't have that many left.`;
  if (message.includes("too_many:")) return `That's more ${message.split("too_many:")[1]} tickets than one order allows.`;
  if (message.includes("show_not_on_sale")) return "Tickets for this show aren't on sale.";
  if (message.includes("empty_order")) return "Please choose at least one ticket.";
  if (message.includes("missing_buyer")) return "Please enter your name and email.";
  if (message.includes("invalid_ticket_type")) return "That ticket type isn't available.";
  return "";
}

// ── Stripe (plain REST, no SDK) ──────────────────────────────────────────

function stripeForm(obj: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) =>
      typeof item === "object" ? stripeForm(item as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item)));
    else if (typeof v === "object") stripeForm(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
  const key = env("STRIPE_SECRET_KEY");
  if (!key) throw new HttpError(503, "not_configured");
  const res = await fetch(`${STRIPE_API}/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body ? stripeForm(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("Stripe error", path, data?.error?.message);
    throw new HttpError(502, "Payment provider error. Please try again.");
  }
  return data;
}

async function verifyStripeSignature(payload: string, header: string, secret: string) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = parts["t"];
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(s, expected));
}

function timingSafeEqual(a: string, b: string) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Orders ──────────────────────────────────────────────────────────────

async function loadOrder(id: string) {
  const { data, error } = await db
    .from("orders")
    .select(`id, status, buyer_name, buyer_email, amount_cents, stripe_session_id, emailed_at, created_at, paid_at,
             show:shows(id, title, starts_at, doors_at, ends_at, venue, address),
             items:order_items(quantity, unit_price_cents, ticket_type:ticket_types(name)),
             tickets(id, code, label, checked_in_at, voided, ticket_type:ticket_types(name, sort))`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function markPaid(orderId: string, amountCents?: number) {
  const { error } = await db.rpc("mark_order_paid", { p_order_id: orderId, p_amount_cents: amountCents ?? null });
  if (error) throw error;
}

// Ask Stripe whether a pending order has been paid (covers a missed/slow webhook).
async function syncWithStripe(order: { id: string; status: string; stripe_session_id: string | null }) {
  if (order.status !== "pending" || !order.stripe_session_id || !env("STRIPE_SECRET_KEY")) return false;
  const session = await stripe("GET", `checkout/sessions/${order.stripe_session_id}`);
  if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
    await markPaid(order.id, session.amount_total);
    return true;
  }
  if (session.status === "expired") {
    await db.from("orders").update({ status: "expired" }).eq("id", order.id).eq("status", "pending");
    return true;
  }
  return false;
}

// ── Ticket email (neon Vegas branding, QR codes embedded inline) ──────────

type EmailResult = { sent: boolean; error?: string };

// Logo for the email header, fetched from the site (glow version first, plain logo as fallback).
let cachedLogo: string | null = null;
async function logoBase64(): Promise<string | null> {
  if (cachedLogo) return cachedLogo;
  for (const name of ["logo-glow-sm.png", "logo.png"]) {
    try {
      const res = await fetch(`${SITE_URL}/assets/img/${name}`);
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const b64 = btoa(bin);
      if (name === "logo-glow-sm.png") cachedLogo = b64;
      return b64;
    } catch (_) { /* try the next one */ }
  }
  return null;
}

async function qrPngBase64(text: string) {
  const buf: Uint8Array = await QRCode.toBuffer(text, { type: "png", width: 360, margin: 2, errorCorrectionLevel: "M" });
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fmtLong(iso: string, opts: Intl.DateTimeFormatOptions) {
  return new Date(iso).toLocaleString("en-US", { timeZone: TZ, ...opts });
}

function ticketEmailHtml(order: { id: string; buyer_name: string }, show: { title: string; starts_at: string; doors_at: string | null; venue: string; address: string },
  tickets: { id: string; code: string; label: string }[]) {
  const first = escapeHtml(order.buyer_name.split(" ")[0] || order.buyer_name);
  const link = `${SITE_URL}/tickets.html?order=${order.id}`;
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(show.venue + " " + show.address)}`;
  const date = fmtLong(show.starts_at, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const showTime = fmtLong(show.starts_at, { hour: "numeric", minute: "2-digit" });
  const doors = show.doors_at ? fmtLong(show.doors_at, { hour: "numeric", minute: "2-digit" }) : "";
  const pink = "#ff2ed1", gold = "#ffd36b", ink = "#07020d", panel = "#170a22", muted = "#b9a6cf";
  const display = "'Barlow Condensed','Arial Narrow',Impact,'Helvetica Neue',Arial,sans-serif";
  const body = "'Space Grotesk','Helvetica Neue',Arial,sans-serif";
  const script = "'Yellowtail','Brush Script MT','Snell Roundhand',Georgia,cursive";
  const bulbs = `<div style="height:10px;line-height:10px;font-size:0;background:${ink};background-image:radial-gradient(circle,${gold} 0 3px,transparent 4px);background-size:18px 10px;background-repeat:repeat-x;background-position:center">&nbsp;</div>`;

  const cards = tickets.map((t, i) => `
          <tr><td style="padding:0 0 18px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border:2px solid ${pink};border-radius:16px;background:${panel}">
              <tr><td align="center" style="padding:14px 16px 10px;border-bottom:2px dashed rgba(255,46,209,.55)">
                <div style="font:italic 900 22px/1 ${display};letter-spacing:2px;color:#ffffff;text-transform:uppercase">TASTE</div>
                <div style="font:600 12px/1.4 ${body};letter-spacing:3px;color:${gold};text-transform:uppercase;padding-top:6px">${escapeHtml(t.label)}</div>
              </td></tr>
              <tr><td align="center" style="padding:18px 16px 8px">
                <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#ffffff;border-radius:12px;padding:10px">
                  <img src="cid:qr-${i}" width="200" height="200" alt="QR code ${t.code}" style="display:block;width:200px;height:200px;border:0">
                </td></tr></table>
              </td></tr>
              <tr><td align="center" style="padding:6px 16px 18px">
                <div style="font:700 20px/1 'Courier New',Courier,monospace;letter-spacing:3px;color:#ffffff">${t.code}</div>
                <div style="font:400 13px/1.4 ${body};color:${muted};padding-top:6px">Ticket ${i + 1} of ${tickets.length} · ${escapeHtml(order.buyer_name)}</div>
                ${tickets.length > 1 ? `<div style="padding-top:12px"><a href="${SITE_URL}/tickets.html?t=${t.id}" style="font:600 13px/1 ${body};color:${gold};text-decoration:underline">Send this ticket to a friend →</a></div>` : ""}
              </td></tr>
            </table>
          </td></tr>`).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@1,900&family=Space+Grotesk:wght@400;600;700&family=Yellowtail&display=swap" rel="stylesheet">
<title>Your TASTE tickets</title></head>
<body style="margin:0;padding:0;background:${ink};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">You're in! ${tickets.length} ticket${tickets.length === 1 ? "" : "s"} for ${date} at ${escapeHtml(show.venue)}. Your QR codes are inside.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${ink}">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${ink};border-radius:22px;border:2px solid #4a1640">
      <tr><td style="border-radius:20px 20px 0 0;overflow:hidden">${bulbs}</td></tr>
      <tr><td align="center" style="padding:26px 24px 6px;background:${ink};background-image:radial-gradient(ellipse at 50% 0%,#4a0f3d 0%,${ink} 70%)">
        <img src="cid:taste-logo" width="260" alt="TASTE The Show" style="display:block;width:260px;max-width:80%;height:auto;border:0;margin:0 auto">
      </td></tr>
      <tr><td align="center" style="padding:10px 28px 0">
        <div style="font:400 34px/1.1 ${script};color:#fff3d6;text-shadow:0 0 8px ${gold},0 0 18px #ffab2e">You're in, ${first}!</div>
        <div style="font:400 16px/1.6 ${body};color:${muted};padding-top:10px">Your tickets for <strong style="color:#ffffff">${escapeHtml(show.title)}</strong> are confirmed. Get ready for a night of pole, burlesque and pure entertainment.</div>
      </td></tr>
      <tr><td style="padding:24px 24px 6px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;background:${panel};border:1px solid rgba(255,211,107,.45);border-radius:16px">
          <tr><td style="padding:18px 20px">
            <div style="font:italic 900 30px/1.05 ${display};color:#ffffff;text-transform:uppercase;letter-spacing:.5px;text-shadow:0 0 10px ${pink}">${date}</div>
            <div style="font:600 15px/1.6 ${body};color:${gold};padding-top:8px">${doors ? `Doors ${doors} &nbsp;·&nbsp; ` : ""}Show ${showTime}</div>
            <div style="font:400 15px/1.6 ${body};color:#ffffff;padding-top:4px">${escapeHtml(show.venue)}<br><span style="color:${muted}">${escapeHtml(show.address)}</span></div>
            <div style="padding-top:10px"><a href="${maps}" style="font:600 13px/1 ${body};color:${pink};text-decoration:underline">Get directions →</a></div>
          </td></tr>
        </table>
      </td></tr>
      <tr><td align="center" style="padding:22px 24px 8px">
        <a href="${link}" style="display:inline-block;background:${pink};background-image:linear-gradient(180deg,#ff5fdc,#e60fb4);border:2px solid #ffb3f0;border-radius:999px;padding:15px 30px;font:700 14px/1 ${body};letter-spacing:2px;text-transform:uppercase;color:#ffffff;text-decoration:none">View tickets online</a>
      </td></tr>
      <tr><td align="center" style="padding:18px 24px 6px">
        <div style="font:400 28px/1.1 ${script};color:#fff3d6;text-shadow:0 0 8px ${gold}">Your tickets</div>
        <div style="font:400 14px/1.6 ${body};color:${muted};padding-top:6px">One QR code per guest. Each code gets one person in, once.${tickets.length > 1 ? " Friends arriving separately? Send each of them their own ticket." : ""}</div>
      </td></tr>
      <tr><td style="padding:14px 24px 4px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards}
        </table>
      </td></tr>
      <tr><td style="padding:4px 24px 22px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border:1px dashed rgba(255,211,107,.5);border-radius:14px">
          <tr><td style="padding:16px 18px;font:400 14px/1.7 ${body};color:#ffffff">
            <span style="color:${gold};font-weight:700">★ Good to know</span><br>
            Show your QR code (or a screenshot) at the door.<br>
            Doors open ${doors || "one hour before showtime"} — come early, grab a drink, settle in.<br>
            Bring your tipping money — we'll make change for you!
          </td></tr>
        </table>
      </td></tr>
      <tr><td>${bulbs}</td></tr>
      <tr><td align="center" style="padding:18px 24px 26px;font:400 12px/1.7 ${body};color:${muted}">
        TASTE The Show · Created &amp; produced by Fawnia Mondey<br>
        ${escapeHtml(show.venue)} · ${escapeHtml(show.address)}<br>
        <a href="https://www.instagram.com/tastetheshow/" style="color:${pink};text-decoration:none">@tastetheshow</a> &nbsp;·&nbsp; <a href="${SITE_URL}/" style="color:${pink};text-decoration:none">${SITE_URL.replace(/^https?:\/\//, "")}</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function ticketEmailText(order: { id: string; buyer_name: string }, show: { title: string; starts_at: string; doors_at: string | null; venue: string; address: string }, tickets: { id: string; code: string; label: string }[]) {
  const lines = tickets.map((t, i) => `  ${i + 1}. ${t.label}: ${t.code}${tickets.length > 1 ? `\n     Send to a friend: ${SITE_URL}/tickets.html?t=${t.id}` : ""}`).join("\n");
  return `You're in, ${order.buyer_name.split(" ")[0]}!

${show.title}
${fmtLong(show.starts_at, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
${show.doors_at ? `Doors ${fmtLong(show.doors_at, { hour: "numeric", minute: "2-digit" })} · ` : ""}Show ${fmtLong(show.starts_at, { hour: "numeric", minute: "2-digit" })}
${show.venue} · ${show.address}

Your tickets (one code per guest, each admits one person once):
${lines}

View your tickets & QR codes: ${SITE_URL}/tickets.html?order=${order.id}

Bring your tipping money — we'll make change for you!
TASTE The Show · @tastetheshow`;
}

async function emailTickets(orderId: string, opts: { force?: boolean } = {}): Promise<EmailResult> {
  const apiKey = env("RESEND_API_KEY");
  const from = env("EMAIL_FROM");
  if (!apiKey || !from) return { sent: false, error: "Email isn't set up yet." };
  // Claim the send first so a webhook and a page load can't both email.
  let q = db.from("orders").update({ emailed_at: new Date().toISOString() }).eq("id", orderId).in("status", ["paid", "comp"]);
  if (!opts.force) q = q.is("emailed_at", null);
  const { data: claimed } = await q.select("id");
  if (!claimed?.length) return { sent: false, error: "Already emailed." };
  const order = await loadOrder(orderId);
  if (!order) return { sent: false, error: "Order not found." };
  const show = order.show as unknown as { title: string; starts_at: string; doors_at: string | null; venue: string; address: string };
  const tickets = (order.tickets as unknown as { id: string; code: string; label: string; voided: boolean; ticket_type: { sort: number } }[])
    .filter((t) => !t.voided)
    .sort((a, b) => a.ticket_type.sort - b.ticket_type.sort || a.label.localeCompare(b.label, undefined, { numeric: true }));
  try {
    const logo = await logoBase64();
    const attachments = [
      ...(logo ? [{ content: logo, filename: "taste-logo.png", content_id: "taste-logo" }] : []),
      ...(await Promise.all(tickets.map(async (t, i) => ({ content: await qrPngBase64(t.code), filename: `${t.code}.png`, content_id: `qr-${i}` })))),
    ];
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [order.buyer_email],
        subject: `🎟️ Your TASTE tickets — ${fmtShowDate(show.starts_at)} · ${show.venue}`,
        html: ticketEmailHtml(order, show, tickets),
        text: ticketEmailText(order, show, tickets),
        attachments,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("Email failed", body);
      await db.from("orders").update({ emailed_at: null }).eq("id", orderId);
      let msg = "The email service rejected the message.";
      try { msg = JSON.parse(body).message || msg; } catch { /* keep default */ }
      return { sent: false, error: msg };
    }
    return { sent: true };
  } catch (e) {
    console.error("Email failed", e);
    await db.from("orders").update({ emailed_at: null }).eq("id", orderId);
    return { sent: false, error: "Couldn't build the email." };
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ── Public routes ───────────────────────────────────────────────────────

async function checkout(req: Request) {
  if (!env("STRIPE_SECRET_KEY") || !env("STRIPE_PUBLISHABLE_KEY")) throw new HttpError(503, "not_configured");
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim().slice(0, 120);
  const email = String(body.email ?? "").trim().slice(0, 200);
  const phone = String(body.phone ?? "").trim().slice(0, 40);
  if (!UUID.test(String(body.show_id))) throw new HttpError(400, "Please choose a show.");
  if (!name) throw new HttpError(400, "Please enter your name.");
  if (!EMAIL.test(email)) throw new HttpError(400, "Please enter a valid email address.");
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((i: { ticket_type_id: string; quantity: number }) => UUID.test(String(i?.ticket_type_id)) && Number(i.quantity) > 0)
    .map((i: { ticket_type_id: string; quantity: number }) => ({ ticket_type_id: i.ticket_type_id, quantity: Math.floor(Number(i.quantity)) }));
  if (!items.length) throw new HttpError(400, "Please choose at least one ticket.");

  const { data: orderId, error } = await db.rpc("create_order", {
    p_show_id: body.show_id, p_items: items, p_name: name, p_email: email, p_phone: phone, p_hold_minutes: HOLD_MINUTES,
  });
  if (error) {
    const msg = friendlyDbError(error.message);
    if (msg) throw new HttpError(409, msg);
    throw error;
  }

  const order = await loadOrder(orderId as string);
  const show = order!.show as unknown as { title: string; starts_at: string };
  const link = `${SITE_URL}/tickets.html?order=${orderId}`;
  try {
    const session = await stripe("POST", "checkout/sessions", {
      ui_mode: "embedded",
      mode: "payment",
      customer_email: email,
      return_url: link,
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      metadata: { order_id: orderId },
      payment_intent_data: {
        metadata: { order_id: orderId },
        description: `${show.title} — ${fmtShowDate(show.starts_at)}. Your tickets & QR codes: ${link}`,
      },
      line_items: (order!.items as unknown as { quantity: number; unit_price_cents: number; ticket_type: { name: string } }[]).map((it) => ({
        quantity: it.quantity,
        price_data: {
          currency: "usd",
          unit_amount: it.unit_price_cents,
          product_data: { name: `${it.ticket_type.name} — ${show.title}`, description: fmtShowDate(show.starts_at) },
        },
      })),
    });
    await db.from("orders").update({ stripe_session_id: session.id }).eq("id", orderId);
    return json({ order_id: orderId, client_secret: session.client_secret, publishable_key: env("STRIPE_PUBLISHABLE_KEY") });
  } catch (e) {
    // Release the held seats if Stripe couldn't start the checkout.
    await db.from("orders").update({ status: "expired" }).eq("id", orderId).eq("status", "pending");
    throw e;
  }
}

async function getOrder(url: URL) {
  const id = url.searchParams.get("id") ?? "";
  if (!UUID.test(id)) throw new HttpError(404, "Order not found.");
  let order = await loadOrder(id);
  if (!order) throw new HttpError(404, "Order not found.");
  if (await syncWithStripe(order)) order = (await loadOrder(id))!;
  if (["paid", "comp"].includes(order.status) && !order.emailed_at) await emailTickets(order.id);

  const tickets = (order.tickets as unknown as { id: string; code: string; label: string; checked_in_at: string | null; voided: boolean; ticket_type: { name: string; sort: number } }[])
    .filter((t) => !t.voided)
    .sort((a, b) => a.ticket_type.sort - b.ticket_type.sort || a.label.localeCompare(b.label, undefined, { numeric: true }))
    .map((t) => ({ id: t.id, code: t.code, label: t.label, ticket_type: t.ticket_type.name, checked_in: !!t.checked_in_at }));
  return json({
    id: order.id,
    status: order.status,
    buyer_name: order.buyer_name,
    amount_cents: order.amount_cents,
    show: order.show,
    items: (order.items as unknown as { quantity: number; unit_price_cents: number; ticket_type: { name: string } }[])
      .map((i) => ({ name: i.ticket_type.name, quantity: i.quantity, unit_price_cents: i.unit_price_cents })),
    tickets: ["paid", "comp"].includes(order.status) ? tickets : [],
  });
}

// One ticket on its own — the link a buyer sends to a friend. The ticket id is
// a random UUID, so it only reveals this single ticket, not the whole order.
async function getTicket(url: URL) {
  const id = url.searchParams.get("id") ?? "";
  if (!UUID.test(id)) throw new HttpError(404, "Ticket not found.");
  const { data: t, error } = await db.from("tickets")
    .select("id, code, label, voided, checked_in_at, ticket_type:ticket_types(name), order:orders!inner(status, buyer_name), show:shows(title, starts_at, doors_at, ends_at, venue, address)")
    .eq("id", id).maybeSingle();
  if (error) throw error;
  const order = t?.order as unknown as { status: string; buyer_name: string } | undefined;
  if (!t || !order || !["paid", "comp"].includes(order.status) || t.voided) throw new HttpError(404, "Ticket not found.");
  return json({
    id: t.id, code: t.code, label: t.label, checked_in: !!t.checked_in_at,
    ticket_type: (t.ticket_type as unknown as { name: string }).name,
    from_name: order.buyer_name, show: t.show,
  });
}

async function stripeWebhook(req: Request) {
  const secret = env("STRIPE_WEBHOOK_SECRET");
  const payload = await req.text();
  if (!secret || !(await verifyStripeSignature(payload, req.headers.get("stripe-signature") ?? "", secret))) {
    return json({ error: "bad signature" }, 400);
  }
  const event = JSON.parse(payload);
  const session = event.data?.object ?? {};
  const orderId = session.metadata?.order_id;
  if (!orderId || !UUID.test(orderId)) return json({ received: true });

  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type) &&
      ["paid", "no_payment_required"].includes(session.payment_status)) {
    await markPaid(orderId, session.amount_total);
    await emailTickets(orderId);
  } else if (["checkout.session.expired", "checkout.session.async_payment_failed"].includes(event.type)) {
    await db.from("orders").update({ status: "expired" }).eq("id", orderId).eq("status", "pending");
  }
  return json({ received: true });
}

// ── Staff routes ────────────────────────────────────────────────────────

const DEFAULT_TICKET_TYPES = [
  { name: "General Admission", description: "Entry to the show. Open seating.", price_cents: 3500, capacity: 100, admits: 1, max_per_order: 10, sort: 1 },
  { name: "VIP", description: "Premium seating close to the stage.", price_cents: 6500, capacity: 30, admits: 1, max_per_order: 10, sort: 2 },
  { name: "Table for 4", description: "A reserved table for your group of four. Each guest gets their own ticket.", price_cents: 30000, capacity: 6, admits: 4, max_per_order: 2, sort: 3 },
];

async function staff(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { data: ok, error: pwErr } = await db.rpc("check_staff_password", { p_password: String(body.password ?? "") });
  if (pwErr) throw pwErr;
  if (!ok) {
    await new Promise((r) => setTimeout(r, 800));
    throw new HttpError(401, "Wrong staff password.");
  }

  switch (body.action) {
    case "login":
      return json({ ok: true, stripe_configured: !!env("STRIPE_SECRET_KEY") && !!env("STRIPE_PUBLISHABLE_KEY"), email_configured: !!env("RESEND_API_KEY") && !!env("EMAIL_FROM") });

    case "shows": {
      const { data: shows, error } = await db.from("shows")
        .select("*, ticket_types(*)").order("starts_at", { ascending: false });
      if (error) throw error;
      const { data: sold, error: e2 } = await db.from("order_items")
        .select("ticket_type_id, quantity, unit_price_cents, order:orders!inner(status)")
        .in("order.status", ["paid", "comp"]);
      if (e2) throw e2;
      const stats: Record<string, { sold: number; revenue_cents: number }> = {};
      for (const r of sold ?? []) {
        const s = (stats[r.ticket_type_id] ??= { sold: 0, revenue_cents: 0 });
        s.sold += r.quantity;
        s.revenue_cents += r.quantity * r.unit_price_cents;
      }
      const { data: checked } = await db.from("tickets").select("show_id").not("checked_in_at", "is", null);
      const checkedByShow: Record<string, number> = {};
      for (const t of checked ?? []) checkedByShow[t.show_id] = (checkedByShow[t.show_id] ?? 0) + 1;
      return json({
        shows: (shows ?? []).map((s) => ({
          ...s,
          checked_in: checkedByShow[s.id] ?? 0,
          ticket_types: (s.ticket_types ?? []).sort((a: { sort: number }, b: { sort: number }) => a.sort - b.sort)
            .map((t: { id: string }) => ({ ...t, ...(stats[t.id] ?? { sold: 0, revenue_cents: 0 }) })),
        })),
      });
    }

    case "save-show": {
      const s = body.show ?? {};
      const row = {
        title: String(s.title || "TASTE The Show").slice(0, 120),
        starts_at: s.starts_at, doors_at: s.doors_at || null, ends_at: s.ends_at || null,
        venue: String(s.venue ?? "").slice(0, 120), address: String(s.address ?? "").slice(0, 200),
        on_sale: !!s.on_sale,
      };
      if (!row.starts_at || isNaN(Date.parse(row.starts_at))) throw new HttpError(400, "Please set the show date and time.");
      if (s.id) {
        const { error } = await db.from("shows").update(row).eq("id", s.id);
        if (error) throw error;
        return json({ id: s.id });
      }
      const { data, error } = await db.from("shows").insert(row).select("id").single();
      if (error) throw error;
      const { error: e2 } = await db.from("ticket_types").insert(DEFAULT_TICKET_TYPES.map((t) => ({ ...t, show_id: data.id })));
      if (e2) throw e2;
      return json({ id: data.id });
    }

    case "save-ticket-type": {
      const t = body.ticket_type ?? {};
      const row = {
        name: String(t.name ?? "").trim().slice(0, 80),
        description: String(t.description ?? "").slice(0, 300),
        price_cents: Math.round(Number(t.price_cents)),
        capacity: Math.floor(Number(t.capacity)),
        admits: Math.floor(Number(t.admits) || 1),
        max_per_order: Math.floor(Number(t.max_per_order) || 10),
        sort: Math.floor(Number(t.sort) || 0),
        active: t.active !== false,
      };
      if (!row.name || !(row.price_cents >= 0) || !(row.capacity >= 0)) throw new HttpError(400, "Name, price and capacity are required.");
      if (t.id) {
        const { error } = await db.from("ticket_types").update(row).eq("id", t.id);
        if (error) throw error;
        return json({ id: t.id });
      }
      if (!UUID.test(String(t.show_id))) throw new HttpError(400, "Missing show.");
      const { data, error } = await db.from("ticket_types").insert({ ...row, show_id: t.show_id }).select("id").single();
      if (error) throw error;
      return json({ id: data.id });
    }

    case "attendees": {
      if (!UUID.test(String(body.show_id))) throw new HttpError(400, "Missing show.");
      const { data, error } = await db.from("tickets")
        .select("id, code, holder_name, label, voided, checked_in_at, ticket_type:ticket_types(name, sort), order:orders!inner(id, buyer_email, buyer_phone, status, note, created_at)")
        .eq("show_id", body.show_id)
        .in("order.status", ["paid", "comp"]);
      if (error) throw error;
      return json({ tickets: data });
    }

    case "checkin": {
      const { data, error } = await db.rpc("check_in", { p_code: String(body.code ?? ""), p_undo: !!body.undo });
      if (error) throw error;
      return json(data);
    }

    case "comp": {
      const name = String(body.name ?? "").trim();
      const email = String(body.email ?? "").trim() || "comp@tastetheshow.local";
      const { data: orderId, error } = await db.rpc("create_order", {
        p_show_id: body.show_id, p_items: body.items ?? [], p_name: name, p_email: email, p_phone: "",
        p_comp: true, p_note: String(body.note ?? "").slice(0, 200),
      });
      if (error) {
        const msg = friendlyDbError(error.message);
        if (msg) throw new HttpError(409, msg);
        throw error;
      }
      const emailResult = EMAIL.test(String(body.email ?? "")) ? await emailTickets(orderId as string) : null;
      return json({ order_id: orderId, link: `${SITE_URL}/tickets.html?order=${orderId}`, email: emailResult });
    }

    case "resend-email": {
      if (!UUID.test(String(body.order_id))) throw new HttpError(400, "Missing order.");
      return json(await emailTickets(body.order_id, { force: true }));
    }

    case "void": {
      if (!UUID.test(String(body.ticket_id))) throw new HttpError(400, "Missing ticket.");
      const { error } = await db.from("tickets").update({ voided: !!body.voided }).eq("id", body.ticket_id);
      if (error) throw error;
      return json({ ok: true });
    }

    case "set-password": {
      const pw = String(body.new_password ?? "");
      if (pw.length < 8) throw new HttpError(400, "Use at least 8 characters.");
      const { error } = await db.rpc("set_staff_password", { p_password: pw });
      if (error) throw error;
      return json({ ok: true });
    }

    default:
      throw new HttpError(400, "Unknown action.");
  }
}

// ── Router ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const route = url.pathname.replace(/\/+$/, "").split("/").pop();
  try {
    if (route === "status" && req.method === "GET") return json({ sales_open: !!env("STRIPE_SECRET_KEY") && !!env("STRIPE_PUBLISHABLE_KEY") });
    if (route === "checkout" && req.method === "POST") return await checkout(req);
    if (route === "order" && req.method === "GET") return await getOrder(url);
    if (route === "ticket" && req.method === "GET") return await getTicket(url);
    if (route === "stripe-webhook" && req.method === "POST") return await stripeWebhook(req);
    if (route === "staff" && req.method === "POST") return await staff(req);
    return json({ error: "Not found" }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
