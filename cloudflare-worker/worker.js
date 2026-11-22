// Tussenstation voor "Recept van een link" in de lijstjes-app.
// Haalt een receptpagina op en geeft alleen de receptgegevens terug die de site zelf
// voor zoekmachines in de pagina zet (schema.org/Recipe). Geen AI, geen opslag.

const ALLOWED_ORIGINS = ["https://mellenbroek.github.io"];
const MAX_BYTES = 3_000_000;

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const reply = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

    if (!ALLOWED_ORIGINS.includes(origin)) return reply(403, { error: "niet-toegestaan" });
    if (request.method !== "GET") return reply(405, { error: "alleen-get" });

    const target = new URL(request.url).searchParams.get("url") || "";
    let url;
    try { url = new URL(target.trim()); } catch { return reply(400, { error: "ongeldige-link" }); }
    if (!/^https?:$/.test(url.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) return reply(400, { error: "ongeldige-link" });

    let res;
    try {
      res = await fetch(url.href, {
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
          "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.6",
        },
      });
    } catch {
      return reply(502, { error: "ophalen-mislukt" });
    }
    if (!res.ok) return reply(502, { error: "ophalen-mislukt", status: res.status });
    const html = await readLimited(res, MAX_BYTES);
    const recipe = extractRecipe(html, res.url || url.href);
    if (!recipe) return reply(422, { error: "geen-recept" });
    return reply(200, recipe);
  },
};

async function readLimited(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > max) { try { await reader.cancel(); } catch {} break; }
  }
  const all = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) { const part = c.subarray(0, all.length - off); all.set(part, off); off += part.length; if (off >= all.length) break; }
  return new TextDecoder("utf-8").decode(all);
}

function extractRecipe(html, pageUrl) {
  const blocks = [...html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  for (const raw of blocks) {
    let data;
    try { data = JSON.parse(raw.trim()); } catch {
      try { data = JSON.parse(raw.trim().replace(/[\u0000-\u001f]+/g, " ")); } catch { continue; }
    }
    const recipe = findRecipe(data, 0);
    if (recipe) return toResult(recipe, pageUrl);
  }
  return null;
}

function findRecipe(node, depth) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findRecipe(n, depth + 1); if (r) return r; }
    return null;
  }
  const types = [].concat(node["@type"] || []).map(String);
  if (types.some((t) => t.toLowerCase() === "recipe" || t.endsWith("/Recipe"))) return node;
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    const r = findRecipe(node[key], depth + 1);
    if (r) return r;
  }
  return null;
}

function toResult(r, pageUrl) {
  const name = clean(r.name || r.headline || "");
  const ingredients = [].concat(r.recipeIngredient || r.ingredients || []).map((x) => clean(typeof x === "string" ? x : x && (x.text || x.name))).filter(Boolean).slice(0, 100);
  const steps = instructionsText(r.recipeInstructions);
  if (!name && !ingredients.length) return null;
  return {
    name: name.slice(0, 120),
    serves: parseYield(r.recipeYield),
    minutes: parseDuration(r.totalTime) || sumDurations(r.prepTime, r.cookTime),
    ingredients,
    steps: steps.slice(0, 20000),
    notes: clean(r.description || "").slice(0, 1000),
    url: canonicalUrl(r.url, pageUrl),
  };
}

function instructionsText(ins) {
  if (!ins) return "";
  if (typeof ins === "string") return cleanBlock(ins);
  const out = [];
  let n = 0;
  const walk = (item) => {
    if (!item) return;
    if (typeof item === "string") { const t = clean(item); if (t) out.push(++n + ". " + t); return; }
    if (Array.isArray(item)) { item.forEach(walk); return; }
    const types = [].concat(item["@type"] || []).map(String);
    if (types.includes("HowToSection") || item.itemListElement) {
      const title = clean(item.name || "");
      if (title) out.push(title.toUpperCase());
      walk(item.itemListElement);
      return;
    }
    const t = clean(item.text || item.name || item.description || "");
    if (t) out.push(++n + ". " + t);
  };
  walk(ins);
  return out.join("\n\n");
}

function parseYield(y) {
  for (const v of [].concat(y || [])) {
    const m = String(v).match(/\d+/);
    if (m) { const n = parseInt(m[0], 10); if (n > 0 && n < 100) return n; }
  }
  return null;
}
function parseDuration(d) {
  const m = String(d || "").match(/^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:\d+(?:\.\d+)?S)?)?$/i);
  if (!m) return null;
  const min = Math.round((+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0));
  return min > 0 && min <= 1440 * 3 ? min : null;
}
function sumDurations(a, b) {
  const x = parseDuration(a), y = parseDuration(b);
  return x || y ? (x || 0) + (y || 0) : null;
}
function canonicalUrl(u, pageUrl) {
  try { const x = new URL(String(u || pageUrl), pageUrl); return /^https?:$/.test(x.protocol) ? x.href : pageUrl; } catch { return pageUrl; }
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—", deg: "°", frac12: "½", frac14: "¼", frac34: "¾", shy: "", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", eacute: "é", euml: "ë", iuml: "ï", ouml: "ö", uuml: "ü", egrave: "è", agrave: "à", ccedil: "ç" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, e) => {
    if (e[0] === "#") { const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return code ? String.fromCodePoint(code) : all; }
    return ENT[e.toLowerCase()] ?? all;
  });
}
function clean(s) {
  return decode(decode(String(s || "")).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function cleanBlock(s) {
  return decode(decode(String(s || "")).replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, " "))
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n\n");
}
