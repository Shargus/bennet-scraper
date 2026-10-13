// Formatting, labels and a tiny DOM helper shared by the pages and the chart.

export const DAY = 86400000;

const euro = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });
const dayShort = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "short", timeZone: "UTC" });
const dayMedium = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dayLong = new Intl.DateTimeFormat("it-IT", { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const monthShort = new Intl.DateTimeFormat("it-IT", { month: "short", timeZone: "UTC" });
const monthYear = new Intl.DateTimeFormat("it-IT", { month: "short", year: "numeric", timeZone: "UTC" });

export const parseDay = (iso) => Date.parse(`${iso}T00:00:00Z`);
const asTime = (d) => (typeof d === "string" ? parseDay(d) : d);
export const fmtEuro = (v) => (v == null ? "—" : euro.format(v));
export const fmtDay = (d) => dayShort.format(asTime(d));
export const fmtDate = (d) => dayMedium.format(asTime(d));
export const fmtLongDate = (d) => dayLong.format(asTime(d));
export const fmtMonth = (d) => monthShort.format(asTime(d));
export const fmtMonthYear = (d) => monthYear.format(asTime(d));

export const PROMO_TYPES = {
  PromotionPercentageDiscount: "Sconto percentuale",
  PromotionPriceCut: "Taglio prezzo",
  PromotionPriceCommerceCut: "Prezzo speciale",
  PromotionMixMatch: "Multiacquisto",
  PromotionExtraRewardPoints: "Punti extra",
  PrezzoEccezionale: "Prezzo eccezionale",
};
// Promotions applied at checkout: the shelf price is not discounted.
export const CHECKOUT_PROMOS = new Set(["PromotionMixMatch", "PromotionExtraRewardPoints"]);

export const STOCK = {
  i: { label: "Disponibile", level: "ok" },
  l: { label: "Ultimi pezzi", level: "warn" },
  o: { label: "Non acquistabile online", level: "bad" },
  a: { label: "Esaurito", level: "bad" },
};

const UNITS = { kg: "kg", lt: "l", mt: "m" };
export const fmtUnitPrice = (ppu, unit) =>
  ppu && UNITS[unit] ? `${euro.format(ppu)}/${UNITS[unit]}` : null;

export const sentenceCase = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s);

export const normalize = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** h("a", {href, class}, child, ...) - text children are inserted as text nodes, never as HTML. */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  append(el, children);
  return el;
}

export function statusBadge(code) {
  const st = STOCK[code] || STOCK.i;
  const icon = {
    ok: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3.2 5.3-3.8 4a.8.8 0 0 1-1.1 0L4.8 8.8a.8.8 0 1 1 1.1-1.1l1 1 3.2-3.5a.8.8 0 0 1 1.1 1.1z",
    warn: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.8 3.5h1.6v5H7.2zm.8 8.2a1 1 0 1 1 0-2 1 1 0 0 1 0 2z",
    bad: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm2.9 8.8-1.1 1.1L8 9.1l-1.8 1.8-1.1-1.1L6.9 8 5.1 6.2l1.1-1.1L8 6.9l1.8-1.8 1.1 1.1L9.1 8z",
  }[st.level];
  return h("span", { class: `status ${st.level}` },
    s("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" }, s("path", { d: icon })), st.label);
}
