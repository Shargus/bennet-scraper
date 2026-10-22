"""Scraping jobs: daily prices, promotion dates, product details."""

import json
import logging
import time
from datetime import date, datetime

from .client import BennetClient
from .db import PRICE_FIELDS, upsert_sql
from .parser import parse_product_page

log = logging.getLogger(__name__)

# Promotions applied at checkout (e.g. 3x2, extra loyalty points): Price is not discounted.
CHECKOUT_PROMOTIONS = {"PromotionMixMatch", "PromotionExtraRewardPoints"}

# A catalog download with fewer products than this share of the reported total is
# treated as failed, so products missing from it aren't marked as removed.
MIN_CATALOG_COMPLETENESS = 0.98

# One-day offers (marketingLabel "Prezzo Eccezionale il 7/10"): the search backend keeps
# the full price and hasPromotion false, the discount is only on the product page.
SPECIAL_OFFER_LABEL = "Prezzo Eccezionale"
SPECIAL_OFFER_TYPE = "PrezzoEccezionale"  # promo_type stored for them (not a site value)
SPECIAL_OFFER_FIELDS = ("price", "price_per_unit", "regular_price", "regular_price_per_unit",
                        "has_promotion", "promo_type", "promo_value", "promo_start", "promo_end")


def _json(value):
    return json.dumps(value, ensure_ascii=False) if value not in (None, [], {}) else None


def _category_name(breadcrumb: str) -> str:
    return breadcrumb.split("$")[0].replace("-", " ")


def _product_row(mv: dict) -> dict:
    crumbs = [_category_name(b) for b in mv.get("breadcrumbs", [])] + [None] * 3
    return {
        "product_id": mv["MasterProductNumber"],
        "sku": mv.get("SKU"),
        "eans": _json(mv.get("eans")),
        "name": mv.get("summary"),
        "brand": mv.get("brand"),
        "url": mv.get("url"),
        "category1": crumbs[0],
        "category2": crumbs[1],
        "category3": crumbs[2],
        "category_codes": _json(mv.get("allCategories")),
        "characteristics": _json(mv.get("characteristics")),
        "unit": mv.get("unit"),
        "weight": mv.get("weight"),
        "weight_choices": _json(mv.get("weightChoices")),
        "is_food": mv.get("food"),
        "is_private_label": mv.get("privateLabel"),
        "is_new": mv.get("newProduct"),
        "max_order_quantity": mv.get("maxOrderQuantity"),
        "thumbnail_url": mv.get("imageUrl"),
    }


def _price_row(product_id: str, v: dict) -> dict:
    promo = (v.get("promotion") or "").split("$")
    has_promo = bool(v.get("hasPromotion"))
    cut, cut_unit = v.get("cutPrice") or 0, v.get("cutPricePerUnit") or 0
    discounted = has_promo and promo[0] not in CHECKOUT_PROMOTIONS
    return {
        "product_id": product_id,
        "store_id": v.get("StoreID"),
        "price": v.get("Price"),
        "price_per_unit": v.get("pricePerUnit"),
        "price_unit": v.get("prUnit"),
        # cutPrice is the struck-through price; some price cuts don't expose it
        "regular_price": cut or (None if discounted else v.get("Price")),
        "regular_price_per_unit": cut_unit or (None if discounted else v.get("pricePerUnit")),
        "has_promotion": has_promo,
        "promo_type": promo[0] or None,
        "promo_code": promo[1].split("_")[0] if len(promo) > 1 else None,
        "promo_value": promo[2] or None if len(promo) > 2 else None,
        "marketing_label": v.get("marketingLabel") or None,
        "stock_status": v.get("stockLevelStatus"),
    }


def _is_bundle(mv: dict) -> bool:
    """Mixes of several products sold together (e.g. B_0000507), not tracked."""
    return bool(mv.get("bundle")) or mv["MasterProductNumber"].startswith("B_")


def _same(a: dict, b: dict, fields) -> bool:
    return all(a.get(f) == b.get(f) for f in fields)


def _is_special_offer(row: dict) -> bool:
    return not row["has_promotion"] and (row["marketing_label"] or "").startswith(SPECIAL_OFFER_LABEL)


def _apply_special_offer(client: BennetClient, row: dict, cur: dict | None, url: str, today: date) -> bool:
    """Take the discounted price of a "Prezzo Eccezionale" offer from the product page.

    The current period already holding this offer is reused, so the page is read once
    per offer and the next runs don't see a price change.
    """
    if cur and cur["promo_type"] == SPECIAL_OFFER_TYPE and cur["marketing_label"] == row["marketing_label"]:
        row.update({f: cur[f] for f in SPECIAL_OFFER_FIELDS})
        return False
    try:
        page = parse_product_page(client.product_page(url), today)
    except Exception:
        log.exception("failed to read special offer %s from %s", row["product_id"], url)
        return False
    price, regular = page["price"], page["regular_price"]
    if not (price and regular and price < regular):
        log.warning("special offer %s: no discount on the page (%s, %s)", row["product_id"], price, regular)
        return False
    ratio = price / regular
    row.update({
        "price": price,
        "price_per_unit": round(row["price_per_unit"] * ratio, 2) if row["price_per_unit"] else row["price_per_unit"],
        "regular_price": regular,
        "regular_price_per_unit": row["price_per_unit"],
        "has_promotion": True,
        "promo_type": SPECIAL_OFFER_TYPE,
        "promo_value": page["discount"],
        "promo_start": page["promo_start"],
        "promo_end": page["promo_end"],
    })
    log.info("special offer %s: %.2f instead of %.2f (%s -> %s)", row["product_id"], price, regular,
             page["promo_start"], page["promo_end"])
    return True


def update_prices(client: BennetClient, db, today: date) -> dict:
    """Download the whole catalog, then write only what changed since the last run.

    Products missing from the catalog are kept with their history and get `removed_on`
    (the first run that didn't find them), cleared if they come back; a product whose
    name changed gets its page queued again for `update_details`. One-day
    "Prezzo Eccezionale" offers get their discounted price from the product page.
    Nothing is written unless the full catalog was downloaded, so an interrupted
    run doesn't mark products as removed or split their price periods.
    """
    day = today.isoformat()
    hits, total_hits = client.fetch_catalog()
    products, prices = {}, {}
    bundles = 0
    for hit in hits:
        mv = hit["masterValues"]
        if _is_bundle(mv):
            bundles += 1
            continue
        row = _product_row(mv)
        products[row["product_id"]] = row
        for v in hit.get("variantValues", []):
            if v.get("StoreID") == client.search_store_id:
                prices[row["product_id"]] = _price_row(row["product_id"], v)
    if len(products) + bundles < total_hits * MIN_CATALOG_COMPLETENESS:
        raise RuntimeError(f"incomplete catalog: {len(products) + bundles} of {total_hits} products")

    store = client.search_store_id
    prev_run = db.query("SELECT MAX(run_date) AS d FROM runs WHERE store_id = ? AND run_date < ?",
                        (store, day))[0]["d"]
    last_run = db.query("SELECT MAX(run_date) AS d FROM runs WHERE store_id = ? AND run_date <= ?",
                        (store, day))[0]["d"]
    known = {r["product_id"]: r for r in db.query("SELECT * FROM products")}
    current = {r["product_id"]: r for r in db.query(
        "SELECT * FROM prices WHERE valid_to IS NULL AND store_id = ?", (store,))}

    specials = 0
    for pid, row in prices.items():
        if _is_special_offer(row) and row["stock_status"] != "absent":
            specials += _apply_special_offer(client, row, current.get(pid), products[pid]["url"], today)

    stmts = []
    new = changed = renamed = returned = removed = 0
    catalog_fields = [f for f in next(iter(products.values())) if f != "product_id"]
    for pid, row in products.items():
        old = known.get(pid)
        if old is None:
            new += 1
            stmts.append(upsert_sql("products", {**row, "first_seen": day}, ("product_id",)))
            continue
        update = dict(row)
        if old["name"] != row["name"]:
            # a new name is the sign that the product page changed too
            renamed += 1
            update["details_fetched_at"] = None
        if old["removed_on"]:
            returned += 1
            update["removed_on"] = None
        if len(update) > len(row) or not _same(old, row, catalog_fields):
            stmts.append(upsert_sql("products", update, ("product_id",)))

    for pid, row in prices.items():
        cur = current.get(pid)
        if cur and _same(cur, row, PRICE_FIELDS):
            continue
        changed += 1
        if cur and cur["valid_from"] != day:
            # the old values were last seen on the previous run
            stmts.append(("UPDATE prices SET valid_to = ? WHERE product_id = ? AND store_id = ? AND valid_from = ?",
                          (prev_run or cur["valid_from"], pid, store, cur["valid_from"])))
        # a period opened today by an earlier run is simply overwritten
        stmts.append(upsert_sql("prices", {**row, "valid_from": day, "valid_to": None},
                                ("product_id", "store_id", "valid_from")))

    for pid, cur in current.items():
        if pid not in prices:
            stmts.append(("UPDATE prices SET valid_to = ? WHERE product_id = ? AND store_id = ? AND valid_from = ?",
                          (last_run or cur["valid_from"], pid, store, cur["valid_from"])))

    for pid in known.keys() - products.keys():
        if not known[pid]["removed_on"]:
            removed += 1
            stmts.append(("UPDATE products SET removed_on = ? WHERE product_id = ?", (day, pid)))

    stats = {"products": len(products), "total_hits": total_hits, "price_changes": changed,
             "new_products": new, "removed": removed}
    stmts.append(upsert_sql("runs", {"run_date": day, "store_id": store, **stats,
                                     "finished_at": datetime.now().isoformat(timespec="seconds")},
                            ("run_date", "store_id")))
    db.batch(stmts)
    log.info("catalog: %d products (%d bundles skipped), %d new, %d back in the catalog, %d renamed, "
             "%d price changes, %d removed, %d special offers read, %d writes",
             len(products), bundles, new, returned, renamed, changed, removed, specials, len(stmts))
    return stats


def _save_details(db, product_id: str, details: dict):
    db.execute(*upsert_sql("products", {
        "product_id": product_id,
        "package_size": details.get("package_size"),
        "short_description": details.get("short_description"),
        "description": details.get("description"),
        "ingredients": details.get("ingredients"),
        "allergens": _json(details.get("allergens")),
        "may_contain": details.get("may_contain"),
        "nutrition": _json(details.get("nutrition")),
        "technical_specs": details["sections"].get("Specifiche Tecniche"),
        "sections": _json(details.get("sections")),
        "image_urls": _json(details.get("image_urls")),
        "details_fetched_at": datetime.now().isoformat(timespec="seconds"),
    }, ("product_id",)))


def update_promotions(client: BennetClient, db, today: date) -> int:
    """Promotion dates are only on product pages; all products of a promo code share
    them, so one page per active code is enough (its details are saved too)."""
    day = today.isoformat()
    todo = db.query("""
        SELECT pr.promo_code, MIN(p.product_id) AS product_id, MIN(p.url) AS url
        FROM prices pr JOIN products p USING (product_id)
        LEFT JOIN promotions pm ON pm.promo_code = pr.promo_code
        WHERE pr.valid_to IS NULL AND pr.has_promotion AND pr.promo_code IS NOT NULL
          AND pr.stock_status IS NOT 'absent'
          AND (pm.promo_code IS NULL OR pm.end_date IS NULL OR pm.end_date < ?)
        GROUP BY pr.promo_code
    """, (day,))
    log.info("%d promotion codes need dates", len(todo))
    for i, r in enumerate(todo, 1):
        try:
            details = parse_product_page(client.product_page(r["url"]), today)
        except Exception:
            log.exception("failed to read promotion %s from %s", r["promo_code"], r["url"])
            continue
        _save_details(db, r["product_id"], details)
        db.execute(*upsert_sql("promotions", {
            "promo_code": r["promo_code"],
            "start_date": details["promo_start"],
            "end_date": details["promo_end"],
            "description": details["promo_description"],
            "sample_url": r["url"],
            "fetched_at": day,
        }, ("promo_code",)))
        log.info("promotion %d/%d %s: %s -> %s", i, len(todo), r["promo_code"],
                 details["promo_start"], details["promo_end"])
    db.execute("""
        UPDATE prices SET
            promo_start = (SELECT start_date FROM promotions pm WHERE pm.promo_code = prices.promo_code),
            promo_end   = (SELECT end_date   FROM promotions pm WHERE pm.promo_code = prices.promo_code)
        WHERE valid_to IS NULL AND has_promotion AND EXISTS (
            SELECT 1 FROM promotions pm WHERE pm.promo_code = prices.promo_code
              AND (pm.start_date IS NOT prices.promo_start OR pm.end_date IS NOT prices.promo_end))
    """)
    return len(todo)


def update_details(client: BennetClient, db, today: date, limit: int,
                   max_minutes: float | None = None) -> int:
    """Fetch the pages of new products and of products whose name changed
    (`update_prices` clears their details_fetched_at); pages are never refreshed otherwise.
    Out-of-stock products and products no longer in the catalog have no page (404)
    until they are back."""
    deadline = time.monotonic() + max_minutes * 60 if max_minutes else None
    rows = db.query("""
        SELECT product_id, url FROM products
        WHERE details_fetched_at IS NULL AND removed_on IS NULL AND NOT EXISTS (
            SELECT 1 FROM prices pr WHERE pr.product_id = products.product_id
              AND pr.valid_to IS NULL AND pr.stock_status = 'absent')
        ORDER BY first_seen
        LIMIT ?
    """, (limit,))
    log.info("fetching details for up to %d products", len(rows))
    done = 0
    for r in rows:
        if deadline and time.monotonic() > deadline:
            log.info("time budget of %s minutes reached", max_minutes)
            break
        try:
            _save_details(db, r["product_id"], parse_product_page(client.product_page(r["url"]), today))
        except Exception:
            log.exception("failed to read %s", r["url"])
            continue
        done += 1
        if done % 20 == 0:
            log.info("details %d/%d", done, len(rows))
    log.info("details fetched for %d products", done)
    return done
