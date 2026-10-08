import { SUPABASE_URL, SUPABASE_KEY, BUCKET } from "./config.js";
import { createClient } from "./sb.js";

const client = createClient({ url: SUPABASE_URL, key: SUPABASE_KEY, bucket: BUCKET });
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const copy = o => JSON.parse(JSON.stringify(o));
const uid = () => Math.random().toString(36).slice(2, 10);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const RISE_MS = 900;

let SAVED = { items: [] }, STATE = copy(SAVED);
let EDITING = false, dirty = false, FILTER = null, VISIBLE = [];
const NODES = new Map();
const grid = $("#grid"), viewer = $("#viewer"), stage = $("#vStage");

/* ---------------- data helpers ---------------- */
const ratioOf = it => it.ratio > 0 ? it.ratio : 1;
const tagsOf = it => (it.tags || []).filter(Boolean);
const allTags = () => [...new Set(STATE.items.flatMap(tagsOf))];
const dateOf = it => {
  if (!it.added) return "";
  const d = new Date(it.added), p = n => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
};

/* ---------------- tiles ---------------- */
function mediaHTML(it, big) {
  const m = it.media || {};
  if (m.kind === "video") {
    // Grid videos fetch nothing until they scroll into view; the poster stands in.
    return `<video class="in" src="${esc(m.src)}"${m.poster ? ` poster="${esc(m.poster)}"` : ""} muted loop playsinline preload="${big ? "auto" : "none"}"${big && !reduced.matches ? " autoplay" : ""}></video>`;
  }
  return `<img src="${esc(m.src)}" alt="${esc(it.title || "")}"${big ? "" : ' loading="lazy"'} decoding="async" draggable="false">`;
}
function tileHTML(it) {
  return `<button class="media" type="button" aria-label="Open ${esc(it.title || "piece")}">${mediaHTML(it)}</button>
    <div class="tools"><button class="pill" type="button" data-t="wide">${it.wide ? "1 col" : "2 col"}</button><button class="pill" type="button" data-t="del">Delete</button></div>
    <figcaption class="cap"><span class="num">${dateOf(it)}</span><b class="chip-t">${esc(it.title || "Untitled")}</b><span class="read">${esc(it.sub || "")}</span></figcaption>`;
}
const reveal = img => { const show = () => img.classList.add("in"); img.decode ? img.decode().then(show, show) : show(); };
grid.addEventListener("load", e => { if (e.target.tagName === "IMG") reveal(e.target); }, true);
grid.addEventListener("error", e => { if (e.target.tagName === "IMG") e.target.classList.add("in"); }, true);

function fill(f, it) {
  f.innerHTML = tileHTML(it);
  f.querySelectorAll("img").forEach(i => { if (i.complete && i.naturalWidth) reveal(i); });
  f.querySelectorAll("video").forEach(v => playing.observe(v));
}
const playing = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting && !reduced.matches) e.target.play().catch(() => {}); else e.target.pause();
}), { threshold: 0.2 });

/* ---------------- layout: column streams, wide pieces span two ---------------- */
function metrics() {
  const W = grid.clientWidth, cols = W >= 1100 ? 4 : W >= 760 ? 3 : 2, gap = W >= 760 ? 24 : 12;
  return { W, cols, gap, rowGap: W >= 760 ? 48 : 24, colW: (W - gap * (cols - 1)) / cols };
}
let POS = new Map();
function layout() {
  const m = metrics(), span = it => (it.wide && m.cols > 1 ? 2 : 1), widthOf = s => s * m.colW + (s - 1) * m.gap;
  // write sizes first, then read every caption once, so the browser lays out a single time
  VISIBLE.forEach(it => {
    const f = NODES.get(it.id), w = widthOf(span(it));
    f.style.width = w + "px";
    f.firstElementChild.style.height = w / ratioOf(it) + "px";
  });
  const capH = new Map(VISIBLE.map(it => [it.id, NODES.get(it.id).lastElementChild.offsetHeight]));
  const heightOf = (it, s) => widthOf(s) / ratioOf(it) + capH.get(it.id);

  const h = new Array(m.cols).fill(0), queue = VISIBLE.slice();
  POS = new Map();
  const put = (it, c, s) => {
    const y = Math.max(...h.slice(c, c + s));
    POS.set(it.id, { x: c * (m.colW + m.gap), y });
    for (let k = c; k < c + s; k++) h[k] = y + heightOf(it, s) + m.rowGap;
  };
  const shortest = () => h.indexOf(Math.min(...h));
  const lowestPair = () => {
    let best = 0;
    for (let c = 1; c < m.cols - 1; c++) if (Math.max(h[c], h[c + 1]) < Math.max(h[best], h[best + 1])) best = c;
    return best;
  };
  while (queue.length) {
    const it = queue.shift();
    if (span(it) === 1) { put(it, shortest(), 1); continue; }
    // before a wide piece, top up the lower of its two columns with the next small piece that fits
    for (let tries = 0; tries < 3; tries++) {
      const c = lowestPair(), lo = h[c] <= h[c + 1] ? c : c + 1, gapAbove = Math.abs(h[c] - h[c + 1]);
      const j = queue.findIndex(x => span(x) === 1);
      if (gapAbove < m.colW * 0.25 || j < 0) break;
      if (heightOf(queue[j], 1) + m.rowGap > gapAbove + m.colW * 0.35) break;
      put(queue.splice(j, 1)[0], lo, 1);
    }
    put(it, lowestPair(), 2);
  }
  grid.style.height = Math.max(0, Math.max(...h) - m.rowGap) + "px";
  POS.forEach((p, id) => { if (!drag || drag.id !== id) NODES.get(id).style.transform = `translate3d(${p.x}px,${p.y}px,0)`; });
}

function refresh({ instant = false, enter = false } = {}) {
  VISIBLE = STATE.items.filter(it => !FILTER || tagsOf(it).includes(FILTER));
  NODES.forEach((f, id) => { if (!VISIBLE.some(it => it.id === id)) { f.remove(); NODES.delete(id); } });
  const fresh = [];
  VISIBLE.forEach(it => {
    if (NODES.has(it.id)) return;
    const f = document.createElement("figure");
    f.className = "tile" + (enter ? " enter" : "");
    f.dataset.id = it.id;
    fill(f, it);
    grid.appendChild(f);
    NODES.set(it.id, f);
    fresh.push(f);
  });
  if (instant) grid.classList.add("instant");
  layout();
  requestAnimationFrame(() => requestAnimationFrame(() => { grid.classList.remove("instant"); fresh.forEach(f => f.classList.remove("enter")); }));
  $$(".empty", grid).forEach(e => e.remove());
  if (!VISIBLE.length && EDITING) grid.insertAdjacentHTML("beforeend", `<p class="empty read">Nothing here yet. Drop images or videos anywhere.</p>`);
  $("#count").textContent = STATE.items.length ? `${VISIBLE.length} ${VISIBLE.length === 1 ? "piece" : "pieces"}` : "";
  grid.setAttribute("aria-busy", "false");
}
function rerender(it) { const f = NODES.get(it.id); if (f) fill(f, it); }
let rt;
new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (VISIBLE.length) { grid.classList.add("instant"); layout(); requestAnimationFrame(() => grid.classList.remove("instant")); } }, 60); }).observe(grid);

/* ---------------- intro + filters ---------------- */
function renderIntro() {
  $("#title").textContent = STATE.title || "";
  $("#lede").textContent = STATE.lede || "";
  $("#intro").hidden = !(STATE.title || STATE.lede || EDITING);
}
function renderFilters() {
  const tags = allTags();
  if (FILTER && !tags.includes(FILTER)) FILTER = null;
  const count = t => STATE.items.filter(it => tagsOf(it).includes(t)).length;
  $("#filters").innerHTML = !tags.length ? "" :
    `<button class="pill" type="button" data-tag="" aria-pressed="${!FILTER}">All <span class="num">${STATE.items.length}</span></button>` +
    tags.map(t => `<button class="pill" type="button" data-tag="${esc(t)}" aria-pressed="${FILTER === t}">${esc(t)} <span class="num">${count(t)}</span></button>`).join("");
}
$("#filters").addEventListener("click", e => {
  const b = e.target.closest("[data-tag]"); if (!b) return;
  const t = b.dataset.tag || null;
  FILTER = FILTER === t ? null : t;
  renderFilters(); refresh({ enter: true });
});

/* ---------------- viewer (FLIP from the thumbnail) ---------------- */
let VI = -1, lastFocus = null, closeT;
function fit(r) {
  const narrow = innerWidth < 760, side = EDITING && !narrow ? 348 : 0;
  const padX = narrow ? 16 : 48, top = narrow ? 64 : 72, bottom = narrow ? 168 : 120;
  const maxW = innerWidth - padX * 2 - side, maxH = innerHeight - top - bottom;
  const w = Math.min(maxW, maxH * r), hh = w / r;
  return { x: (innerWidth - side - w) / 2, y: top + (maxH - hh) / 2, w, h: hh };
}
function thumbRect(id) {
  const f = NODES.get(id); if (!f) return null;
  const r = f.firstElementChild.getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight ? r : null;
}
function setStage(it) {
  const to = fit(ratioOf(it));
  stage.innerHTML = mediaHTML(it, true);
  Object.assign(stage.style, { width: to.w + "px", height: to.h + "px" });
  stage._to = to;
  return to;
}
function fillBar(it) {
  $("#vTitle").textContent = it.title || "Untitled";
  $("#vSub").textContent = it.sub || "";
  $("#vCount").textContent = `${VI + 1} / ${VISIBLE.length}`;
  $("#vPrev").disabled = $("#vNext").disabled = VISIBLE.length < 2;
  $("#vEdit").hidden = !EDITING;
  if (EDITING) renderEdit(it);
}
function open(id) {
  VI = VISIBLE.findIndex(x => x.id === id); if (VI < 0) return;
  const it = VISIBLE[VI];
  clearTimeout(closeT);
  lastFocus = document.activeElement;
  viewer.hidden = false; document.body.classList.add("lock");
  const to = setStage(it), from = thumbRect(id);
  stage.classList.remove("anim");
  stage.style.opacity = "";
  if (from && !reduced.matches) {
    stage.style.transform = `translate(${from.left}px,${from.top}px) scale(${from.width / to.w},${from.height / to.h})`;
    stage.getBoundingClientRect();
    stage.classList.add("anim");
  }
  stage.style.transform = `translate(${to.x}px,${to.y}px)`;
  requestAnimationFrame(() => viewer.classList.add("ready"));
  fillBar(it);
  $("#vClose").focus({ preventScroll: true });
}
function close() {
  if (viewer.hidden) return;
  const it = VISIBLE[VI], from = it && thumbRect(it.id), to = stage._to;
  viewer.classList.remove("ready");
  if (from && to && !reduced.matches) {
    stage.classList.add("anim");
    stage.style.transform = `translate(${from.left}px,${from.top}px) scale(${from.width / to.w},${from.height / to.h})`;
  } else stage.style.opacity = "0";
  closeT = setTimeout(() => {
    viewer.hidden = true; stage.innerHTML = ""; VI = -1;
    document.body.classList.remove("lock");
    if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
  }, reduced.matches ? 0 : RISE_MS);
}
function step(d) {
  if (VI < 0 || VISIBLE.length < 2) return;
  VI = (VI + d + VISIBLE.length) % VISIBLE.length;
  const it = VISIBLE[VI];
  stage.classList.remove("anim");
  const to = setStage(it);
  stage.style.transform = `translate(${to.x}px,${to.y}px)`;
  fillBar(it);
  // keep the grid in step so closing lands on the right tile
  const p = POS.get(it.id), top = grid.getBoundingClientRect().top + scrollY;
  if (p) scrollTo({ top: Math.max(0, p.y + top - innerHeight / 3) });
}
$("#vClose").addEventListener("click", close);
$("#vBack").addEventListener("click", close);
$("#vPrev").addEventListener("click", () => step(-1));
$("#vNext").addEventListener("click", () => step(1));
addEventListener("keydown", e => {
  if (viewer.hidden) return;
  if (e.target.closest?.("input") && e.key !== "Escape") return;
  if (e.key === "Escape") { e.preventDefault(); close(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
  else if (e.key === "Tab") {
    const f = $$("button:not([disabled]):not([tabindex='-1']), input", viewer).filter(x => x.offsetParent);
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1)?.focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0]?.focus(); }
  }
});
addEventListener("resize", () => { if (VI >= 0) { stage.classList.remove("anim"); const to = setStage(VISIBLE[VI]); stage.style.transform = `translate(${to.x}px,${to.y}px)`; } });
let touch = null;
stage.addEventListener("pointerdown", e => { if (e.pointerType !== "mouse") touch = { x: e.clientX, y: e.clientY }; });
addEventListener("pointerup", e => {
  if (!touch) return;
  const dx = e.clientX - touch.x, dy = e.clientY - touch.y; touch = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1); else if (dy > 90) close();
});

/* ---------------- grid clicks ---------------- */
let justDragged = false;
grid.addEventListener("click", e => {
  const f = e.target.closest(".tile"); if (!f) return;
  const it = STATE.items.find(x => x.id === f.dataset.id); if (!it) return;
  const tool = e.target.closest("[data-t]");
  if (tool && EDITING) {
    if (tool.dataset.t === "wide") { it.wide = !it.wide; rerender(it); }
    if (tool.dataset.t === "del") STATE.items.splice(STATE.items.indexOf(it), 1);
    changed(); renderFilters(); refresh();
    return;
  }
  if (e.target.closest(".media") && !justDragged) open(it.id);
});

/* ---------------- owner: edit panel ---------------- */
function renderEdit(it) {
  const p = $("#vEdit");
  p.innerHTML = `<label>Title<input type="text" name="title" value="${esc(it.title || "")}"></label>
    <label>Subtext<input type="text" name="sub" value="${esc(it.sub || "")}"></label>
    <label>Tags, comma separated<input type="text" name="tags" value="${esc(tagsOf(it).join(", "))}"></label>
    <div class="row"><button class="pill" type="button" data-e="wide" aria-pressed="${!!it.wide}">2 columns</button></div>
    <div class="row"><button class="pill" type="button" data-e="replace">Replace media</button><button class="pill" type="button" data-e="del">Delete</button></div>`;
  p.oninput = e => {
    const n = e.target.name;
    if (n === "tags") it.tags = [...new Set(e.target.value.split(",").map(s => s.trim()).filter(Boolean))];
    else if (n) it[n] = e.target.value;
    $("#vTitle").textContent = it.title || "Untitled"; $("#vSub").textContent = it.sub || "";
    changed(); rerender(it); refresh();
  };
  p.onchange = () => renderFilters();
  p.onsubmit = e => e.preventDefault();
  p.onclick = async e => {
    const b = e.target.closest("[data-e]"); if (!b) return;
    if (b.dataset.e === "wide") { it.wide = !it.wide; b.setAttribute("aria-pressed", it.wide); changed(); rerender(it); refresh(); }
    if (b.dataset.e === "del") { STATE.items.splice(STATE.items.indexOf(it), 1); changed(); close(); setTimeout(() => { renderFilters(); refresh(); }, RISE_MS); }
    if (b.dataset.e === "replace") pick(async files => {
      const m = files[0] && await ingest(files[0]); if (!m) return;
      Object.assign(it, m); changed(); rerender(it); refresh(); setStage(it); stage.style.transform = `translate(${stage._to.x}px,${stage._to.y}px)`;
    }, false);
  };
}

/* ---------------- owner: adding media ---------------- */
const MAX_VIDEO = 50 * 1048576; // Supabase free plan caps a single file at 50 MB
const VIDEO_EXT = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
const slug = name => name.replace(/\.[^.]+$/, "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "piece";

function pick(cb, multi = true) {
  const i = document.createElement("input");
  i.type = "file"; i.accept = "image/*,video/mp4,video/webm,video/quicktime"; i.multiple = multi;
  i.onchange = () => cb([...i.files]);
  i.click();
}
function firstFrame(src) {
  return new Promise(res => {
    const v = document.createElement("video");
    const done = out => { clearTimeout(t); v.removeAttribute("src"); v.load(); res(out); };
    const t = setTimeout(() => done(null), 15000);
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.onloadeddata = () => {
      const w = Math.min(1200, v.videoWidth); if (!w) return done(null);
      const c = document.createElement("canvas");
      c.width = w; c.height = Math.round(v.videoHeight * w / v.videoWidth);
      try { c.getContext("2d").drawImage(v, 0, 0, c.width, c.height); } catch { return done(null); }
      c.toBlob(b => done(b ? { blob: b, ratio: v.videoWidth / v.videoHeight } : null), "image/webp", 0.8);
    };
    v.onerror = () => done(null);
    v.src = src;
  });
}
async function ingest(f) {
  const base = `media/${Date.now().toString(36)}-${slug(f.name)}`;
  try {
    if (f.type.startsWith("video/")) {
      if (!VIDEO_EXT[f.type]) { toast(`${f.name}: use MP4, WebM or MOV.`); return null; }
      if (f.size > MAX_VIDEO) { toast(`${f.name} is over 50 MB. Export a shorter loop at 1080p, no audio.`, 5000); return null; }
      const local = URL.createObjectURL(f), frame = await firstFrame(local);
      URL.revokeObjectURL(local);
      const media = { kind: "video", src: await client.upload(`${base}.${VIDEO_EXT[f.type]}`, f) };
      if (frame) media.poster = await client.upload(`${base}-poster.webp`, frame.blob);
      return { media, ratio: frame?.ratio || 16 / 9 };
    }
    const bmp = await createImageBitmap(f), ratio = bmp.width / bmp.height;
    if (f.type === "image/gif") return { media: { kind: "image", src: await client.upload(`${base}.gif`, f) }, ratio };
    const c = document.createElement("canvas"), w = Math.min(2400, bmp.width);
    c.width = w; c.height = Math.round(bmp.height * w / bmp.width);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    let blob = await new Promise(r => c.toBlob(r, "image/webp", 0.86)), ext = "webp";
    if (!blob || blob.type !== "image/webp") { blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.88)); ext = "jpg"; }
    return { media: { kind: "image", src: await client.upload(`${base}.${ext}`, blob) }, ratio };
  } catch (err) {
    if (err.status === 401) needSignIn();
    toast(`Couldn't add ${f.name}: ${err.message}`, 5000);
    return null;
  }
}
let POINTER = null;
addEventListener("pointermove", e => { POINTER = { x: e.clientX, y: e.clientY }; }, { passive: true });
function insertAt(pt) {
  const t = pt && document.elementFromPoint(pt.x, pt.y)?.closest(".tile");
  const i = t ? STATE.items.findIndex(x => x.id === t.dataset.id) : -1;
  return i < 0 ? 0 : i; // newest first unless dropped on a piece
}
async function addFiles(files, pt) {
  files = files.filter(f => /^(image|video)\//.test(f.type)); if (!files.length) return;
  say(`Uploading ${files.length}…`);
  let at = insertAt(pt), n = 0;
  for (const f of files) {
    const m = await ingest(f); if (!m) continue;
    STATE.items.splice(at++, 0, { id: uid(), title: f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "), sub: "", tags: FILTER ? [FILTER] : [], wide: false, added: Date.now(), ...m });
    n++;
  }
  if (!n) { say("Nothing added."); return; }
  changed(); renderFilters(); refresh({ enter: true });
  toast(`Added ${n} ${n === 1 ? "piece" : "pieces"}. Save to publish.`);
}
$("#ebAdd").addEventListener("click", () => pick(addFiles));
let depth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", e => { if (EDITING && hasFiles(e)) { depth++; $("#dropVeil").classList.add("on"); } });
addEventListener("dragleave", () => { if (EDITING && --depth <= 0) { depth = 0; $("#dropVeil").classList.remove("on"); } });
addEventListener("dragover", e => { if (EDITING && hasFiles(e)) e.preventDefault(); });
addEventListener("drop", e => {
  if (!EDITING) return;
  e.preventDefault(); depth = 0; $("#dropVeil").classList.remove("on");
  addFiles([...e.dataTransfer.files], { x: e.clientX, y: e.clientY });
});
addEventListener("paste", e => {
  if (!EDITING || e.target.closest?.("input, [contenteditable]")) return;
  const fs = [...(e.clipboardData?.files || [])];
  if (fs.length) { e.preventDefault(); addFiles(fs, POINTER); }
});

/* ---------------- owner: drag to reorder ---------------- */
let drag = null;
grid.addEventListener("pointerdown", e => {
  if (!EDITING || e.button !== 0 || e.target.closest("[data-t]")) return;
  const f = e.target.closest(".tile"); if (!f) return;
  const p = POS.get(f.dataset.id);
  drag = { id: f.dataset.id, f, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, on: false };
});
addEventListener("pointermove", e => {
  if (!drag) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.on) { if (Math.hypot(dx, dy) < 6) return; drag.on = true; drag.f.classList.add("dragging"); drag.f.style.pointerEvents = "none"; }
  drag.f.style.transform = `translate3d(${drag.ox + dx}px,${drag.oy + dy}px,0)`;
  const t = document.elementFromPoint(e.clientX, e.clientY)?.closest(".tile");
  $$(".tile.drop-to").forEach(x => x.classList.remove("drop-to"));
  if (t && t.dataset.id !== drag.id) {
    t.classList.add("drop-to");
    if (drag.last !== t.dataset.id) {
      drag.last = t.dataset.id;
      const items = STATE.items, from = items.findIndex(x => x.id === drag.id), to = items.findIndex(x => x.id === t.dataset.id);
      items.splice(to, 0, items.splice(from, 1)[0]);
      VISIBLE = items.filter(it => !FILTER || tagsOf(it).includes(FILTER));
      layout();
      const np = POS.get(drag.id); drag.ox = np.x - dx; drag.oy = np.y - dy;
    }
  }
  if (e.clientY > innerHeight - 72) scrollBy(0, 16); else if (e.clientY < 120) scrollBy(0, -16);
});
addEventListener("pointerup", () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.on) return;
  justDragged = true; setTimeout(() => { justDragged = false; }, 50);
  d.f.classList.remove("dragging"); d.f.style.pointerEvents = "";
  $$(".tile.drop-to").forEach(x => x.classList.remove("drop-to"));
  changed(); layout();
});

/* ---------------- owner: mode, sign-in, save ---------------- */
let toastT;
function toast(msg, ms = 2200) {
  $$(".toast").forEach(t => t.remove());
  const t = document.createElement("div");
  t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastT); toastT = setTimeout(() => t.remove(), ms);
}
const say = t => { $("#ebState").textContent = t; };
function changed() { dirty = true; say("Unsaved changes"); }

function setEditing(on) {
  EDITING = on;
  document.body.classList.toggle("editing", on);
  $("#editBar").hidden = !on;
  ["#title", "#lede"].forEach(s => { const el = $(s); on ? el.setAttribute("contenteditable", "plaintext-only") : el.removeAttribute("contenteditable"); });
  renderIntro(); refresh({ instant: true });
}
["#title", "#lede"].forEach(s => $(s).addEventListener("input", e => {
  STATE[s === "#title" ? "title" : "lede"] = e.target.textContent.replace(/\s+/g, " ").trim();
  changed();
}));

function needSignIn() {
  if (!client.configured) { toast("Supabase is not connected yet: fill in site/config.js.", 6000); return; }
  $("#loginMsg").textContent = client.email() ? `Signed out (${client.email()}). Sign in again.` : "";
  $("#login").showModal();
}
$("#loginForm").addEventListener("submit", async e => {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  const f = e.target, msg = $("#loginMsg");
  msg.textContent = "Signing in…";
  try {
    await client.signIn(f.email.value.trim(), f.password.value);
    f.password.value = "";
    $("#login").close();
    setEditing(true);
  } catch (err) { msg.textContent = err.message; }
});

$("#ebSave").addEventListener("click", async () => {
  const btn = $("#ebSave");
  btn.disabled = true; say("Saving…");
  try {
    const out = { title: STATE.title || "", lede: STATE.lede || "", items: STATE.items };
    await client.saveState(out);
    SAVED = copy(out); dirty = false; say("Saved. It's live.");
  } catch (err) {
    say(`Save failed: ${err.message}`);
    if (err.status === 401) needSignIn();
  } finally { btn.disabled = false; }
});
$("#ebDiscard").addEventListener("click", () => {
  STATE = copy(SAVED); dirty = false;
  NODES.forEach(f => f.remove()); NODES.clear();
  renderIntro(); renderFilters(); refresh({ instant: true }); say("Changes discarded");
});
$("#ebOut").addEventListener("click", async () => {
  if (dirty && !confirm("Sign out and lose unsaved changes?")) return;
  await client.signOut();
  dirty = false; STATE = copy(SAVED);
  NODES.forEach(f => f.remove()); NODES.clear();
  setEditing(false); renderFilters();
  history.replaceState(null, "", location.pathname);
});
addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && EDITING) { e.preventDefault(); $("#ebSave").click(); } });
addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

/* ---------------- boot ---------------- */
// ponytail: deleting a piece leaves its file in storage; clear the bucket by hand if the 1 GB free quota gets close.
(async () => {
  if (client.configured) {
    try { SAVED = await client.readState(); } catch (err) { console.warn("AXREN: could not load pieces", err); }
  }
  SAVED.items ||= [];
  STATE = copy(SAVED);
  renderIntro(); renderFilters(); refresh({ instant: true });
  if (new URLSearchParams(location.search).has("edit")) client.hasSession() ? setEditing(true) : needSignIn();
})();
