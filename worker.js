/**
 * Read-emails — Cloudflare Worker
 * Binding required: KV namespace named TRACKING_KV
 * Secret required: DASHBOARD_TOKEN (random long value)
 *
 * Routes:
 *   GET /pixel?id=<random-id>             records an open and returns a 1x1 GIF
 *   GET /events (Authorization: Bearer <secret>) lists recorded events
 *   GET /health                           basic configuration check
 */
// Cache the assembled event list in the warm Worker isolate to avoid a KV list on every sidebar poll.
// Data may be up to 5 minutes behind; this dramatically reduces daily KV list operations.
const EVENTS_CACHE_TTL_MS = 5 * 60 * 1000;
let eventsCache = { expiresAt: 0, value: null };
let eventsLoadPromise = null;

const PIXEL = Uint8Array.from([
  71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,33,249,4,1,0,0,0,0,
  44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59
]);

function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    ...headers
  }});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return response("Method not allowed", 405);
    if (url.pathname === "/health") {
      return response(JSON.stringify({ ok: true, kv: Boolean(env.TRACKING_KV), tokenConfigured: Boolean(env.DASHBOARD_TOKEN) }), 200, { "Content-Type": "application/json; charset=utf-8" });
    }
    if (url.pathname === "/pixel") {
      const id = url.searchParams.get("id") || "";
      if (!/^[a-f0-9-]{20,80}$/i.test(id)) return new Response(PIXEL, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store" } });
      if (env.TRACKING_KV) {
        const key = `open:${id}:${Date.now()}:${crypto.randomUUID()}`;
        const event = { id, openedAt: new Date().toISOString(), userAgent: (request.headers.get("user-agent") || "").slice(0, 100) };
        // Keep a small copy in metadata, which is returned by list() and avoids one KV read per event.
        await env.TRACKING_KV.put(key, JSON.stringify(event), {
          expirationTtl: 60 * 60 * 24 * 365,
          metadata: { event }
        });
      }
      return new Response(PIXEL, { headers: { "Content-Type": "image/gif", "Content-Length": String(PIXEL.length), "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache" } });
    }
    if (url.pathname === "/events") {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!env.DASHBOARD_TOKEN || token !== env.DASHBOARD_TOKEN) return response("Unauthorized", 401);
      if (!env.TRACKING_KV) return response(JSON.stringify({ error: "Missing TRACKING_KV binding" }), 500, { "Content-Type": "application/json; charset=utf-8" });
      let payload = eventsCache.value;
      if (!payload || Date.now() >= eventsCache.expiresAt) {
        if (!eventsLoadPromise) {
          eventsLoadPromise = (async () => {
            const events = [];
            let cursor;
            do {
              const page = await env.TRACKING_KV.list({ prefix: "open:", limit: 1000, cursor });
              for (const item of page.keys) {
                // New keys carry event data in metadata. Legacy keys fall back to their value.
                if (item.metadata && item.metadata.event && item.metadata.event.id && item.metadata.event.openedAt) {
                  events.push(item.metadata.event);
                  continue;
                }
                const raw = await env.TRACKING_KV.get(item.name);
                if (raw) { try { events.push(JSON.parse(raw)); } catch {} }
              }
              cursor = page.list_complete ? undefined : page.cursor;
            } while (cursor && events.length < 5000);
            events.sort((a, b) => (b.openedAt || "").localeCompare(a.openedAt || ""));
            return { events, note: "Open events may include image-proxy or security-scanner requests." };
          })();
        }
        try {
          payload = await eventsLoadPromise;
          eventsCache = { value: payload, expiresAt: Date.now() + EVENTS_CACHE_TTL_MS };
        } finally {
          eventsLoadPromise = null;
        }
      }
      return response(JSON.stringify(payload), 200, { "Content-Type": "application/json; charset=utf-8" });
    }
    return response("Read-emails worker is running. Use /health, /pixel, or /events.", 200, { "Content-Type": "text/plain; charset=utf-8" });
  }
};