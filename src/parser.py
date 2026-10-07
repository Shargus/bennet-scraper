"""Extraction of the static product data (ingredients, nutrition, images...) from a product page."""

import json
import re
from datetime import date, timedelta

from bs4 import BeautifulSoup

_PROMO_DATES = re.compile(
    r'Valida dal(?:&nbsp;|\s)*<strong[^>]*>\s*(\d{1,2}/\d{1,2})\s*</strong>'
    r'(?:&nbsp;|\s)*al(?:&nbsp;|\s)*<strong[^>]*>\s*(\d{1,2}/\d{1,2})\s*</strong>'
)
_BIG_IMAGE = re.compile(
    r'https://bennet-cdn\.thron\.com/delivery/public/(?:thumbnail|image)/bennet/[^"\s\']+/std/1000X1000/(M_[0-9A-Za-z_]+)[^"\s\']*'
)


def _text(el) -> str:
    lines = (line.strip() for line in el.get_text("\n").splitlines())
    return "\n".join(line for line in lines if line)


def _inline(el) -> str:
    return " ".join(el.get_text(" ").split())


def infer_promo_dates(start: str, end: str, today: date):
    """'24/09', '07/10' -> ISO dates; the site omits the year."""
    sd, sm = map(int, start.split("/"))
    ed, em = map(int, end.split("/"))
    s = date(today.year, sm, sd)
    if s > today + timedelta(days=180):
        s = date(today.year - 1, sm, sd)
    e = date(s.year, em, ed)
    if e < s:
        e = date(s.year + 1, em, ed)
    return s.isoformat(), e.isoformat()


def parse_promo_dates(html: str, today: date):
    m = _PROMO_DATES.search(html)
    return infer_promo_dates(m.group(1), m.group(2), today) if m else (None, None)


def _euro(el):
    """'6,49 €' -> 6.49"""
    m = re.search(r"\d+(?:\.\d{3})*,\d\d", _inline(el)) if el else None
    return float(m.group(0).replace(".", "").replace(",", ".")) if m else None


def parse_page_price(soup) -> dict:
    """Price block of the product page: it shows discounts that the search backend
    doesn't expose, such as the one-day "Prezzo Eccezionale" offers."""
    box = soup.select_one(".product-details .c-product-price")
    discount = soup.select_one(".product-details .c-discount .promo-item__fidelity")
    m = re.search(r"(\d+)\s*%", _inline(discount)) if discount else None
    return {
        "price": _euro(box.select_one(".c-product-price__amount")) if box else None,
        "regular_price": _euro(box.select_one(".c-product-price__original")) if box else None,
        "discount": m.group(1) if m else None,
    }


def _nutrition(section):
    table = section.find("table")
    if table is None:
        return None
    header = [_inline(th) for th in table.select("thead th")]
    rows, notes, name = [], [], ""
    for tr in table.select("tbody tr"):
        cells = [_inline(td) for td in tr.find_all("td")]
        if not any(cells):
            continue
        if not any(cells[1:]):  # footnotes such as "La porzione è 95 g"
            notes.append(cells[0])
            continue
        name = cells[0] or name  # energy in kcal comes on an unnamed row after kJ
        row = {"nutriente": name}
        for col, value in zip(header[1:], cells[1:]):
            if col and value:
                row[col] = value
        rows.append(row)
    notes += [_inline(p) for p in section.find_all("p") if not p.find_parent("table")]
    return {"table": rows, "notes": [x for x in notes if x]}


def _ingredients(section):
    items = [_inline(p) for p in section.select("p.c-tab__description")]
    allergens = []
    for b in section.select("p.c-tab__description span[style*=bold], p.c-tab__description strong, p.c-tab__description b"):
        word = _inline(b).lower()
        if word and word not in allergens:
            allergens.append(word)
    may_contain = [i for i in items if i.lower().startswith(("può contenere", "puo' contenere"))]
    ingredients = [i for i in items if i not in may_contain]
    return {
        "ingredients": ", ".join(ingredients) or None,
        "allergens": allergens,
        "may_contain": " ".join(may_contain) or None,
    }


def parse_product_page(html: str, today: date) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    out = {}

    for script in soup.find_all("script", type="application/ld+json"):
        try:
            ld = json.loads(script.string or "")
        except ValueError:
            continue
        if ld.get("@type") == "Product":
            out["gtin13"] = ld.get("gtin13")
            out["short_description"] = ld.get("description")

    images, seen = [], set()
    for m in _BIG_IMAGE.finditer(html):
        if m.group(1) not in seen:
            seen.add(m.group(1))
            images.append(m.group(0))
    out["image_urls"] = sorted(images, key=lambda u: _BIG_IMAGE.match(u).group(1))

    weight = soup.select_one(".product-details .weight-price-info")
    out["package_size"] = _inline(weight) if weight else None

    out["promo_start"], out["promo_end"] = parse_promo_dates(html, today)
    promo = soup.select_one(".product-details .c-discount .promo-item__detail")
    out["promo_description"] = _inline(promo) or None if promo else None
    out.update(parse_page_price(soup))

    sections = {}
    for button in soup.select("button.c-tab__link"):
        title = button.get("aria-label") or _text(button)
        content = button.find_next_sibling("div", class_="c-tab__c-content")
        if not title or content is None or title in sections:
            continue
        sections[title] = content
    out["sections"] = {title: _text(el) for title, el in sections.items()}

    if "Ingredienti e Allergeni" in sections:
        out.update(_ingredients(sections["Ingredienti e Allergeni"]))
    if "Informazioni Nutrizionali" in sections:
        out["nutrition"] = _nutrition(sections["Informazioni Nutrizionali"])
    if "Informazioni Generali" in sections:
        out["description"] = out["sections"]["Informazioni Generali"]
    return out
