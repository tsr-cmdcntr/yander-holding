// Yander holding-page Worker.
//
// Responsibilities:
//   1. Serve the static site (via `assets` binding in wrangler.jsonc).
//   2. Redirect www.yander.app -> yander.app (canonical host).
//   3. Handle POST /subscribe — capture an email signup:
//        - Append to Cloudflare KV (durable backup)
//        - Notify hello@yander.app via Resend
//   4. Serve a branded 404 page for unknown paths.
//   5. On a weekly scheduled trigger, email Sean a digest of new signups.

const NOTIFY_TO = "hello@yander.app"; // forwarded by CF Email Routing -> getyander@gmail.com
const NOTIFY_FROM_NAME = "Yander Signups";
const NOTIFY_FROM = "noreply@yander.app";
const DIGEST_TO = "hello@yander.app";
const ALLOWED_ORIGINS = new Set([
  "https://yander.app",
  "https://www.yander.app",
]);

// ---------- helpers ----------

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
  // Pragmatic check — RFC-perfect regexes are silly. Server-side is a sanity gate.
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

function json(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// KV key format: signup:<ISO-timestamp>:<sha1-of-email-first-8>
// (timestamp prefix means listings come back in chronological order)
async function storeSignup(env, record) {
  if (!env.SIGNUPS) return; // KV not bound yet — fail soft
  const hash = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(record.email.toLowerCase())
  );
  const hex = Array.from(new Uint8Array(hash))
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const key = `signup:${record.when}:${hex}`;
  await env.SIGNUPS.put(key, JSON.stringify(record), {
    // 5 years — far longer than we need but cheap & safe.
    expirationTtl: 60 * 60 * 24 * 365 * 5,
  });
}

async function listSignupsSince(env, sinceIso) {
  if (!env.SIGNUPS) return [];
  // KV `list` returns keys in lexicographic order; our timestamp prefix gives
  // chronological ordering. We page through everything since the cutoff.
  const results = [];
  let cursor = undefined;
  while (true) {
    const page = await env.SIGNUPS.list({
      prefix: "signup:",
      cursor,
      limit: 1000,
    });
    for (const { name } of page.keys) {
      // name is "signup:<iso>:<hex>"; cheap prefix comparison works thanks to ISO ordering.
      const ts = name.slice("signup:".length, "signup:".length + 24);
      if (ts >= sinceIso) {
        const raw = await env.SIGNUPS.get(name);
        if (raw) {
          try { results.push(JSON.parse(raw)); } catch { /* ignore */ }
        }
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return results;
}

async function sendEmailViaResend(env, { subject, html, text, replyTo }) {
  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set");
    return { ok: false, queued: true };
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
      reply_to: replyTo || undefined,
      subject,
      text,
      html,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error("Resend send failed", resp.status, detail);
    return { ok: false };
  }
  return { ok: true };
}

// ---------- /subscribe ----------

async function handleSubscribe(request, env) {
  const origin = request.headers.get("Origin") || "";
  const cors = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  // Accept JSON or form-encoded.
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
  } catch {
    return json({ ok: false, error: "Could not read request body." }, 400, cors);
  }

  if (!isEmail(email)) {
    return json({ ok: false, error: "Please enter a valid email address." }, 400, cors);
  }

  const when = new Date().toISOString();
  const ipCountry = request.headers.get("CF-IPCountry") || "??";
  const userAgent = request.headers.get("User-Agent") || "";
  const refererHost = (() => {
    try { return new URL(request.headers.get("Referer") || "").host; }
    catch { return ""; }
  })();

  const record = {
    email,
    when,
    country: ipCountry,
    source: source || refererHost || "(direct)",
    user_agent: userAgent,
  };

  // 1. Durable store (don't let an email-send failure lose the signup).
  try {
    await storeSignup(env, record);
  } catch (err) {
    console.error("KV store failed", err);
  }

  // 2. Notify via Resend.
  const subject = `New Yander signup — ${email}`;
  const html =
    `<p>A new email signup landed on the Yander holding page.</p>` +
    `<table cellpadding="6" cellspacing="0" border="0" style="font-family:system-ui,sans-serif;font-size:14px">` +
    `<tr><td><strong>Email</strong></td><td>${escapeHtml(email)}</td></tr>` +
    `<tr><td><strong>When</strong></td><td>${escapeHtml(when)}</td></tr>` +
    `<tr><td><strong>Country</strong></td><td>${escapeHtml(ipCountry)}</td></tr>` +
    `<tr><td><strong>Source</strong></td><td>${escapeHtml(record.source)}</td></tr>` +
    `<tr><td><strong>User-Agent</strong></td><td>${escapeHtml(userAgent)}</td></tr>` +
    `</table>`;
  const text =
    `A new email signup landed on the Yander holding page.\n\n` +
    `Email:     ${email}\n` +
    `When:      ${when}\n` +
    `Country:   ${ipCountry}\n` +
    `Source:    ${record.source}\n` +
    `User-Agent: ${userAgent}\n`;

  const mailResult = await sendEmailViaResend(env, { subject, html, text, replyTo: email });

  // Tell the user they're on the list either way — KV has the record.
  return json({ ok: true, queued: !mailResult.ok }, 200, cors);
}

// ---------- weekly digest (scheduled handler) ----------

async function sendWeeklyDigest(env) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const signups = await listSignupsSince(env, weekAgo);
  const total = signups.length;

  const rangeLabel =
    `${weekAgo.slice(0, 10)} → ${now.toISOString().slice(0, 10)}`;
  const subject =
    total > 0
      ? `Yander weekly digest — ${total} new signup${total === 1 ? "" : "s"}`
      : `Yander weekly digest — quiet week`;

  const rowsHtml = signups
    .map(
      (r) =>
        `<tr>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(r.when.slice(0, 16).replace("T", " "))}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(r.email)}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(r.country || "")}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(r.source || "")}</td>` +
        `</tr>`
    )
    .join("");

  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#2b231d">` +
    `<h2 style="margin:0 0 6px;font-family:'Fraunces',Georgia,serif;font-weight:500">Yander weekly digest</h2>` +
    `<p style="color:#6a5d50;margin:0 0 18px">${escapeHtml(rangeLabel)}</p>` +
    `<p style="margin:0 0 14px"><strong>${total}</strong> new signup${total === 1 ? "" : "s"} this week.</p>` +
    (total > 0
      ? `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;font-size:13px">` +
        `<thead><tr style="background:#f7f3ec">` +
        `<th align="left" style="padding:6px 10px">When (UTC)</th>` +
        `<th align="left" style="padding:6px 10px">Email</th>` +
        `<th align="left" style="padding:6px 10px">Country</th>` +
        `<th align="left" style="padding:6px 10px">Source</th>` +
        `</tr></thead><tbody>${rowsHtml}</tbody></table>`
      : `<p style="color:#6a5d50">Nothing came in this week. The route less taken, indeed.</p>`) +
    `<p style="margin-top:24px;color:#6a5d50;font-style:italic;font-family:'Fraunces',Georgia,serif">Find time to yander.</p>` +
    `</div>`;

  const textRows = signups
    .map((r) => `  ${r.when.slice(0, 16).replace("T", " ")}  ${r.email}  (${r.country || "??"})  ${r.source || ""}`)
    .join("\n");
  const text =
    `Yander weekly digest\n${rangeLabel}\n\n` +
    `${total} new signup${total === 1 ? "" : "s"} this week.\n\n` +
    (total > 0 ? textRows + "\n" : "Nothing came in this week.\n") +
    `\nFind time to yander.\n`;

  if (!env.RESEND_API_KEY) {
    console.error("Digest skipped — RESEND_API_KEY missing");
    return;
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `Yander Digest <${NOTIFY_FROM}>`,
      to: [DIGEST_TO],
      subject,
      text,
      html,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error("Digest send failed", resp.status, detail);
  }
}

// ---------- routing ----------

const KNOWN_PATHS = new Set([
  "/",
  "/index.html",
  "/styles.css",
  "/sitemap.xml",
  "/robots.txt",
  "/404.html",
]);

function looksLikeAsset(pathname) {
  // Anything under /assets/ or with a file extension we want to pass through
  // to the static asset binding (so missing assets get a true 404, not the
  // pretty HTML page — keeps broken <img> hotlinking honest).
  return (
    pathname.startsWith("/assets/") ||
    /\.[a-zA-Z0-9]{2,6}$/.test(pathname.split("/").pop() || "")
  );
}

async function serve404Page(env, request) {
  // Fetch the static 404.html via the assets binding, then return it with status 404.
  const notFoundUrl = new URL(request.url);
  notFoundUrl.pathname = "/404.html";
  const resp = await env.ASSETS.fetch(new Request(notFoundUrl.toString(), { method: "GET" }));
  // Rewrap with 404 status.
  return new Response(resp.body, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Canonical host: www -> apex.
    if (url.hostname === "www.yander.app") {
      url.hostname = "yander.app";
      return Response.redirect(url.toString(), 301);
    }

    // 2. Signup endpoint.
    if (url.pathname === "/subscribe") {
      return handleSubscribe(request, env);
    }

    // 3. Known good paths -> assets binding.
    if (KNOWN_PATHS.has(url.pathname) || looksLikeAsset(url.pathname)) {
      const resp = await env.ASSETS.fetch(request);
      // The assets binding sometimes mis-detects content-type for .xml.
      // Force it for the sitemap so crawlers parse it correctly.
      if (url.pathname === "/sitemap.xml" && resp.status === 200) {
        const body = await resp.text();
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      }
      return resp;
    }

    // 4. Anything else: branded 404.
    return serve404Page(env, request);
  },

  // Scheduled handler: weekly signup digest.
  // Cron is defined in wrangler.jsonc.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendWeeklyDigest(env));
  },
};
