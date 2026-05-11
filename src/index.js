// Yander holding-page Worker.
//
// Two responsibilities:
//   1. Serve the static site (handled by the `assets` binding in wrangler.jsonc)
//   2. Handle POST /subscribe — capture an email signup and forward it to
//      hello@yander.app via MailChannels (free for Cloudflare Workers).
//   3. 301 redirect www.yander.app -> yander.app so we have a single canonical host.

const NOTIFY_TO = "hello@yander.app"; // forwarded by Cloudflare Email Routing -> getyander@gmail.com
const NOTIFY_FROM_NAME = "Yander Signups";
const NOTIFY_FROM = "noreply@yander.app";
const ALLOWED_ORIGINS = new Set([
  "https://yander.app",
  "https://www.yander.app",
]);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isEmail(value) {
  if (typeof value !== "string") return false;
  if (value.length > 254) return false;
  // Pragmatic check — RFC-perfect regexes are silly. Server-side is a sanity gate, not authoritative.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://yander.app";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

async function handleSubscribe(request, env) {
  const origin = request.headers.get("Origin") || "";
  const cors = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  // Accept JSON or form-encoded — keeps the site working with or without JS.
  let email = "";
  let source = "";
  const contentType = request.headers.get("Content-Type") || "";
  try {
    if (contentType.includes("application/json")) {
      const body = await request.json();
      email = (body.email || "").trim();
      source = (body.source || "").trim();
    } else {
      const form = await request.formData();
      email = (form.get("email") || "").toString().trim();
      source = (form.get("source") || "").toString().trim();
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: "Could not read request body." }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  if (!isEmail(email)) {
    return new Response(
      JSON.stringify({ ok: false, error: "Please enter a valid email address." }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  const when = new Date().toISOString();
  const ipCountry = request.headers.get("CF-IPCountry") || "??";
  const userAgent = request.headers.get("User-Agent") || "";
  const refererHost = (() => {
    try { return new URL(request.headers.get("Referer") || "").host; }
    catch { return ""; }
  })();

  const subject = `New Yander signup — ${email}`;
  const html =
    `<p>A new email signup landed on the Yander holding page.</p>` +
    `<table cellpadding="6" cellspacing="0" border="0" style="font-family:system-ui,sans-serif;font-size:14px">` +
    `<tr><td><strong>Email</strong></td><td>${escapeHtml(email)}</td></tr>` +
    `<tr><td><strong>When</strong></td><td>${escapeHtml(when)}</td></tr>` +
    `<tr><td><strong>Country</strong></td><td>${escapeHtml(ipCountry)}</td></tr>` +
    `<tr><td><strong>Source</strong></td><td>${escapeHtml(source || refererHost || "(direct)")}</td></tr>` +
    `<tr><td><strong>User-Agent</strong></td><td>${escapeHtml(userAgent)}</td></tr>` +
    `</table>`;
  const text =
    `A new email signup landed on the Yander holding page.\n\n` +
    `Email:     ${email}\n` +
    `When:      ${when}\n` +
    `Country:   ${ipCountry}\n` +
    `Source:    ${source || refererHost || "(direct)"}\n` +
    `User-Agent: ${userAgent}\n`;

  // Resend transactional email API.
  // Docs: https://resend.com/docs/api-reference/emails/send-email
  // Requires RESEND_API_KEY secret (set via `wrangler secret put` or dashboard).
  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set. Signup captured but not delivered:", email);
    return new Response(
      JSON.stringify({ ok: true, queued: true }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `${NOTIFY_FROM_NAME} <${NOTIFY_FROM}>`,
      to: [NOTIFY_TO],
      reply_to: email,
      subject: subject,
      text: text,
      html: html,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error("Resend send failed", resp.status, detail);
    // Still tell the user they're on the list — we have the signup in logs.
    return new Response(
      JSON.stringify({ ok: true, queued: true }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Canonical host: www.yander.app -> yander.app (preserve path + query).
    if (url.hostname === "www.yander.app") {
      url.hostname = "yander.app";
      return Response.redirect(url.toString(), 301);
    }

    // 2. Signup endpoint.
    if (url.pathname === "/subscribe") {
      return handleSubscribe(request, env);
    }

    // 3. Everything else: serve from the static assets binding.
    return env.ASSETS.fetch(request);
  },
};
