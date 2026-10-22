import {
  DAY, PROMO_TYPES, STOCK, fmtDate, fmtDay, fmtEuro, fmtUnitPrice, h, normalize, parseDay,
  sentenceCase, statusBadge,
} from "./format.js";
import { PriceChart, RANGES, buildSegments } from "./chart.js";

const PAGE_SIZE = 48;
const OTHER = "ALTRO";
const SORTS = [
  ["", "Rilevanza"],
  ["name", "Nome (A-Z)"],
  ["price-asc", "Prezzo crescente"],
  ["price-desc", "Prezzo decrescente"],
  ["unit-asc", "Prezzo al kg/l crescente"],
  ["discount", "Sconto maggiore"],
  ["changed", "Variati di recente"],
  ["new", "Ultimi arrivati"],
];
// Which products to list: in the catalog (default), also the ones no longer in it, or only those.
const SHOW = [
  ["", "Prodotti in catalogo"],
  ["all", "Anche non più in catalogo"],
  ["removed", "Solo non più in catalogo"],
];
const FLAGS = [
  ["promo", "In promozione"],
  ["avail", "Disponibili"],
  ["drop", "Prezzo sceso (7 giorni)"],
  ["own", "Marchio Bennet"],
];

const app = document.getElementById("app");
const search = document.getElementById("search");
let data;
let chart;
let lastListHash = "#/";
const scrollMemory = new Map();

// ---------------------------------------------------------------- data

async function loadCatalog() {
  const res = await fetch("data/catalog.json");
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
  const d = await res.json();
  const col = Object.fromEntries(d.columns.map((c, i) => [c, i]));
  const lastRun = parseDay(d.lastRun);
  const products = d.products.map((r) => {
    const p = {};
    for (const c of d.columns) p[c] = r[col[c]];
    p.path = d.categories[p.cat].filter(Boolean);
    p.thumbUrl = p.thumb ? (p.thumb.startsWith("http") ? p.thumb : d.thumbPrefix + p.thumb) : null;
    p.available = !p.removed && (p.stock === "i" || p.stock === "l");
    p.discount = p.regular && p.price < p.regular ? 1 - p.price / p.regular : 0;
    p.dropped = p.prevPrice != null && p.price < p.prevPrice
      && p.lastChange && lastRun - parseDay(p.lastChange) <= 7 * DAY;
    p.atMin = p.prevPrice != null && p.price != null && p.price <= p.minPrice && p.price < p.prevPrice;
    p.text = normalize(`${p.name} ${p.brand || ""} ${p.eans || ""} ${p.id}`);
    p.nameKey = normalize(p.name);
    return p;
  });
  const charCounts = new Map();
  for (const p of products) for (const c of p.chars) charCounts.set(c, (charCounts.get(c) || 0) + 1);
  data = {
    ...d, products, lastRunTime: lastRun,
    byId: new Map(products.map((p) => [p.id, p])),
    chars: [...charCounts].sort((a, b) => b[1] - a[1]).map(([i, n]) => ({ id: i, name: d.characteristics[i], n })),
    tree: buildTree(products),
  };
  document.getElementById("updated").textContent = `Ultimo aggiornamento: ${fmtDate(d.lastRun)}.`;
}

function buildTree(products) {
  const root = new Map();
  for (const p of products) {
    let level = root;
    for (const name of p.path) {
      if (!level.has(name)) level.set(name, new Map());
      level = level.get(name);
    }
  }
  return root;
}

// ---------------------------------------------------------------- routing

function parseRoute() {
  const [path, query = ""] = (location.hash.slice(1) || "/").split("?");
  if (path.startsWith("/p/")) return { view: "product", id: decodeURIComponent(path.slice(3)) };
  const q = new URLSearchParams(query);
  return {
    view: "list",
    state: {
      q: q.get("q") || "",
      cat: q.get("cat") ? q.get("cat").split(">") : [],
      promo: q.has("promo"), avail: q.has("avail"), drop: q.has("drop"), own: q.has("own"),
      show: SHOW.some(([v]) => v === q.get("show")) ? q.get("show") : "",
      char: q.get("char") || "",
      pmin: q.get("pmin") || "", pmax: q.get("pmax") || "",
      sort: q.get("sort") || "",
      page: Math.max(1, parseInt(q.get("page"), 10) || 1),
    },
  };
}

function listHash(st) {
  const q = new URLSearchParams();
  if (st.q) q.set("q", st.q);
  if (st.cat.length) q.set("cat", st.cat.join(">"));
  for (const [k] of FLAGS) if (st[k]) q.set(k, "");
  for (const k of ["show", "char", "pmin", "pmax", "sort"]) if (st[k]) q.set(k, st[k]);
  if (st.page > 1) q.set("page", st.page);
  const qs = q.toString().replace(/=(&|$)/g, "$1");
  return `#/${qs ? `?${qs}` : ""}`;
}

function go(st, { replace = false } = {}) {
  const hash = listHash(st);
  if (replace) { history.replaceState(null, "", hash); render(); }
  else location.hash = hash;
}

// ---------------------------------------------------------------- filtering

const num = (v) => (v === "" ? null : parseFloat(String(v).replace(",", ".")));

function filterProducts(st, { ignoreCat = false } = {}) {
  const tokens = normalize(st.q).split(/\s+/).filter(Boolean);
  const pmin = num(st.pmin), pmax = num(st.pmax), ch = st.char === "" ? null : +st.char;
  return data.products.filter((p) => {
    if (!ignoreCat) for (let i = 0; i < st.cat.length; i++) if (p.path[i] !== st.cat[i]) return false;
    if (st.show === "" && p.removed) return false;
    if (st.show === "removed" && !p.removed) return false;
    if (st.promo && !p.promo) return false;
    if (st.avail && !p.available) return false;
    if (st.drop && !p.dropped) return false;
    if (st.own && !p.own) return false;
    if (ch != null && !p.chars.includes(ch)) return false;
    if (pmin != null && !(p.price >= pmin)) return false;
    if (pmax != null && !(p.price <= pmax)) return false;
    for (const t of tokens) if (!p.text.includes(t)) return false;
    return true;
  });
}

const byName = (a, b) => a.nameKey.localeCompare(b.nameKey, "it");
const nullsLast = (f) => (a, b) => {
  const x = f(a), y = f(b);
  if (x == null || y == null) return (x == null) - (y == null);
  return x - y;
};

function sortProducts(list, st) {
  const tokens = normalize(st.q).split(/\s+/).filter(Boolean);
  const cmp = {
    name: byName,
    "price-asc": nullsLast((p) => p.price),
    "price-desc": nullsLast((p) => (p.price == null ? null : -p.price)),
    "unit-asc": nullsLast((p) => (fmtUnitPrice(p.ppu, p.unit) ? p.ppu : null)),
    discount: (a, b) => b.discount - a.discount || (b.promo ? 1 : 0) - (a.promo ? 1 : 0),
    changed: (a, b) => (b.lastChange || "").localeCompare(a.lastChange || ""),
    new: (a, b) => b.firstSeen.localeCompare(a.firstSeen),
  }[st.sort];
  if (cmp) return list.sort((a, b) => cmp(a, b) || byName(a, b));
  const score = (p) => (p.removed ? 8 : 0) + (p.available ? 0 : 4)
    + (tokens.length && !p.nameKey.startsWith(tokens[0]) ? 1 : 0)
    + (tokens.length && !tokens.every((t) => p.nameKey.includes(t)) ? 2 : 0);
  return list.sort((a, b) => score(a) - score(b) || byName(a, b));
}

// ---------------------------------------------------------------- catalog page

function renderList(st) {
  document.title = "Storico prezzi Bennet";
  if (search.value !== st.q && document.activeElement !== search) search.value = st.q;
  const all = sortProducts(filterProducts(st), st);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.min(st.page, pages);
  const shown = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const title = st.q ? `Risultati per “${st.q}”` : st.cat.length ? sentenceCase(st.cat[st.cat.length - 1]) : "Tutti i prodotti";
  const results = h("section", { class: "results" },
    st.cat.length ? crumbs(st) : null,
    h("h1", {}, title),
    filtersRow(st),
    h("div", { class: "result-meta" },
      h("span", { class: "tabular" }, `${all.length.toLocaleString("it-IT")} prodott${all.length === 1 ? "o" : "i"}`
        + (pages > 1 ? ` · pagina ${page} di ${pages}` : "")),
      h("label", {}, "Ordina per",
        h("select", { class: "select", onchange: (e) => go({ ...st, sort: e.target.value, page: 1 }) },
          SORTS.map(([v, l]) => h("option", { value: v, selected: v === st.sort }, l))))),
    shown.length ? h("div", { class: "grid" }, shown.map(card))
      : h("p", { class: "empty" }, "Nessun prodotto corrisponde ai filtri."),
    pager(page, pages, st));

  const focused = document.activeElement?.dataset?.focus;
  const caret = focused ? document.activeElement.selectionStart : null;
  app.replaceChildren(h("div", { class: "layout" }, sidebar(st), results));
  if (focused) {
    const el = app.querySelector(`[data-focus="${focused}"]`);
    el?.focus();
    el?.setSelectionRange(caret, caret);
  }
}

function crumbs(st) {
  const parts = [h("a", { href: listHash({ ...st, cat: [], page: 1 }) }, "Tutte le categorie")];
  st.cat.forEach((name, i) => {
    parts.push(h("span", { class: "sep", "aria-hidden": "true" }, "›"));
    parts.push(i === st.cat.length - 1 ? h("span", {}, sentenceCase(name))
      : h("a", { href: listHash({ ...st, cat: st.cat.slice(0, i + 1), page: 1 }) }, sentenceCase(name)));
  });
  return h("nav", { class: "crumbs", "aria-label": "Categoria" }, parts);
}

function sidebar(st) {
  const counts = new Map();
  const base = filterProducts(st, { ignoreCat: true });
  for (const p of base) {
    let key = "";
    for (const name of p.path) {
      key += `>${name}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const sorted = (m) => [...m.keys()].sort((a, b) => (a === OTHER) - (b === OTHER) || a.localeCompare(b, "it"));
  const level = (node, path) => h("ul", {}, sorted(node).map((name) => {
    const p = [...path, name];
    const key = `>${p.join(">")}`;
    const n = counts.get(key) || 0;
    const selected = st.cat.length === p.length && p.every((x, i) => st.cat[i] === x);
    const open = p.every((x, i) => st.cat[i] === x);
    return h("li", {},
      h("button", { type: "button", "aria-current": selected ? "true" : null, disabled: !n && !open,
        onclick: () => go({ ...st, cat: selected ? path : p, page: 1 }) },
        h("span", {}, sentenceCase(name)), h("span", { class: "count" }, n.toLocaleString("it-IT"))),
      open && node.get(name).size ? level(node.get(name), p) : null);
  }));
  const tree = h("div", { class: "tree" },
    h("ul", {}, h("li", {}, h("button", { type: "button", "aria-current": st.cat.length ? null : "true",
      onclick: () => go({ ...st, cat: [], page: 1 }) },
      h("span", {}, "Tutte le categorie"), h("span", { class: "count" }, base.length.toLocaleString("it-IT"))))),
    level(data.tree, []));
  const label = st.cat.length ? sentenceCase(st.cat[st.cat.length - 1]) : "Tutte le categorie";
  return h("aside", { class: "sidebar" },
    h("details", { open: window.matchMedia("(min-width: 901px)").matches },
      h("summary", {}, h("span", {}, `Categorie: ${label}`), h("span", { "aria-hidden": "true" }, "▾")),
      h("h2", {}, "Categorie"), tree));
}

function filtersRow(st) {
  const active = FLAGS.some(([k]) => st[k]) || st.show || st.char || st.pmin || st.pmax;
  let timer;
  const priceInput = (key, placeholder) => h("input", {
    class: "price-input", type: "text", inputmode: "decimal", placeholder, value: st[key], "data-focus": key,
    "aria-label": placeholder === "min" ? "Prezzo minimo in euro" : "Prezzo massimo in euro",
    oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => go({ ...st, [key]: e.target.value.trim(), page: 1 }, { replace: true }), 500); },
    onchange: (e) => { clearTimeout(timer); go({ ...st, [key]: e.target.value.trim(), page: 1 }, { replace: true }); },
  });
  return h("div", { class: "filters", role: "group", "aria-label": "Filtri" },
    FLAGS.map(([k, label]) => h("label", { class: "chip" },
      h("input", { type: "checkbox", checked: st[k], onchange: (e) => go({ ...st, [k]: e.target.checked, page: 1 }) }), label)),
    h("select", { class: "select", "aria-label": "Prodotti da mostrare", onchange: (e) => go({ ...st, show: e.target.value, page: 1 }) },
      SHOW.map(([v, l]) => h("option", { value: v, selected: v === st.show }, l))),
    h("select", { class: "select", "aria-label": "Caratteristica", onchange: (e) => go({ ...st, char: e.target.value, page: 1 }) },
      h("option", { value: "" }, "Tutte le caratteristiche"),
      data.chars.map((c) => h("option", { value: c.id, selected: String(c.id) === st.char }, `${sentenceCase(c.name)} (${c.n})`))),
    h("span", { class: "price-range" }, "€", priceInput("pmin", "min"), "–", priceInput("pmax", "max")),
    active ? h("button", { class: "link-button", type: "button",
      onclick: () => go({ ...st, promo: false, avail: false, drop: false, own: false, show: "", char: "", pmin: "", pmax: "", page: 1 }) },
    "Azzera filtri") : null);
}

function card(p) {
  const unit = fmtUnitPrice(p.ppu, p.unit);
  const delta = p.prevPrice != null && p.price !== p.prevPrice ? p.price - p.prevPrice : null;
  return h("a", { class: "card", href: `#/p/${encodeURIComponent(p.id)}` },
    h("div", { class: `thumb${p.available ? "" : " na"}` },
      p.thumbUrl ? h("img", { src: p.thumbUrl, alt: "", loading: "lazy", decoding: "async", width: 200, height: 200 }) : null),
    h("div", { class: "badges" },
      p.promo ? h("span", { class: "badge promo" }, p.promo) : p.atMin ? h("span", { class: "badge low" }, "Minimo storico") : null,
      p.available ? null : h("span", { class: "badge stock" }, STOCK[p.removed ? "r" : p.stock].label)),
    h("div", { class: "name" }, p.name),
    h("div", { class: "meta" }, [p.brand && sentenceCase(p.brand), p.size].filter(Boolean).join(" · ") || " "),
    h("div", { class: "prices" },
      h("span", { class: "price" }, fmtEuro(p.price)),
      p.regular && p.regular > p.price ? h("span", { class: "was" }, fmtEuro(p.regular)) : null,
      delta ? h("span", { class: `delta ${delta < 0 ? "down" : "up"}`, title: `Prima: ${fmtEuro(p.prevPrice)}` },
        `${delta < 0 ? "▼" : "▲"} ${fmtEuro(Math.abs(delta))}`) : null,
      unit ? h("span", { class: "unit" }, unit) : null,
      p.promoEnd ? h("span", { class: "until" }, `Promo fino al ${fmtDay(p.promoEnd)}`) : null,
      p.removed ? h("span", { class: "until" }, `Ultimo prezzo, fuori catalogo dal ${fmtDay(p.removed)}`) : null));
}

function pager(page, pages, st) {
  if (pages <= 1) return null;
  const nums = new Set([1, pages, page - 1, page, page + 1, page - 2, page + 2].filter((n) => n >= 1 && n <= pages));
  const list = [...nums].sort((a, b) => a - b);
  const btn = (n, label, extra = {}) => h("button", { type: "button", ...extra, onclick: () => { go({ ...st, page: n }); } }, label);
  const items = [btn(page - 1, "‹ Prec.", { disabled: page === 1, "aria-label": "Pagina precedente" })];
  list.forEach((n, i) => {
    if (i && n - list[i - 1] > 1) items.push(h("span", { class: "gap" }, "…"));
    items.push(btn(n, String(n), { "aria-current": n === page ? "page" : null }));
  });
  items.push(btn(page + 1, "Succ. ›", { disabled: page === pages, "aria-label": "Pagina successiva" }));
  return h("nav", { class: "pager", "aria-label": "Pagine" }, items);
}

// ---------------------------------------------------------------- product page

function cleanText(text) {
  return (text || "").split("\n").map((l) => l.trim())
    .filter((l) => l && l !== "Vedi tutto" && l !== "Riduci").join("\n");
}

async function renderProduct(id) {
  const p = data.byId.get(id);
  app.replaceChildren(h("p", { class: "loading" }, "Caricamento del prodotto…"));
  let d = null;
  try {
    const res = await fetch(`data/p/${encodeURIComponent(id)}.json`);
    if (res.ok) d = await res.json();
  } catch { /* shown below */ }
  if (parseRoute().id !== id) return; // navigated away meanwhile
  const back = h("a", { class: "back", href: lastListHash }, "← Torna ai prodotti");
  if (!d) {
    app.replaceChildren(back, h("p", { class: "empty" }, "Prodotto non trovato: potrebbe non essere più nel catalogo."));
    return;
  }
  document.title = `${d.name} – Storico prezzi Bennet`;
  const unit = p?.unit || null;
  const segs = buildSegments(d, data.lastRun, unit, data.runs);
  const cur = segs[segs.length - 1];
  const path = (d.cat || []).filter(Boolean);

  const crumbsNav = h("nav", { class: "crumbs", "aria-label": "Categoria" },
    path.map((name, i) => [i ? h("span", { class: "sep", "aria-hidden": "true" }, "›") : null,
      h("a", { href: listHash({ ...parseRoute.empty, cat: path.slice(0, i + 1) }) }, sentenceCase(name))]));

  app.replaceChildren(
    back, crumbsNav,
    h("div", { class: "product-head" }, gallery(d), summary(d, p, segs, cur)),
    chartPanel(d, segs),
    historyPanel(segs),
    infoPanel(d));
  window.scrollTo(0, 0);
}
parseRoute.empty = { q: "", cat: [], promo: false, avail: false, drop: false, own: false, show: "", char: "", pmin: "", pmax: "", sort: "", page: 1 };

function gallery(d) {
  const images = d.images || [];
  const main = h("img", { src: images[0] || "", alt: d.name });
  const thumbs = images.length > 1 ? h("div", { class: "thumbs" }, images.map((src, i) => {
    const b = h("button", { type: "button", "aria-label": `Immagine ${i + 1}`, "aria-current": i === 0 ? "true" : null,
      onclick: () => {
        main.src = src;
        thumbs.querySelectorAll("button").forEach((x) => x.removeAttribute("aria-current"));
        b.setAttribute("aria-current", "true");
      } }, h("img", { src: src.replace("/1000X1000/", "/200x200/"), alt: "", loading: "lazy" }));
    return b;
  })) : null;
  return h("div", { class: "gallery" }, h("div", { class: "main" }, images.length ? main : null), thumbs);
}

function summary(d, p, segs, cur) {
  const prices = segs.map((g) => g.price).filter((v) => v != null);
  const min = Math.min(...prices), max = Math.max(...prices);
  const minSeg = segs.find((g) => g.price === min);
  const changes = segs.length - 1;
  const removed = d.removed;
  const promo = removed ? null : cur?.promoType;
  const unitNow = fmtUnitPrice(cur?.ppu, cur?.unit);
  const tile = (label, value, note) => h("div", { class: "stat" },
    h("div", { class: "label" }, label), h("div", { class: "value" }, value), note ? h("div", { class: "note" }, note) : null);
  return h("div", { class: "summary" },
    d.brand ? h("div", { class: "brand-name" }, d.brand) : null,
    h("h1", {}, d.name),
    h("div", { class: "sub" }, [d.size, d.eans?.length ? `EAN ${d.eans.join(", ")}` : null, `Codice ${d.id}`].filter(Boolean).join(" · ")),
    h("div", { class: "price-box" },
      h("div", { class: "now" },
        h("span", { class: "price" }, fmtEuro(cur?.price)),
        !removed && cur?.regular && cur.regular > cur.price ? h("span", { class: "was" }, fmtEuro(cur.regular)) : null,
        !removed && cur?.discount ? h("span", { class: "badge promo" }, `−${Math.round(cur.discount * 100)}%`) : null),
      h("div", { class: "lines" },
        removed ? h("span", {}, `Ultimo prezzo rilevato il ${fmtDate(cur.end - DAY)}. `
          + `Il prodotto non è più nel catalogo online dal ${fmtDate(removed)}.`) : null,
        unitNow ? h("span", {}, unitNow) : null,
        promo ? h("span", {}, `${PROMO_TYPES[promo] || "Promozione"}${cur.promoText ? `: ${cur.promoText}` : ""}`
          + (cur.promoStart && cur.promoEnd ? `, dal ${fmtDay(cur.promoStart)} al ${fmtDay(cur.promoEnd)}` : "")) : null,
        !removed && cur?.regularEstimated ? h("span", {}, "Prezzo pieno stimato dal periodo senza promozione più vicino.") : null,
        cur?.label && !promo ? h("span", {}, cur.label) : null,
        d.maxOrder ? h("span", {}, `Massimo ${d.maxOrder} pezzi per ordine`) : null,
        h("span", {}, statusBadge(removed ? "r" : cur?.stock)))),
    h("div", { class: "stats" },
      tile("Minimo storico", fmtEuro(min), minSeg ? `dal ${fmtDay(minSeg.start)}` : null),
      tile("Massimo storico", fmtEuro(max)),
      tile("Variazioni", String(changes), `monitorato dal ${fmtDay(segs[0]?.start ?? d.firstSeen)}`)),
    d.chars?.length || d.own ? h("div", { class: "tags" },
      d.own ? h("span", { class: "tag" }, "Marchio Bennet") : null,
      (d.chars || []).map((c) => h("span", { class: "tag" }, sentenceCase(c)))) : null,
    d.url && !removed ? h("p", {}, h("a", { class: "external", href: d.url, target: "_blank", rel: "noopener" }, "Vedi su bennet.com ↗")) : null);
}

function chartPanel(d, segs) {
  const panel = h("section", { class: "panel" });
  const legendItems = [
    ["paid", "Prezzo pagato", "line paid"],
    ["regular", "Prezzo pieno", "line regular"],
    ["promo", "Promozione", "rect promo"],
    ["na", "Non acquistabile", "rect na"],
  ];
  const hasEstimate = segs.some((g) => g.regularEstimated);
  const ranges = h("div", { class: "ranges", role: "group", "aria-label": "Intervallo" });
  const legend = h("div", { class: "legend" });
  const body = h("div", {});
  panel.append(h("div", { class: "panel-head" }, h("h2", {}, "Andamento del prezzo"), ranges), legend, body);
  if (hasEstimate) panel.append(h("p", { class: "hint" }, "Linea tratteggiata: prezzo pieno stimato, perché la promozione non lo indica."));
  chart?.destroy();
  chart = new PriceChart(body, segs, { lastRun: data.lastRun });
  for (const r of RANGES) {
    const b = h("button", { type: "button", "aria-pressed": r.key === chart.range ? "true" : "false",
      onclick: () => {
        chart.setRange(r.key);
        ranges.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
      } }, r.label);
    ranges.append(b);
  }
  for (const [key, label, cls] of legendItems) {
    const b = h("button", { type: "button", "aria-pressed": "true",
      onclick: () => b.setAttribute("aria-pressed", chart.toggle(key) ? "true" : "false") },
    h("span", { class: `key ${cls}` }), label);
    legend.append(b);
  }
  if (chart.gaps.length) legend.append(h("span", { class: "legend-static" }, h("span", { class: "key rect gap" }), "Fuori catalogo"));
  return panel;
}

// dates of the current year without the year, to keep the table narrow
const periodDay = (t) => (new Date(t).getUTCFullYear() === new Date(data.lastRunTime).getUTCFullYear() ? fmtDay(t) : fmtDate(t));

function historyPanel(segs) {
  const rows = [...segs].reverse().map((g) => {
    const last = g.end - DAY;
    return h("tr", {},
      h("td", { class: "nowrap" }, g.start === last ? periodDay(g.start) : `${periodDay(g.start)} – ${periodDay(last)}`),
      h("td", { class: "num" }, fmtEuro(g.price)),
      h("td", { class: "num" }, g.regular != null ? `${fmtEuro(g.regular)}${g.regularEstimated ? "*" : ""}` : "—"),
      h("td", { class: "num" }, g.discount ? `−${Math.round(g.discount * 100)}%` : "—"),
      h("td", {}, g.promoType ? `${PROMO_TYPES[g.promoType] || "Promozione"}${g.promoText ? ` (${g.promoText})` : ""}` : "—"),
      h("td", {}, (STOCK[g.stock] || STOCK.i).label),
      h("td", { class: "num" }, fmtUnitPrice(g.ppu, g.unit) || "—"));
  });
  return h("section", { class: "panel" },
    h("h2", {}, "Storico prezzi"),
    h("p", { class: "hint" }, "Un periodo per ogni cambio di prezzo, promozione o disponibilità. * prezzo pieno stimato."),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Periodo", "Prezzo", "Prezzo pieno", "Sconto", "Promozione", "Disponibilità", "Al kg/l"]
        .map((t, i) => h("th", { class: [1, 2, 3, 6].includes(i) ? "num" : null }, t)))),
      h("tbody", {}, rows))));
}

function infoPanel(d) {
  const blocks = [];
  const desc = cleanText(d.description || d.shortDescription);
  if (desc) {
    const box = h("div", { class: "clamp" }, h("p", {}, desc));
    if (desc.split("\n").length > 6 || desc.length > 500) {
      box.classList.add("closed");
      const more = h("button", { type: "button", class: "link-button", "aria-expanded": "false",
        onclick: () => {
          const open = box.classList.toggle("closed") === false;
          more.textContent = open ? "Mostra meno" : "Mostra tutto";
          more.setAttribute("aria-expanded", String(open));
        } }, "Mostra tutto");
      box.append(more);
    }
    blocks.push(h("div", { class: "wide" }, h("h3", {}, "Descrizione"), box));
  }
  if (d.ingredients || d.allergens?.length || d.mayContain) {
    blocks.push(h("div", {}, h("h3", {}, "Ingredienti"),
      d.ingredients ? h("p", {}, d.ingredients) : null,
      d.allergens?.length ? h("p", {}, h("strong", {}, "Allergeni: "), d.allergens.join(", ")) : null,
      d.mayContain ? h("p", {}, d.mayContain) : null));
  }
  if (d.nutrition?.table?.length) {
    const cols = [...new Set(d.nutrition.table.flatMap((r) => Object.keys(r)).filter((k) => k !== "nutriente"))];
    blocks.push(h("div", {}, h("h3", {}, "Valori nutrizionali"),
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Nutriente"), cols.map((c) => h("th", { class: "num" }, c)))),
        h("tbody", {}, d.nutrition.table.map((r) => h("tr", {}, h("td", {}, r.nutriente),
          cols.map((c) => h("td", { class: "num" }, r[c] || "")))))),
      (d.nutrition.notes || []).map((n) => h("p", { class: "hint" }, n)))));
  }
  const shown = new Set(["Informazioni Generali", "Ingredienti e Allergeni", "Informazioni Nutrizionali"]);
  const others = Object.entries(d.sections || {}).filter(([k, v]) => !shown.has(k) && cleanText(v));
  if (!blocks.length && !others.length) return null;
  return h("section", { class: "panel" },
    h("h2", {}, "Informazioni sul prodotto"),
    blocks.length ? h("div", { class: "info-grid" }, blocks) : null,
    others.map(([k, v]) => h("details", {}, h("summary", {}, k), h("p", {}, cleanText(v).split("\n").slice(1).join("\n") || cleanText(v)))));
}

// ---------------------------------------------------------------- boot

function render() {
  const route = parseRoute();
  if (route.view === "product") {
    renderProduct(route.id);
    return;
  }
  chart?.destroy();
  chart = null;
  lastListHash = location.hash || "#/";
  renderList(route.state);
  const y = scrollMemory.get(lastListHash);
  window.scrollTo(0, y || 0);
}

let searchTimer;
search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const route = parseRoute();
    const st = route.view === "list" ? route.state : { ...parseRoute.empty };
    go({ ...st, q: search.value.trim(), page: 1 }, { replace: route.view === "list" });
  }, 200);
});

window.addEventListener("scroll", () => {
  if (parseRoute().view === "list") scrollMemory.set(location.hash || "#/", window.scrollY);
}, { passive: true });
window.addEventListener("hashchange", render);

document.getElementById("theme").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch { /* private mode */ }
});

loadCatalog().then(render).catch((e) => {
  app.replaceChildren(h("p", { class: "empty" }, `Impossibile caricare il catalogo (${e.message}).`));
});
