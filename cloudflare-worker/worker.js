// Tussenstation voor "Recept van een link" in de lijstjes-app.
// Haalt een receptpagina op en geeft alleen de receptgegevens terug die de site zelf
// voor zoekmachines in de pagina zet (schema.org/Recipe). Geen opslag.
// Is het recept niet in het Nederlands, dan worden Amerikaanse maten en °F eerst zonder AI
// omgerekend en daarna de tekst vertaald met het vertaalmodel van Workers AI (binding "AI").

const ALLOWED_ORIGINS = ["https://mellenbroek.github.io"];
const MAX_BYTES = 3_000_000;

export default {
  async fetch(request, env) {
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
    const lang = detectLang(recipe, htmlLang(html));
    recipe.lang = lang;
    recipe.translated = false;
    if (lang !== "nl") {
      convertUnits(recipe);
      if (env && env.AI && new URL(request.url).searchParams.get("vertaal") !== "0") {
        try { await translateRecipe(recipe, lang, env.AI); recipe.translated = true; }
        catch { recipe.translateFailed = true; }
      }
      if (recipe._ing) { recipe.ingredients = recipe._ing.map((x) => x.prefix + x.rest); delete recipe._ing; }
    }
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

/* ---------- taal herkennen ---------- */
function htmlLang(html) {
  const m = html.match(/<html[^>]*\slang\s*=\s*["']?([a-z]{2})/i);
  return m ? m[1].toLowerCase() : "";
}
const NL_WORDS = new Set("de het een en van met in op voor je aan tot minuten snijd voeg toe bak kook laat verwarm roer meng snipper fruit ui knoflook zout peper boter bloem suiker eieren eetlepel theelepel ongeveer tot dat".split(" "));
const EN_WORDS = new Set("the and a of with to in for minutes add cook bake until cup cups tbsp tsp tablespoon teaspoon stir mix heat preheat oven onion garlic salt pepper butter flour sugar eggs about into over".split(" "));
function detectLang(r, attr) {
  const words = (r.ingredients.join(" ") + " " + r.steps + " " + r.name).toLowerCase().match(/[a-zà-ÿ]+/g) || [];
  let nl = 0, en = 0;
  for (const w of words) { if (NL_WORDS.has(w)) nl++; if (EN_WORDS.has(w)) en++; }
  if (nl + en >= 6) return nl >= en ? "nl" : (attr && attr !== "nl" ? attr : "en");
  return attr || "nl";
}

/* ---------- maten omrekenen (zonder AI) ---------- */
const FRAC = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
const NUM = "(\\d+\\s+\\d+\\/\\d+|\\d+\\s*[½¼¾⅓⅔⅛]|\\d+\\/\\d+|\\d+(?:\\.\\d+)?|[½¼¾⅓⅔⅛])";
function num(s) {
  s = String(s).trim();
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/); if (m) return +m[1] + m[2] / m[3];
  m = s.match(/^(\d+)\s*([½¼¾⅓⅔⅛])$/); if (m) return +m[1] + FRAC[m[2]];
  m = s.match(/^(\d+)\/(\d+)$/); if (m) return m[1] / m[2];
  if (FRAC[s] != null) return FRAC[s];
  return parseFloat(s);
}
// gram per cup voor vaste ingrediënten; wat er niet in staat gaat in ml
const CUP_G = [["powdered sugar|icing sugar|confectioners", 120], ["brown sugar", 200], ["sugar", 200], ["all-purpose flour|flour", 125],
  ["butter", 225], ["rolled oats|oats", 90], ["rice", 185], ["quinoa", 170], ["lentils", 190], ["parmesan|cheese", 100], ["cocoa", 100],
  ["chocolate chips|chocolate", 170], ["almonds|walnuts|pecans|nuts|cashews", 120], ["breadcrumbs|panko", 110], ["honey|maple syrup|syrup", 330],
  ["peanut butter", 250], ["beans|chickpeas", 180], ["spinach|kale|arugula", 30], ["peas|corn", 140], ["raisins|cranberries", 150], ["coconut", 80], ["cornstarch", 125]];
const UNITS = [
  ["cups?|c\\.", "cup"], ["tablespoons?|tbsps?|tbs|T", "el"], ["teaspoons?|tsps?|t", "tl"], ["fl\\.? ?oz", "floz"],
  ["ounces?|oz", "oz"], ["pounds?|lbs?", "lb"], ["sticks?", "stick"], ["quarts?|qts?", "quart"], ["pints?|pts?", "pint"], ["gallons?", "gallon"]
];
const UNIT_RE = new RegExp("^" + NUM + "(?:\\s*[-–]\\s*" + NUM + ")?\\s*(" + UNITS.map((u) => u[0]).join("|") + ")\\.?(?=\\s|$)\\s*(?:of\\s+)?(.*)$");
function unitKey(tok) {
  for (const [re, key] of UNITS) if (new RegExp("^(?:" + re + ")$", key === "el" || key === "tl" ? "" : "i").test(tok)) return key;
  return null;
}
function convertLine(line) {
  const m = line.match(UNIT_RE);
  if (!m) return { prefix: "", rest: line, raw: line };
  const q1 = num(m[1]), q2 = m[2] ? num(m[2]) : null, key = unitKey(m[3]), rest = m[4];
  const low = rest.toLowerCase();
  let f = 1, unit = "";
  if (key === "cup") { const hit = CUP_G.find(([w]) => new RegExp("\\b(" + w + ")\\b").test(low)); if (hit) { f = hit[1]; unit = "g"; } else { f = 240; unit = "ml"; } }
  else if (key === "el" || key === "tl") { unit = key; }
  else if (key === "floz") { f = 29.6; unit = "ml"; }
  else if (key === "oz") { f = /\b(milk|water|cream|juice|broth|stock|wine|oil)\b/.test(low) ? 29.6 : 28.35; unit = f === 29.6 ? "ml" : "g"; }
  else if (key === "lb") { f = 453.6; unit = "g"; }
  else if (key === "stick") { f = 113; unit = "g"; }
  else if (key === "quart") { f = 946; unit = "ml"; }
  else if (key === "pint") { f = 473; unit = "ml"; }
  else if (key === "gallon") { f = 3785; unit = "ml"; }
  else return { prefix: "", rest: line, raw: line };
  const fmt = (n) => (unit === "el" || unit === "tl") ? String(Math.round(n * 100) / 100) : String(Math.round(n));
  const amount = fmt(q1 * f) + (q2 != null ? "-" + fmt(q2 * f) : "");
  return { prefix: amount + " " + unit + " ", rest, raw: line };
}
function fToC(f) { return Math.round(((f - 32) * 5) / 9 / 5) * 5; }
function convertText(t) {
  return String(t)
    .replace(/(\d{3})\s*°?\s*(?:degrees\s*)?F\b\s*(?:\(\s*\d{2,3}\s*°?\s*C\s*\)|\/\s*\d{2,3}\s*°?\s*C\b)?/gi, (a, f) => fToC(+f) + " °C")
    .replace(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)[- ]?inch(?:es)?/gi, (a, x, y) => Math.round(x * 2.54) + "x" + Math.round(y * 2.54) + " cm")
    .replace(/(\d+(?:\.\d+)?)[- ]?(?:inch(?:es)?|")(?=[\s,.)]|$)/gi, (a, x) => (Math.round(x * 2.54 * 2) / 2 + " cm").replace(".", ","));
}
function convertUnits(r) {
  r._ing = r.ingredients.map((l) => convertLine(convertText(l)));
  r.steps = convertText(r.steps);
  r.notes = convertText(r.notes);
}

/* ---------- vertalen met Workers AI ---------- */
const MODEL = "@cf/meta/m2m100-1.2b";
async function tr(ai, text, src) {
  const t = String(text || "").trim();
  if (!t || !/[a-z]/i.test(t)) return t;
  const out = await ai.run(MODEL, { text: t, source_lang: src, target_lang: "nl" });
  const res = out && (out.translated_text || out.response);
  if (!res) throw new Error("geen vertaling");
  return String(res).trim();
}
async function translateRecipe(r, src, ai) {
  const ing = r._ing || r.ingredients.map((l) => ({ prefix: "", rest: l }));
  // de bereiding per stap vertalen, nummers en kopjes blijven staan
  const parts = r.steps ? r.steps.split(/\n\n/) : [];
  const jobs = [];
  jobs.push(tr(ai, r.name, src).then((v) => { r.name = v.slice(0, 120); }));
  ing.slice(0, 40).forEach((x, i) => jobs.push(tr(ai, x.rest, src).then((v) => { ing[i].nl = x.prefix + lowerFirst(v); })));
  parts.slice(0, 40).forEach((p, i) => {
    const m = p.match(/^(\d+\.\s+)([\s\S]*)$/);
    const isHead = !m && p === p.toUpperCase();
    jobs.push(tr(ai, m ? m[2] : (isHead ? p.toLowerCase() : p), src).then((v) => { parts[i] = m ? m[1] + v : isHead ? v.toUpperCase() : v; }));
  });
  if (r.notes) jobs.push(tr(ai, r.notes, src).then((v) => { r.notes = v; }));
  await Promise.all(jobs);
  r.ingredients = ing.map((x) => x.nl || x.prefix + x.rest);
  r.steps = parts.join("\n\n");
  delete r._ing;
}
function lowerFirst(s) { return s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s; }
