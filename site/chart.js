// Keepa-style price history chart: step lines for the price paid and the full price,
// shaded promotion periods, hatched periods when the product could not be bought.

import {
  DAY, CHECKOUT_PROMOS, PROMO_TYPES, STOCK, fmtEuro, fmtDay, fmtLongDate, fmtMonth, fmtMonthYear,
  fmtUnitPrice, h, parseDay, s,
} from "./format.js";

export const RANGES = [
  { key: "1s", label: "1S", days: 7 },
  { key: "1m", label: "1M", days: 30 },
  { key: "3m", label: "3M", days: 91 },
  { key: "6m", label: "6M", days: 182 },
  { key: "1a", label: "1A", days: 365 },
  { key: "all", label: "Tutto", days: null },
];
const MIN_SPAN = 7 * DAY;

/**
 * Price periods of data/p/<id>.json as segments [start, end) in ms, each with the price
 * paid and the full price; the full price of a discount that doesn't expose it is
 * estimated from the closest period without a discount (`regularEstimated`).
 * A period ends early when a run in `runs` (ISO dates) didn't find the product:
 * the days until the next period are a gap, when it was not in the catalog.
 */
export function buildSegments(product, lastRun, unit, runs = []) {
  const runTimes = runs.map(parseDay);
  const col = Object.fromEntries(product.columns.map((c, i) => [c, i]));
  const rows = product.history
    .map((r) => ({
      from: parseDay(r[col.from]),
      to: r[col.to] ? parseDay(r[col.to]) : null,
      price: r[col.price],
      regularRaw: r[col.regular],
      ppu: r[col.ppu] || null,
      regularPpu: r[col.regularPpu] || null,
      promoType: r[col.promoType],
      promoValue: r[col.promoValue],
      promoCode: r[col.promoCode],
      promoStart: r[col.promoStart],
      promoEnd: r[col.promoEnd],
      stock: r[col.stock],
      label: r[col.label],
      unit,
    }))
    .sort((a, b) => a.from - b.from);
  const end = parseDay(lastRun) + DAY;
  const discounted = (r) => r.promoType && !CHECKOUT_PROMOS.has(r.promoType);
  rows.forEach((r, i) => {
    const next = rows[i + 1];
    r.start = r.from;
    r.end = next ? next.from : r.to == null ? end : r.to + DAY;
    if (next && r.to != null && runTimes.some((t) => t > r.to && t < next.from)) r.end = r.to + DAY;
    // a "-20%" text can disagree with the prices: the discount is computed from them instead
    const text = r.promoType ? product.promos?.[r.promoCode] || null : null;
    r.promoText = text && !/^-?\s*\d+([.,]\d+)?\s*%$/.test(text) ? text : null;
  });
  rows.forEach((r, i) => {
    r.regularEstimated = false;
    if (!discounted(r)) r.regular = r.price;
    else if (r.regularRaw) r.regular = r.regularRaw;
    else {
      let ref = null;
      for (let j = i - 1; j >= 0 && !ref; j--) if (!discounted(rows[j])) ref = rows[j];
      for (let j = i + 1; j < rows.length && !ref; j++) if (!discounted(rows[j])) ref = rows[j];
      r.regular = ref && ref.price > r.price ? ref.price : null;
      r.regularEstimated = r.regular != null;
    }
    r.discount = r.regular && r.price < r.regular ? 1 - r.price / r.regular : 0;
  });
  return rows;
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function timeTicks(x0, x1, maxTicks) {
  const days = (x1 - x0) / DAY;
  if (days <= 100) {
    const step = [1, 2, 3, 7, 14, 28].find((d) => days / d <= maxTicks) || 28;
    const ticks = [];
    for (let t = x1 - DAY; t >= x0; t -= step * DAY) ticks.push({ t: t + DAY / 2, label: fmtDay(t) });
    return ticks.reverse();
  }
  const months = days / 30.4;
  const step = [1, 2, 3, 6, 12].find((m) => months / m <= maxTicks) || 12;
  const ticks = [];
  const d = new Date(x0);
  let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  for (;;) {
    if (m > 11) { y += Math.floor(m / 12); m %= 12; }
    const t = Date.UTC(y, m, 1);
    if (t > x1) break;
    if (m % step === 0) ticks.push({ t, label: m === 0 ? fmtMonthYear(t) : fmtMonth(t) });
    m += 1;
  }
  return ticks;
}

/** Merge contiguous segments sharing `key(seg)` (falsy keys are skipped) into bands. */
function bands(segs, key) {
  const out = [];
  for (const g of segs) {
    const k = key(g);
    if (!k) continue;
    const last = out[out.length - 1];
    if (last && last.key === k && last.end === g.start) last.end = g.end;
    else out.push({ key: k, start: g.start, end: g.end, seg: g });
  }
  return out;
}

let uid = 0;

export class PriceChart {
  constructor(container, segments, { lastRun, onRangeChange } = {}) {
    this.root = container;
    this.segs = segments;
    this.end = parseDay(lastRun) + DAY;
    this.first = segments.length ? segments[0].start : this.end - MIN_SPAN;
    this.range = "all";
    this.visible = { paid: true, regular: true, promo: true, na: true };
    // days without data after the first observation: the product was not in the catalog
    this.gaps = [];
    segments.forEach((g, i) => {
      const nextStart = i + 1 < segments.length ? segments[i + 1].start : this.end;
      if (g.end < nextStart) this.gaps.push({ start: g.end, end: nextStart });
    });
    this.onRangeChange = onRangeChange;
    this.id = `pc${++uid}`;
    this.hoverDay = null;

    this.plot = h("div", { class: "chart", tabindex: "0", role: "group",
      "aria-label": "Grafico dell'andamento del prezzo. Usa le frecce sinistra e destra per scorrere i giorni." });
    this.tip = h("div", { class: "tooltip", role: "status" });
    this.plot.append(this.tip);
    container.append(this.plot);

    this.plot.addEventListener("pointermove", (e) => this.pointer(e));
    this.plot.addEventListener("pointerdown", (e) => this.pointer(e));
    this.plot.addEventListener("pointerleave", () => this.hover(null));
    this.plot.addEventListener("blur", () => this.hover(null));
    this.plot.addEventListener("keydown", (e) => this.key(e));
    this.resizer = new ResizeObserver(() => this.render());
    this.resizer.observe(this.plot);
  }

  setRange(key) { this.range = key; this.render(); }
  toggle(series) { this.visible[series] = !this.visible[series]; this.render(); return this.visible[series]; }
  destroy() { this.resizer.disconnect(); }

  domain() {
    const r = RANGES.find((x) => x.key === this.range);
    let x0 = r.days ? this.end - r.days * DAY : this.first;
    if (this.end - x0 < MIN_SPAN) x0 = this.end - MIN_SPAN;
    return [x0, this.end];
  }

  render() {
    const width = this.plot.clientWidth;
    if (!width) return;
    const compact = width < 560;
    const height = compact ? 250 : 330;
    const m = { top: 14, right: compact ? 58 : 70, bottom: 28, left: compact ? 46 : 54 };
    const w = width - m.left - m.right, ht = height - m.top - m.bottom;
    const [x0, x1] = this.domain();
    this.geom = { m, w, ht, x0, x1 };
    const X = (t) => m.left + ((Math.min(Math.max(t, x0), x1) - x0) / (x1 - x0)) * w;
    const inView = this.segs.filter((g) => g.end > x0 && g.start < x1);

    let max = 0;
    for (const g of inView) {
      if (this.visible.paid && g.price != null) max = Math.max(max, g.price);
      if (this.visible.regular && g.regular != null) max = Math.max(max, g.regular);
    }
    if (!max) max = Math.max(1, ...inView.map((g) => g.price || 0));
    const step = niceStep((max * 1.12) / 4);
    const yMax = Math.ceil((max * 1.12) / step) * step;
    const Y = (v) => m.top + ht - (v / yMax) * ht;
    this.Y = Y; this.X = X;
    const decimals = Number.isInteger(step) ? 0 : 2;

    const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, height, role: "img", "aria-label": this.summary() });
    const hatchId = `${this.id}-hatch`;
    svg.append(s("defs", {},
      s("pattern", { id: hatchId, patternUnits: "userSpaceOnUse", width: 6, height: 6, patternTransform: "rotate(45)" },
        s("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "hatch-line" })),
      s("clipPath", { id: `${this.id}-clip` }, s("rect", { x: m.left, y: m.top - 2, width: w, height: ht + 4 }))));

    // gridlines and y ticks
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      const y = Y(v);
      svg.append(s("line", { x1: m.left, x2: m.left + w, y1: y, y2: y, class: v === 0 ? "baseline" : "gridline" }));
      svg.append(s("text", { x: m.left - 8, y: y + 4, "text-anchor": "end", class: "tick" },
        v.toLocaleString("it-IT", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + " €"));
    }
    // x ticks
    for (const t of timeTicks(x0, x1, Math.max(2, Math.floor(w / 70)))) {
      svg.append(s("text", { x: X(t.t), y: m.top + ht + 18, "text-anchor": "middle", class: "tick" }, t.label));
    }

    const layer = s("g", { "clip-path": `url(#${this.id}-clip)` });
    svg.append(layer);

    // before the first observation
    if (this.first > x0) {
      const xr = X(this.first);
      layer.append(s("rect", { x: m.left, y: m.top, width: xr - m.left, height: ht, class: "nodata" }));
      if (xr - m.left > 110) {
        layer.append(s("text", { x: (m.left + xr) / 2, y: m.top + ht / 2, "text-anchor": "middle", class: "nodata-label" },
          `Nessun dato prima del ${fmtDay(this.first)}`));
      }
    }
    for (const gap of this.gaps) {
      if (gap.end <= x0 || gap.start >= x1) continue;
      const xa = X(gap.start), xb = X(gap.end);
      layer.append(s("rect", { x: xa, y: m.top, width: Math.max(1, xb - xa), height: ht, class: "gap" }));
      if (xb - xa > 90) {
        layer.append(s("text", { x: (xa + xb) / 2, y: m.top + ht / 2, "text-anchor": "middle", class: "nodata-label" },
          "Fuori catalogo"));
      }
    }
    if (this.visible.na) {
      for (const b of bands(inView, (g) => (g.stock === "a" || g.stock === "o") && "na")) {
        layer.append(s("rect", { x: X(b.start), y: m.top, width: Math.max(1, X(b.end) - X(b.start)), height: ht, fill: `url(#${hatchId})` }));
      }
    }
    if (this.visible.promo) {
      for (const b of bands(inView, (g) => g.promoType && `${g.promoType}|${g.promoCode}|${g.price}`)) {
        const x = X(b.start), bw = Math.max(1, X(b.end) - X(b.start));
        layer.append(s("rect", { x, y: m.top, width: bw, height: ht, class: "band-promo" }));
      }
    }

    const stepPath = (value, include = () => true) => {
      let d = "", prev = null;
      for (const g of inView) {
        const v = value(g);
        if (v == null || !include(g)) { prev = null; continue; }
        const xa = X(g.start), xb = X(g.end), y = Y(v);
        if (prev && prev.end === g.start) d += `V${y.toFixed(1)}H${xb.toFixed(1)}`;
        else {
          const pv = prev === null ? this.prevValue(g, value) : null;
          d += pv != null ? `M${xa.toFixed(1)},${Y(pv).toFixed(1)}V${y.toFixed(1)}H${xb.toFixed(1)}`
            : `M${xa.toFixed(1)},${y.toFixed(1)}H${xb.toFixed(1)}`;
        }
        prev = g;
      }
      return d;
    };

    if (this.visible.regular) {
      layer.append(s("path", { d: stepPath((g) => g.regular, (g) => !g.regularEstimated), class: "s-regular" }));
      layer.append(s("path", { d: stepPath((g) => g.regular, (g) => g.regularEstimated), class: "s-regular est" }));
    }
    if (this.visible.paid) {
      const line = stepPath((g) => g.price);
      // area: close each contiguous run of the line down to the baseline
      const area = line.split("M").filter(Boolean)
        .map((part) => `M${part}V${Y(0).toFixed(1)}H${part.split(",")[0]}Z`).join("");
      layer.append(s("path", { d: area, class: "s-paid-area" }));
      layer.append(s("path", { d: line, class: "s-paid" }));
    }

    // direct label for the current price at the right edge
    const last = this.segs[this.segs.length - 1];
    if (last && last.end >= x1 && last.start < x1) {
      const labels = [];
      if (this.visible.paid && last.price != null) labels.push({ v: last.price, cls: "paid" });
      if (this.visible.regular && last.regular != null && Math.abs(Y(last.regular) - Y(last.price)) >= 16)
        labels.push({ v: last.regular, cls: "regular" });
      for (const l of labels) {
        const y = Y(l.v);
        svg.append(s("circle", { cx: m.left + w, cy: y, r: 4, class: `dot ${l.cls}` }));
        svg.append(s("text", { x: m.left + w + 8, y: y + 4, class: "end-label" }, fmtEuro(l.v)));
      }
    }

    // crosshair layer
    this.cross = s("g", { "pointer-events": "none" });
    svg.append(this.cross);

    const old = this.plot.querySelector("svg");
    if (old) old.replaceWith(svg); else this.plot.prepend(svg);
    if (this.hoverDay != null) this.hover(this.hoverDay);
  }

  prevValue(g, value) {
    const i = this.segs.indexOf(g);
    const p = this.segs[i - 1];
    return p && p.end === g.start ? value(p) : null;
  }

  summary() {
    const prices = this.segs.map((g) => g.price).filter((v) => v != null);
    if (!prices.length) return "Nessun dato sul prezzo";
    const min = Math.min(...prices), max = Math.max(...prices);
    return `Prezzo dal ${fmtDay(this.first)}: attuale ${fmtEuro(prices[prices.length - 1])}, minimo ${fmtEuro(min)}, massimo ${fmtEuro(max)}.`;
  }

  segAt(t) { return this.segs.find((g) => g.start <= t && t < g.end) || null; }

  pointer(e) {
    if (!this.geom) return;
    const { m, w, x0, x1 } = this.geom;
    const rect = this.plot.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < m.left - 10 || px > m.left + w + 10) { this.hover(null); return; }
    const t = x0 + ((Math.min(Math.max(px, m.left), m.left + w) - m.left) / w) * (x1 - x0);
    this.hover(Math.min(Math.floor(t / DAY) * DAY, x1 - DAY));
  }

  key(e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Escape") return;
    e.preventDefault();
    if (e.key === "Escape") { this.hover(null); return; }
    const [x0, x1] = this.domain();
    const start = Math.ceil(x0 / DAY) * DAY;
    let d = this.hoverDay ?? x1 - DAY;
    if (this.hoverDay != null) d += e.key === "ArrowLeft" ? -DAY : DAY;
    this.hover(Math.min(Math.max(d, start), x1 - DAY));
  }

  hover(day) {
    this.hoverDay = day;
    if (!this.cross) return;
    this.cross.replaceChildren();
    if (day == null) { this.tip.classList.remove("show"); return; }
    const { m, w, ht } = this.geom;
    const x = this.X(day + DAY / 2);
    this.cross.append(s("line", { x1: x, x2: x, y1: m.top, y2: m.top + ht, class: "crosshair" }));
    const g = this.segAt(day);

    const rows = [];
    const extra = [];
    if (g) {
      if (this.visible.regular && g.regular != null) {
        this.cross.append(s("circle", { cx: x, cy: this.Y(g.regular), r: 4, class: "dot regular" }));
      }
      if (this.visible.paid && g.price != null) {
        this.cross.append(s("circle", { cx: x, cy: this.Y(g.price), r: 4, class: "dot paid" }));
        rows.push(h("div", { class: "row" }, h("span", { class: "key line paid" }), h("strong", {}, fmtEuro(g.price)),
          h("span", {}, "Prezzo pagato")));
      }
      if (this.visible.regular && g.regular != null) {
        rows.push(h("div", { class: "row" }, h("span", { class: `key ${g.regularEstimated ? "dash" : "line"} regular` }),
          h("strong", {}, fmtEuro(g.regular)), h("span", {}, g.regularEstimated ? "Prezzo pieno (stimato)" : "Prezzo pieno")));
      }
      if (g.promoType) {
        const disc = g.discount ? ` −${Math.round(g.discount * 100)}%` : "";
        extra.push(h("div", {}, `${PROMO_TYPES[g.promoType] || "Promozione"}${disc}${g.promoText ? ` · ${g.promoText}` : ""}`));
        if (g.promoStart && g.promoEnd) extra.push(h("div", {}, `Promo dal ${fmtDay(g.promoStart)} al ${fmtDay(g.promoEnd)}`));
      }
      const unitPrice = fmtUnitPrice(g.ppu, g.unit);
      if (unitPrice) extra.push(h("div", {}, unitPrice));
      extra.push(h("div", {}, (STOCK[g.stock] || STOCK.i).label));
    } else {
      extra.push(h("div", {}, day >= this.first ? "Non presente nel catalogo" : "Nessun dato per questo giorno"));
    }
    this.tip.replaceChildren(h("div", { class: "date" }, fmtLongDate(day)), ...rows,
      extra.length ? h("div", { class: "extra" }, extra) : null);
    this.tip.classList.add("show");
    const tw = this.tip.offsetWidth;
    const left = x + 14 + tw > m.left + w + m.right ? x - 14 - tw : x + 14;
    this.tip.style.transform = `translate(${Math.max(0, left)}px, ${m.top + 6}px)`;
  }
}
