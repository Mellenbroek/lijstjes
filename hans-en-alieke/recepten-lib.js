// Rekenwerk voor recepten: ingrediëntregels lezen, porties omrekenen en samenvoegen.
// Een regel ziet eruit als "400 g gehakt", "2 tenen knoflook", "1/2 tl zout" of "Peper en zout".

const FRAC = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };
// [schrijfwijzen, enkelvoud, meervoud]
const UNIT_DEFS = [
  ["kg|kilo|kilogram", "kg"], ["g|gr|gram|grammen", "g"], ["mg", "mg"],
  ["ml|milliliter", "ml"], ["cl", "cl"], ["dl", "dl"], ["l|ltr|liter|liters", "l"],
  ["el|eetlepel|eetlepels", "el"], ["tl|theelepel|theelepels", "tl"],
  ["st|stuk|stuks", "st"], ["x", "x"],
  ["teen|tenen", "teen", "tenen"], ["teentje|teentjes", "teentje", "teentjes"],
  ["takje|takjes", "takje", "takjes"], ["bol|bollen", "bol", "bollen"],
  ["blik|blikken", "blik", "blikken"], ["blikje|blikjes", "blikje", "blikjes"],
  ["pak|pakken", "pak", "pakken"], ["pakje|pakjes", "pakje", "pakjes"],
  ["zak|zakken", "zak", "zakken"], ["zakje|zakjes", "zakje", "zakjes"],
  ["snee|sneden|sneetje|sneetjes", "sneetje", "sneetjes"],
  ["plak|plakken", "plak", "plakken"], ["plakje|plakjes", "plakje", "plakjes"],
  ["bos|bossen", "bos", "bossen"], ["bosje|bosjes", "bosje", "bosjes"],
  ["pot|potten", "pot", "potten"], ["potje|potjes", "potje", "potjes"],
  ["fles|flessen", "fles", "flessen"], ["kopje|kopjes", "kopje", "kopjes"],
  ["handje|handjes", "handje", "handjes"], ["handvol", "handvol", "handvol"],
  ["snufje|snufjes", "snufje", "snufjes"], ["scheut|scheutje|scheutjes", "scheutje", "scheutjes"],
  ["rol|rollen", "rol", "rollen"], ["vel|vellen", "vel", "vellen"]
];
const UNIT = {};
UNIT_DEFS.forEach(function (d) { d[0].split("|").forEach(function (w) { UNIT[w] = { one: d[1], many: d[2] || d[1] }; }); });
const U_RE = Object.keys(UNIT).sort(function (a, b) { return b.length - a.length; }).join("|");
const Q_RE = "(?:\\d+\\s*[½¼¾⅓⅔]|\\d+\\s*\\/\\s*\\d+|\\d+(?:[.,]\\d+)?|[½¼¾⅓⅔])";
const LEAD = new RegExp("^(" + Q_RE + ")(?:\\s*[-–]\\s*(" + Q_RE + "))?\\s*(?:(" + U_RE + ")\\.?(?=\\s|$))?\\s*(.*)$", "i");
const TRAIL = new RegExp("^(.*?\\S)\\s+(" + Q_RE + ")(?:\\s*[-–]\\s*(" + Q_RE + "))?\\s*(?:(" + U_RE + ")\\.?)?$", "i");
// Veelgebruikte telwoorden: zodat "1 eieren" "1 ei" wordt en "1 ui" + "2 uien" samen "3 uien".
const NOUN_PAIRS = [["ei","eieren"],["ui","uien"],["sjalot","sjalotten"],["tomaat","tomaten"],["aardappel","aardappelen"],["paprika","paprika's"],
  ["wortel","wortels"],["courgette","courgettes"],["aubergine","aubergines"],["citroen","citroenen"],["limoen","limoenen"],["appel","appels"],
  ["peer","peren"],["banaan","bananen"],["avocado","avocado's"],["champignon","champignons"],["prei","preien"],["komkommer","komkommers"],
  ["wrap","wraps"],["tortilla","tortilla's"],["kipfilet","kipfilets"],["hamburger","hamburgers"],["worst","worsten"],["sinaasappel","sinaasappels"],
  ["krop","kroppen"],["bol","bollen"],["teen","tenen"],["chilipeper","chilipepers"],["lente-ui","lente-uitjes"],["bosui","bosuitjes"]];
const SING = {}, PLUR = {};
NOUN_PAIRS.forEach(function (p) { SING[p[1]] = p[0]; SING[p[0]] = p[0]; PLUR[p[0]] = p[1]; PLUR[p[1]] = p[1]; });
function matchCase(word, like) { return like && like[0] === like[0].toUpperCase() && like[0] !== like[0].toLowerCase() ? word[0].toUpperCase() + word.slice(1) : word; }
function nounFor(name, many) {
  const words = String(name).split(" ");
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase(), map = many ? PLUR : SING;
    if (map[w]) { words[i] = matchCase(map[w], words[i]); return words.join(" "); }
  }
  return name;
}
const METRIC = { g: 1, kg: 1000, mg: 0.001, ml: 1, cl: 10, dl: 100, l: 1000 };
const FAMILY = { g: "g", kg: "g", mg: "g", ml: "ml", cl: "ml", dl: "ml", l: "ml" };

export function parseNum(s) {
  s = String(s).replace(/\s+/g, "");
  let m = s.match(/^(\d+)([½¼¾⅓⅔])$/);
  if (m) return +m[1] + FRAC[m[2]];
  if (FRAC[s] != null) return FRAC[s];
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return +m[2] ? +m[1] / +m[2] : null;
  const n = parseFloat(s.replace(",", "."));
  return isFinite(n) ? n : null;
}

function cleanText(s) {
  return String(s || "").replace(/\(\(/g, "(").replace(/\)\)/g, ")").replace(/\s+/g, " ").trim();
}
function lowerFirst(s) {
  return s && /^[A-ZÀ-Ý][a-zà-ÿ]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

// Lees één ingrediëntregel. q is null als er geen hoeveelheid in staat.
export function parseIng(line) {
  const raw = cleanText(line);
  let m = raw.match(LEAD);
  if (m && m[4]) {
    const u = m[3] ? UNIT[m[3].toLowerCase()] : null;
    return { q: parseNum(m[1]), q2: m[2] ? parseNum(m[2]) : null, unit: u ? u.one : "", name: m[4].trim(), raw: raw };
  }
  m = raw.match(TRAIL);
  if (m && !/[(]$/.test(m[1])) {
    const u2 = m[4] ? UNIT[m[4].toLowerCase()] : null;
    return { q: parseNum(m[2]), q2: m[3] ? parseNum(m[3]) : null, unit: u2 ? u2.one : "", name: lowerFirst(m[1].trim()), raw: raw };
  }
  return { q: null, q2: null, unit: "", name: raw, raw: raw };
}

function roundFor(n, unit) {
  if (unit === "g" || unit === "ml") { if (n >= 100) return Math.round(n / 10) * 10; if (n >= 20) return Math.round(n / 5) * 5; return Math.max(1, Math.round(n)); }
  if (unit === "kg" || unit === "l") return Math.max(0.05, Math.round(n * 20) / 20);
  if (unit === "cl" || unit === "dl") return Math.max(0.5, Math.round(n * 2) / 2);
  if (n < 3) return Math.max(0.25, Math.round(n * 4) / 4);
  if (n < 10) return Math.round(n * 2) / 2;
  return Math.round(n);
}
export function fmtNum(n) {
  const whole = Math.floor(n + 1e-9), frac = n - whole;
  const F = [[0.25, "¼"], [0.5, "½"], [0.75, "¾"]];
  for (let i = 0; i < F.length; i++) if (Math.abs(frac - F[i][0]) < 0.01) return (whole ? String(whole) : "") + F[i][1];
  if (frac < 0.01 || frac > 0.99) return String(Math.round(n));
  return String(Math.round(n * 100) / 100).replace(".", ",");
}

// Kies een nette eenheid: 1500 g wordt 1,5 kg, 0,4 kg wordt 400 g.
function tidy(p) {
  if (p.q == null || !METRIC[p.unit]) return p;
  const fam = FAMILY[p.unit], base = p.q * METRIC[p.unit], base2 = p.q2 != null ? p.q2 * METRIC[p.unit] : null;
  const big = fam === "g" ? "kg" : "l";
  const unit = (base2 || base) >= 1000 ? big : fam;
  return Object.assign({}, p, { unit: unit, q: base / METRIC[unit], q2: base2 != null ? base2 / METRIC[unit] : null });
}

export function scaleIng(p, f) {
  if (p.q == null || !isFinite(f) || f <= 0 || Math.abs(f - 1) < 1e-9) return p;
  return tidy(Object.assign({}, p, { q: p.q * f, q2: p.q2 != null ? p.q2 * f : null }));
}

export function lineOf(p) {
  if (p.q == null) return p.name || p.raw;
  const q = roundFor(p.q, p.unit), q2 = p.q2 != null ? roundFor(p.q2, p.unit) : null;
  let num = fmtNum(q) + (q2 != null && q2 !== q ? "-" + fmtNum(q2) : "");
  let unit = "";
  if (p.unit) {
    const u = UNIT[p.unit] || { one: p.unit, many: p.unit };
    unit = (q2 || q) > 1 ? u.many : u.one;
  }
  const name = p.unit ? p.name : nounFor(p.name, (q2 || q) > 1);
  if (p.unit === "x") return num + "x " + name;
  return num + (unit ? " " + unit : "") + (name ? " " + name : "");
}

// Schrijf een regel netjes op: "Aardappelen kruimig 1kg" wordt "1 kg aardappelen kruimig".
export function normalizeLine(line) {
  const p = parseIng(line);
  if (p.q == null) return p.raw;
  return lineOf(Object.assign({}, p, { name: lowerFirst(p.name) }));
}

export function ingKey(p) {
  return String(p.name || p.raw).toLowerCase().replace(/\s+/g, " ").trim().split(" ").map(function (w) { return SING[w] || w; }).join(" ");
}

// Voeg dezelfde ingrediënten (van verschillende recepten) samen: 200 g + 0,3 kg gehakt = 500 g gehakt.
export function combine(entries) {
  const out = [], byKey = {};
  entries.forEach(function (e) {
    const p = e.p, fam = p.q != null && METRIC[p.unit] ? FAMILY[p.unit] : (p.q != null ? "n:" + p.unit : "-");
    const k = ingKey(p) + "|" + fam;
    const hit = byKey[k];
    if (!hit) {
      const copy = { p: p, src: e.src.slice() };
      byKey[k] = copy; out.push(copy); return;
    }
    e.src.forEach(function (s) { if (hit.src.indexOf(s) < 0) hit.src.push(s); });
    if (p.q == null) return;
    if (METRIC[p.unit]) {
      const sum = hit.p.q * METRIC[hit.p.unit] + p.q * METRIC[p.unit];
      hit.p = tidy(Object.assign({}, hit.p, { unit: FAMILY[p.unit], q: sum, q2: null }));
    } else {
      hit.p = Object.assign({}, hit.p, { q: hit.p.q + p.q, q2: null });
    }
  });
  return out;
}

// Tel een hoeveelheid op bij een bestaande regel op de boodschappenlijst, als dat kan.
export function addToLine(existingText, p) {
  const e = parseIng(existingText);
  if (e.q == null || p.q == null || ingKey(e) !== ingKey(p)) return null;
  if (METRIC[e.unit] && METRIC[p.unit] && FAMILY[e.unit] === FAMILY[p.unit]) {
    const sum = e.q * METRIC[e.unit] + p.q * METRIC[p.unit];
    return lineOf(tidy(Object.assign({}, e, { unit: FAMILY[e.unit], q: sum, q2: null })));
  }
  if (!METRIC[e.unit] && !METRIC[p.unit] && (UNIT[e.unit] || {}).one === (UNIT[p.unit] || {}).one) {
    return lineOf(Object.assign({}, e, { q: e.q + p.q, q2: null }));
  }
  return null;
}

const STAPLES = ["zout", "peper", "peper en zout", "zout en peper", "olie", "olijfolie", "zonnebloemolie", "water", "kraanwater"];
export function isStaple(p) {
  return STAPLES.indexOf(ingKey(p)) >= 0;
}
