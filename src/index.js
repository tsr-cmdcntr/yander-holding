// Yander holding-page Worker.
//
// Responsibilities:
//   1. Serve the static site (via `assets` binding in wrangler.jsonc).
//   2. Redirect www.yander.app -> yander.app (canonical host).
//   3. Handle POST /subscribe — capture an email signup:
//        - Append to Cloudflare KV (durable backup)
//        - Notify hello@yander.app via Resend (internal alert)
//        - Send a branded postcard to the new subscriber via Resend
//   4. Handle GET /unsubscribe?e=…&t=… — one-click unsubscribe (RFC 8058).
//   5. Serve a branded 404 page for unknown paths.
//   6. On a weekly scheduled trigger, email Sean a digest of new signups.

const NOTIFY_TO = "hello@yander.app"; // forwarded by CF Email Routing -> getyander@gmail.com
const NOTIFY_FROM_NAME = "Yander Signups";
const NOTIFY_FROM = "noreply@yander.app";
const POSTCARD_FROM_NAME = "Yander";
const POSTCARD_FROM = "hello@yander.app";
const POSTCARD_REPLY_TO = "hello@yander.app";
const DIGEST_TO = "hello@yander.app";
const SITE_URL = "https://yander.app";
const COMPANY_LINE =
  "Yander is a service of Propingtons Ltd, registered in England and Wales (company number 11341542, VAT GB 431 9102 27). Registered office: Unit 5 Riverside Business Centre, Brighton Road, Shoreham-By-Sea, West Sussex, BN43 6RE.";
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

// ---------- unsubscribe token (HMAC) ----------

function unsubscribeSecret(env) {
  // Prefer a dedicated secret; fall back to RESEND_API_KEY so links work
  // immediately on first deploy. Rotate by setting UNSUBSCRIBE_SECRET later.
  return env.UNSUBSCRIBE_SECRET || env.RESEND_API_KEY || "yander-dev";
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function makeUnsubscribeLink(env, email) {
  const e = email.toLowerCase();
  const token = (await hmacSha256Hex(unsubscribeSecret(env), e)).slice(0, 32);
  return `${SITE_URL}/unsubscribe?e=${encodeURIComponent(e)}&t=${token}`;
}

async function verifyUnsubscribe(env, email, token) {
  if (!email || !token) return false;
  const e = email.toLowerCase();
  const expected = (await hmacSha256Hex(unsubscribeSecret(env), e)).slice(0, 32);
  // Constant-time-ish compare.
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

async function markUnsubscribed(env, email) {
  if (!env.SIGNUPS) return;
  const e = email.toLowerCase();
  // Index by hash to avoid storing raw email in the key.
  const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(e));
  const hex = Array.from(new Uint8Array(hash))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await env.SIGNUPS.put(
    `unsub:${hex}`,
    JSON.stringify({ email: e, when: new Date().toISOString() }),
    { expirationTtl: 60 * 60 * 24 * 365 * 5 }
  );
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

// ---------- subscriber postcard ----------

function renderPostcardHtml(unsubUrl) {
  // Inline-styled, table-based HTML — built for the lowest-common-denominator
  // email client (Outlook, Gmail dark mode, iOS Mail). Fonts use a system
  // serif/sans stack with Google Fonts as progressive enhancement.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>A postcard from Yander</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;1,9..144,400&family=Inter:wght@400;500;600&display=swap');
  body { margin:0; padding:0; background:#062418; }
  a { color:#e8954f; }
  @media (prefers-color-scheme: dark) {
    body, .bg { background:#062418 !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#062418;">
  <span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">You're on the list. A postcard from the road less taken — and a quiet promise of what's coming next.</span>
  <table class="bg" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#062418;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#0a3d24;border-radius:18px;overflow:hidden;">
        <!-- Header -->
        <tr><td style="padding:36px 40px 8px 40px;" align="left">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="vertical-align:middle;padding-right:12px;">
              <img src="${SITE_URL}/assets/yander-y.png" alt="" width="28" height="28" style="display:block;border:0;">
            </td>
            <td style="vertical-align:middle;font-family:'Fraunces',Georgia,serif;font-size:22px;font-weight:500;color:#f7f3ec;letter-spacing:0.2px;">Yander</td>
          </tr></table>
        </td></tr>
        <!-- Eyebrow -->
        <tr><td style="padding:28px 40px 0 40px;" align="left">
          <p style="margin:0;font-family:'Inter',-apple-system,Segoe UI,sans-serif;font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#e8954f;">A postcard from the road less taken</p>
        </td></tr>
        <!-- Headline -->
        <tr><td style="padding:14px 40px 0 40px;" align="left">
          <h1 style="margin:0;font-family:'Fraunces',Georgia,serif;font-weight:500;font-size:34px;line-height:1.15;color:#f7f3ec;">You're on the list.</h1>
          <p style="margin:8px 0 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:22px;line-height:1.25;color:#fbe6c2;">Welcome to the slow way home.</p>
        </td></tr>
        <!-- Hairline -->
        <tr><td style="padding:28px 40px 0 40px;">
          <div style="height:1px;background:rgba(247,243,236,0.14);line-height:1px;font-size:1px;">&nbsp;</div>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:24px 40px 0 40px;" align="left">
          <p style="margin:0 0 16px;font-family:'Inter',-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.65;color:#f7f3ec;">Thank you for finding us early. Yander is a route planner for drivers, cyclists and walkers who'd rather the journey were at least as good as the destination — built in Britain, hosted in London, and grounded in proper Ordnance Survey detail.</p>
          <p style="margin:0 0 16px;font-family:'Inter',-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.65;color:#f7f3ec;">We're not far away. In the coming months we'll send a small handful of postcards — never more than you'd like — sharing what we're building, the routes we're falling in love with, and a quiet heads-up the day you can drive your first Yander route.</p>
          <p style="margin:0 0 8px;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:18px;line-height:1.5;color:#fbe6c2;">Until then, take the next exit. The good stuff is rarely on the motorway.</p>
        </td></tr>
        <!-- Sign-off -->
        <tr><td style="padding:28px 40px 0 40px;" align="left">
          <p style="margin:0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:16px;color:#f7f3ec;">Find time to Yander.</p>
          <p style="margin:2px 0 0;font-family:'Inter',-apple-system,Segoe UI,sans-serif;font-size:13px;color:rgba(247,243,236,0.6);">— The Yander team</p>
        </td></tr>
        <!-- Footer rule -->
        <tr><td style="padding:32px 40px 0 40px;">
          <div style="height:1px;background:rgba(247,243,236,0.10);line-height:1px;font-size:1px;">&nbsp;</div>
        </td></tr>
        <!-- Legal / unsubscribe -->
        <tr><td style="padding:18px 40px 36px 40px;" align="left">
          <p style="margin:0 0 8px;font-family:'Inter',-apple-system,Segoe UI,sans-serif;font-size:12px;line-height:1.6;color:rgba(247,243,236,0.55);">You're receiving this because you joined the Yander waitlist at <a href="${SITE_URL}" style="color:#e8954f;text-decoration:none;">yander.app</a>. We'll only email you about Yander.</p>
          <p style="margin:0 0 12px;font-family:'Inter',-apple-system,Segoe UI,sans-serif;font-size:12px;line-height:1.6;color:rgba(247,243,236,0.55);"><a href="${unsubUrl}" style="color:#e8954f;">Unsubscribe in one click</a> &nbsp;·&nbsp; <a href="${SITE_URL}/privacy" style="color:#e8954f;">Privacy</a> &nbsp;·&nbsp; <a href="${SITE_URL}/terms" style="color:#e8954f;">Terms</a></p>
          <p style="margin:0;font-family:'Inter',-apple-system,Segoe UI,sans-serif;font-size:11px;line-height:1.6;color:rgba(247,243,236,0.4);">${COMPANY_LINE}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function renderPostcardText(unsubUrl) {
  return [
    "A postcard from the road less taken",
    "",
    "You're on the list. Welcome to the slow way home.",
    "",
    "Thank you for finding us early. Yander is a route planner for drivers, cyclists and walkers who'd rather the journey were at least as good as the destination — built in Britain, hosted in London, and grounded in proper Ordnance Survey detail.",
    "",
    "We're not far away. In the coming months we'll send a small handful of postcards — never more than you'd like — sharing what we're building, the routes we're falling in love with, and a quiet heads-up the day you can drive your first Yander route.",
    "",
    "Until then, take the next exit. The good stuff is rarely on the motorway.",
    "",
    "Find time to Yander.",
    "— The Yander team",
    "",
    "---",
    `You're receiving this because you joined the Yander waitlist at ${SITE_URL}. We'll only email you about Yander.`,
    `Unsubscribe in one click: ${unsubUrl}`,
    `Privacy: ${SITE_URL}/privacy   Terms: ${SITE_URL}/terms`,
    "",
    COMPANY_LINE,
  ].join("\n");
}

async function sendPostcardToSubscriber(env, email) {
  if (!env.RESEND_API_KEY) {
    console.error("Postcard skipped — RESEND_API_KEY missing");
    return { ok: false };
  }
  const unsubUrl = await makeUnsubscribeLink(env, email);
  const subject = "You're on the list — a postcard from Yander";
  const html = renderPostcardHtml(unsubUrl);
  const text = renderPostcardText(unsubUrl);

  // RFC 8058 / RFC 2369 one-click headers — improves Gmail/Yahoo deliverability
  // and gives the recipient a native "Unsubscribe" link in the client UI.
  const headers = {
    "List-Unsubscribe": `<${unsubUrl}>, <mailto:hello@yander.app?subject=unsubscribe>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `${POSTCARD_FROM_NAME} <${POSTCARD_FROM}>`,
      to: [email],
      reply_to: POSTCARD_REPLY_TO,
      subject,
      text,
      html,
      headers,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error("Postcard send failed", resp.status, detail);
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

  // 3. Send the subscriber their welcome postcard.
  //    Wrapped in try so a postcard failure never breaks the signup flow.
  try {
    await sendPostcardToSubscriber(env, email);
  } catch (err) {
    console.error("Postcard send threw", err);
  }

  // Tell the user they're on the list either way — KV has the record.
  return json({ ok: true, queued: !mailResult.ok }, 200, cors);
}

// ---------- /unsubscribe ----------

function unsubscribePage(message, isError) {
  const tone = isError ? "#e8954f" : "#fbe6c2";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — Yander</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,500;1,400&family=Inter:wght@400;500&display=swap');
  html,body{margin:0;padding:0;background:#062418;color:#f7f3ec;font-family:'Inter',-apple-system,Segoe UI,sans-serif;min-height:100vh;}
  main{max-width:560px;margin:0 auto;padding:80px 24px 40px;text-align:center;}
  h1{font-family:'Fraunces',Georgia,serif;font-weight:500;font-size:42px;line-height:1.1;margin:24px 0 12px;}
  p{font-size:16px;line-height:1.6;color:rgba(247,243,236,0.78);margin:0 0 14px;}
  .eyebrow{font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:${tone};margin:0;}
  a{color:#e8954f;}
  .y{width:36px;height:36px;display:inline-block;}
</style></head><body><main>
  <img class="y" src="/assets/yander-y.png" alt="" />
  <p class="eyebrow">Yander</p>
  <h1>${escapeHtml(message.title)}</h1>
  <p>${message.body}</p>
  <p style="margin-top:32px;"><a href="/">Back to yander.app</a></p>
</main></body></html>`;
}

async function handleUnsubscribe(request, env) {
  const url = new URL(request.url);
  const email = (url.searchParams.get("e") || "").trim().toLowerCase();
  const token = (url.searchParams.get("t") || "").trim();

  if (!isEmail(email) || !token) {
    return new Response(
      unsubscribePage(
        {
          title: "That link looks broken.",
          body: "The unsubscribe link couldn't be verified. Email <a href=\"mailto:hello@yander.app\">hello@yander.app</a> and we'll take you off the list by hand.",
        },
        true
      ),
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const valid = await verifyUnsubscribe(env, email, token);
  if (!valid) {
    return new Response(
      unsubscribePage(
        {
          title: "We couldn't verify that link.",
          body: "The unsubscribe token didn't match. Email <a href=\"mailto:hello@yander.app\">hello@yander.app</a> and we'll take you off the list by hand.",
        },
        true
      ),
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  // POST = RFC 8058 one-click. Treat GET the same so a plain click works.
  try {
    await markUnsubscribed(env, email);
  } catch (err) {
    console.error("markUnsubscribed failed", err);
  }

  return new Response(
    unsubscribePage(
      {
        title: "You're off the list.",
        body: "We won't email you again. Change your mind? <a href=\"/\">Rejoin in a moment</a> — no hard feelings.",
      },
      false
    ),
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
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
  "/legal.css",
  "/sitemap.xml",
  "/robots.txt",
  "/404.html",
  "/privacy",
  "/privacy.html",
  "/terms",
  "/terms.html",
  "/support",
  "/support.html",
  "/attribution",
  "/attribution.html",
]);

// Pretty URLs without .html — map them to the underlying asset path.
const PRETTY_URL_MAP = {
  "/privacy": "/privacy.html",
  "/terms": "/terms.html",
  "/support": "/support.html",
  "/attribution": "/attribution.html",
};

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

    // 2b. Unsubscribe endpoint (one-click; accepts GET and POST).
    if (url.pathname === "/unsubscribe") {
      return handleUnsubscribe(request, env);
    }

    // 2c. Diagnostic endpoint — booleans only, no secret material leaked.
    // Reports whether each binding is visible to the worker at runtime.
    // Remove after debug.
    if (url.pathname === "/__diag") {
      return json(
        {
          resend_key_present: typeof env.RESEND_API_KEY === "string" && env.RESEND_API_KEY.length > 0,
          unsubscribe_secret_present: typeof env.UNSUBSCRIBE_SECRET === "string" && env.UNSUBSCRIBE_SECRET.length > 0,
          signups_kv_present: typeof env.SIGNUPS === "object" && env.SIGNUPS !== null,
          assets_present: typeof env.ASSETS === "object" && env.ASSETS !== null,
        },
        200
      );
    }

    // 3. Pretty URL rewrites for legal pages.
    if (PRETTY_URL_MAP[url.pathname]) {
      const rewritten = new URL(request.url);
      rewritten.pathname = PRETTY_URL_MAP[url.pathname];
      const resp = await env.ASSETS.fetch(new Request(rewritten.toString(), { method: "GET", headers: request.headers }));
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // 4. Known good paths -> assets binding.
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

    // 5. Anything else: branded 404.
    return serve404Page(env, request);
  },

  // Scheduled handler: weekly signup digest.
  // Cron is defined in wrangler.jsonc.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendWeeklyDigest(env));
  },
};
