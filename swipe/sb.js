// Minimal Supabase REST client: read state, password sign-in, save state, upload media.
// Plain fetch so public visitors load no SDK; the same calls work against dev/mock.mjs.

export function createClient({ url, key, bucket = "swipe", store = globalThis.localStorage }) {
  const BASE = (url || "").replace(/\/$/, "");
  const SESSION = "axren-session";
  const configured = !!(BASE && key);
  // Legacy anon keys are JWTs and go in Authorization too; new sb_publishable_ keys must not.
  const isJwt = key && key.startsWith("eyJ");

  const headers = (token, extra = {}) => {
    const h = { apikey: key, ...extra };
    const bearer = token || (isJwt ? key : null);
    if (bearer) h.Authorization = `Bearer ${bearer}`;
    return h;
  };
  const fail = (message, status) => Object.assign(new Error(message), { status });
  const json = async r => {
    const t = await r.text();
    let j = null;
    try { j = t ? JSON.parse(t) : null; } catch {}
    if (!r.ok) throw fail(j?.msg || j?.message || j?.error_description || j?.error || `HTTP ${r.status}`, r.status);
    return j;
  };

  let session = null;
  try { session = JSON.parse(store?.getItem(SESSION) || "null"); } catch {}
  const keep = s => {
    session = s;
    try { s ? store?.setItem(SESSION, JSON.stringify(s)) : store?.removeItem(SESSION); } catch {}
  };

  async function grant(type, body) {
    const r = await fetch(`${BASE}/auth/v1/token?grant_type=${type}`, {
      method: "POST", headers: headers(null, { "content-type": "application/json" }), body: JSON.stringify(body),
    });
    const j = await json(r);
    keep({
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
      email: j.user?.email || "",
    });
  }

  async function access() {
    if (!session) throw fail("Signed out", 401);
    if (session.expires_at - 60 < Date.now() / 1000) {
      try { await grant("refresh_token", { refresh_token: session.refresh_token }); }
      catch { keep(null); throw fail("Signed out", 401); }
    }
    return session.access_token;
  }

  const publicUrl = path => `${BASE}/storage/v1/object/public/${bucket}/${path}`;

  return {
    configured,
    publicUrl,
    hasSession: () => !!session,
    email: () => session?.email || "",

    async readState() {
      const r = await fetch(`${BASE}/rest/v1/swipe_state?id=eq.1&select=data`, { headers: headers(null), cache: "no-store" });
      const rows = await json(r);
      return rows?.[0]?.data || { items: [] };
    },

    signIn: (email, password) => grant("password", { email, password }),

    async signOut() {
      const t = session?.access_token;
      keep(null);
      if (t) await fetch(`${BASE}/auth/v1/logout`, { method: "POST", headers: headers(t) }).catch(() => {});
    },

    // RLS answers a blocked UPDATE with 200 and zero rows, so a save only counts when the row comes back.
    async saveState(data) {
      const r = await fetch(`${BASE}/rest/v1/swipe_state?id=eq.1&select=id`, {
        method: "PATCH",
        headers: headers(await access(), { "content-type": "application/json", prefer: "return=representation" }),
        body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
      });
      const rows = await json(r);
      if (!Array.isArray(rows) || rows.length !== 1) throw fail("This account can't publish here", 403);
    },

    async upload(path, blob) {
      const r = await fetch(`${BASE}/storage/v1/object/${bucket}/${path}`, {
        method: "POST",
        headers: headers(await access(), { "content-type": blob.type || "application/octet-stream", "cache-control": "max-age=31536000", "x-upsert": "false" }),
        body: blob,
      });
      await json(r);
      return publicUrl(path);
    },
  };
}
