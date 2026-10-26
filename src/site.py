"""Static price-history website: JSON data exported from the database plus the files in site/."""

import hashlib
import json
import logging
import re
import shutil
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).resolve().parent.parent / "site"
THUMB_PREFIX = "https://bennet-cdn.thron.com/delivery/public/thumbnail/bennet/"
OTHER_CATEGORY = "ALTRO"
STOCK_CODES = {"inStock": "i", "lowStock": "l", "outOfStock": "o", "absent": "a"}
# Card badge when the promotion text is too long for it.
PROMO_SHORT = {
    "PromotionMixMatch": "Multiacquisto", "PromotionExtraRewardPoints": "Punti extra",
    "PromotionPriceCommerceCut": "Prezzo speciale", "PromotionPriceCut": "Promo",
    "PromotionPercentageDiscount": "Promo", "PrezzoEccezionale": "Prezzo eccezionale",
}
PAGE = 1000

# Columns of a row of data/catalog.json, in order (see site/app.js).
CATALOG_COLUMNS = [
    "id", "name", "brand", "cat", "thumb", "size", "price", "regular", "ppu", "unit",
    "promo", "promoEnd", "stock", "chars", "own", "firstSeen", "lastChange", "prevPrice", "minPrice", "eans",
    "removed",
]
# Columns of a price period in data/p/<id>.json.
HISTORY_COLUMNS = [
    "from", "to", "price", "regular", "ppu", "regularPpu", "promoType", "promoValue",
    "promoCode", "promoStart", "promoEnd", "stock", "label",
]


def _rows(db, sql, key):
    """All rows of a big table, fetched in pages so each HTTP response stays small."""
    out, last = [], ""
    while True:
        rows = db.query(f"{sql} WHERE {key} > ? ORDER BY {key} LIMIT {PAGE}", (last,))
        out += rows
        if len(rows) < PAGE:
            return out
        last = rows[-1][key]


def _loads(value):
    return json.loads(value) if value else None


def _categories(p):
    if p["category2"] == "p":  # broken breadcrumb: product name, "p", product id
        return OTHER_CATEGORY, None, None
    return p["category1"] or OTHER_CATEGORY, p["category2"], p["category3"]


def _size(p):
    if p["package_size"]:
        return p["package_size"]
    if p["weight"] and p["unit"]:
        w = p["weight"]
        return f"{int(w) if w == int(w) else w} {p['unit'].lower()}"
    return None


def _promo_badge(cur, promos):
    """Short promo text for product cards: '-20%', '3x2', ... or None."""
    if not cur["has_promotion"]:
        return None
    if cur["regular_price"] and cur["price"] and cur["regular_price"] > cur["price"]:
        return f"-{round((1 - cur['price'] / cur['regular_price']) * 100)}%"
    text = promos.get(cur["promo_code"])
    if text and len(text) <= 12:
        return text
    return PROMO_SHORT.get(cur["promo_type"], "Promo")


def _own_brand(p):
    """Bennet's own brands. The search backend's privateLabel flag is inverted:
    false for BENNET, BENNET BIO, ... and true for every other brand."""
    return p["is_private_label"] == 0


def _dump(path: Path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def _bust_cache(out: Path):
    """Add a version of the static files to their URLs (style.css?v=...), so a browser
    never mixes a new page with a stylesheet or script still in its cache."""
    files = sorted(p for p in out.iterdir() if p.suffix in (".css", ".js", ".html"))
    version = hashlib.sha1(b"".join(p.read_bytes() for p in files)).hexdigest()[:10]
    names = "|".join(re.escape(p.name) for p in files if p.suffix != ".html")
    pattern = re.compile(rf'((?:href|src)="|from "\./)({names})"')
    for p in files:
        p.write_text(pattern.sub(rf'\1\2?v={version}"', p.read_text(encoding="utf-8")), encoding="utf-8")


def build_site(db, out: str):
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(STATIC_DIR, out)
    _bust_cache(out)
    (out / "data" / "p").mkdir(parents=True)

    products = _rows(db, "SELECT * FROM products", "product_id")
    history = {}
    for r in _rows(db, "SELECT * FROM (SELECT *, product_id || '|' || valid_from AS k FROM prices)", "k"):
        history.setdefault(r["product_id"], []).append(r)
    promos = {r["promo_code"]: r["description"] for r in db.query("SELECT promo_code, description FROM promotions")}
    runs = [r["run_date"] for r in db.query("SELECT DISTINCT run_date FROM runs ORDER BY run_date")]
    last_run = runs[-1]

    cats, cat_index, chars, char_index, rows = [], {}, [], {}, []
    for p in products:
        periods = sorted(history.get(p["product_id"], []), key=lambda r: r["valid_from"])
        if not periods:
            continue
        cur = periods[-1]
        cat = _categories(p)
        if cat not in cat_index:
            cat_index[cat] = len(cats)
            cats.append(cat)
        char_ids = []
        for c in _loads(p["characteristics"]) or []:
            if c not in char_index:
                char_index[c] = len(chars)
                chars.append(c)
            char_ids.append(char_index[c])
        prev = periods[-2]["price"] if len(periods) > 1 else None
        thumb = p["thumbnail_url"] or ""
        removed = p["removed_on"]
        promo = cur["has_promotion"] and not removed  # a removed product has no running promotion
        rows.append([
            p["product_id"], p["name"], p["brand"], cat_index[cat],
            thumb[len(THUMB_PREFIX):] if thumb.startswith(THUMB_PREFIX) else thumb,
            _size(p), cur["price"], cur["regular_price"] if promo else None,
            cur["price_per_unit"] or None, (cur["price_unit"] or "").lower() or None,
            _promo_badge(cur, promos) if promo else None, cur["promo_end"] if promo else None,
            STOCK_CODES.get(cur["stock_status"], "i"), char_ids, 1 if _own_brand(p) else 0,
            p["first_seen"], cur["valid_from"] if len(periods) > 1 else None, prev,
            min(r["price"] for r in periods if r["price"] is not None) if any(r["price"] for r in periods) else None,
            " ".join(_loads(p["eans"]) or []) or None, removed,
        ])
        _dump(out / "data" / "p" / f"{p['product_id']}.json", {
            "id": p["product_id"], "name": p["name"], "brand": p["brand"], "url": p["url"],
            "cat": cat, "eans": _loads(p["eans"]), "size": _size(p), "firstSeen": p["first_seen"],
            "removed": removed,
            "own": _own_brand(p), "chars": _loads(p["characteristics"]),
            "images": _loads(p["image_urls"]) or [], "thumb": p["thumbnail_url"],
            # the product page was read, or why it couldn't be (e.g. "HTTP 404")
            "detailsFetched": bool(p["details_fetched_at"]), "detailsError": p["details_error"],
            "shortDescription": p["short_description"], "description": p["description"],
            "ingredients": p["ingredients"], "allergens": _loads(p["allergens"]),
            "mayContain": p["may_contain"], "nutrition": _loads(p["nutrition"]),
            "sections": _loads(p["sections"]), "maxOrder": p["max_order_quantity"] or None,
            "promos": {r["promo_code"]: promos[r["promo_code"]] for r in periods
                       if r["promo_code"] and promos.get(r["promo_code"])},
            "columns": HISTORY_COLUMNS,
            "history": [[r["valid_from"], r["valid_to"], r["price"], r["regular_price"], r["price_per_unit"],
                         r["regular_price_per_unit"], r["promo_type"] if r["has_promotion"] else None,
                         r["promo_value"], r["promo_code"], r["promo_start"], r["promo_end"],
                         STOCK_CODES.get(r["stock_status"], "i"),
                         (r["marketing_label"] or "").split("$")[0] or None] for r in periods],
        })

    _dump(out / "data" / "catalog.json", {
        "generated": datetime.now().isoformat(timespec="seconds"), "lastRun": last_run, "runs": runs,
        "thumbPrefix": THUMB_PREFIX, "categories": cats, "characteristics": chars,
        "columns": CATALOG_COLUMNS, "products": rows,
    })
    log.info("site written to %s: %d products (%d no longer in the catalog), last run %s",
             out, len(rows), sum(1 for r in rows if r[-1]), last_run)
