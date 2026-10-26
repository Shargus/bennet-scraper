"""Storage on a local SQLite file or on a Turso (libSQL) database over HTTP.

Prices are stored as periods: a row of `prices` covers the days during which none
of PRICE_FIELDS changed. The current period of a product has valid_to NULL, so a
daily run writes only what changed, not one row per product.
"""

import os
import sqlite3

from curl_cffi import requests

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    product_id          TEXT PRIMARY KEY,   -- e.g. P_0594291
    sku                 TEXT,
    eans                TEXT,               -- JSON list
    name                TEXT,
    brand               TEXT,
    url                 TEXT,
    category1           TEXT,
    category2           TEXT,
    category3           TEXT,
    category_codes      TEXT,               -- JSON list (includes promo landing pages)
    characteristics     TEXT,               -- JSON list, e.g. ["VEGANO", "SENZA GLUTINE"]
    unit                TEXT,               -- unit of `weight` (GR, ML, PZ, ...)
    weight              REAL,
    weight_choices      TEXT,               -- JSON list, for products sold by weight
    is_food             INTEGER,
    is_private_label    INTEGER,
    is_new              INTEGER,
    max_order_quantity  INTEGER,
    thumbnail_url       TEXT,
    first_seen          TEXT,
    removed_on          TEXT,               -- first run that no longer found it; NULL if listed
    -- from the product page (see `details` command)
    package_size        TEXT,
    short_description   TEXT,
    description         TEXT,
    ingredients         TEXT,
    allergens           TEXT,               -- JSON list
    may_contain         TEXT,
    nutrition           TEXT,               -- JSON {"table": [...], "notes": [...]}
    technical_specs     TEXT,               -- non-food products
    sections            TEXT,               -- JSON {tab title: text} with every info tab
    image_urls          TEXT,               -- JSON list of 1000x1000 images
    details_fetched_at  TEXT,
    details_failed_at   TEXT,               -- last attempt that found no page (e.g. HTTP 404)
    details_error       TEXT                -- error of that attempt
);

CREATE TABLE IF NOT EXISTS prices (
    product_id              TEXT NOT NULL REFERENCES products(product_id),
    store_id                TEXT NOT NULL,
    valid_from              TEXT NOT NULL,  -- first run that saw these values
    valid_to                TEXT,           -- last run that saw them; NULL = still current
    price                   REAL,           -- price paid (discounted if in promo)
    price_per_unit          REAL,
    price_unit              TEXT,           -- unit of price_per_unit (KG, LT, PZ...)
    regular_price           REAL,           -- price before discount
    regular_price_per_unit  REAL,
    has_promotion           INTEGER,
    promo_type              TEXT,           -- PromotionPercentageDiscount, PromotionPriceCut, ...
    promo_code              TEXT,
    promo_value             TEXT,           -- e.g. discount percentage
    promo_start             TEXT,
    promo_end               TEXT,
    marketing_label         TEXT,
    stock_status            TEXT,
    PRIMARY KEY (product_id, store_id, valid_from)
);

CREATE INDEX IF NOT EXISTS prices_current ON prices(product_id, store_id) WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS promotions (
    promo_code      TEXT PRIMARY KEY,
    start_date      TEXT,
    end_date        TEXT,
    description     TEXT,               -- as shown on the site, e.g. "-20%", "3x2"
    sample_url      TEXT,
    fetched_at      TEXT
);

-- one row per completed catalog download
CREATE TABLE IF NOT EXISTS runs (
    run_date        TEXT NOT NULL,
    store_id        TEXT NOT NULL,
    products        INTEGER,
    total_hits      INTEGER,
    price_changes   INTEGER,
    new_products    INTEGER,
    removed         INTEGER,
    finished_at     TEXT,
    PRIMARY KEY (run_date, store_id)
);

CREATE VIEW IF NOT EXISTS latest_prices AS
SELECT p.*, pr.valid_from, pr.store_id, pr.price, pr.price_per_unit, pr.price_unit,
       pr.regular_price, pr.regular_price_per_unit, pr.has_promotion, pr.promo_type,
       pr.promo_code, pr.promo_value, pr.promo_start, pr.promo_end, pr.stock_status
FROM products p
JOIN prices pr ON pr.product_id = p.product_id AND pr.valid_to IS NULL;
"""

# Fields whose change opens a new row in `prices` (promo_start/promo_end follow promo_code).
PRICE_FIELDS = (
    "price", "price_per_unit", "price_unit", "regular_price", "regular_price_per_unit",
    "has_promotion", "promo_type", "promo_code", "promo_value", "marketing_label", "stock_status",
)


def _statements(script):
    stmts, buf = [], ""
    for line in script.splitlines(keepends=True):
        buf += line
        if sqlite3.complete_statement(buf):
            stmts.append(buf.strip())
            buf = ""
    return stmts


class SQLiteDB:
    def __init__(self, path):
        self.con = sqlite3.connect(path)
        self.con.row_factory = sqlite3.Row

    def query(self, sql, params=()):
        return [dict(r) for r in self.con.execute(sql, params)]

    def batch(self, statements):
        """Run [(sql, params), ...] in one transaction."""
        with self.con:
            for sql, params in statements:
                self.con.execute(sql, params)

    def execute(self, sql, params=()):
        self.batch([(sql, params)])


class TursoDB:
    """Minimal client for Turso's HTTP API (https://docs.turso.tech/sdk/http/reference)."""

    def __init__(self, url, token):
        self.url = url.replace("libsql://", "https://").rstrip("/") + "/v2/pipeline"
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {token}"

    @staticmethod
    def _arg(v):
        if v is None:
            return {"type": "null", "value": None}
        if isinstance(v, bool):
            return {"type": "integer", "value": str(int(v))}
        if isinstance(v, int):
            return {"type": "integer", "value": str(v)}
        if isinstance(v, float):
            return {"type": "float", "value": v}
        return {"type": "text", "value": str(v)}

    @staticmethod
    def _value(v):
        if v["type"] == "integer":
            return int(v["value"])
        if v["type"] == "float":
            return float(v["value"])
        return v.get("value")

    def _stmt(self, sql, params):
        return {"sql": sql, "args": [self._arg(p) for p in params]}

    def _pipeline(self, requests_):
        r = self.session.post(self.url, json={"requests": requests_ + [{"type": "close"}]}, timeout=120)
        r.raise_for_status()
        results = r.json()["results"][:-1]
        for res in results:
            if res["type"] != "ok":
                raise RuntimeError(f"Turso error: {res.get('error')}")
        return [res["response"] for res in results]

    def query(self, sql, params=()):
        result = self._pipeline([{"type": "execute", "stmt": self._stmt(sql, params)}])[0]["result"]
        cols = [c["name"] for c in result["cols"]]
        return [dict(zip(cols, map(self._value, row))) for row in result["rows"]]

    def batch(self, statements, chunk=500):
        """Run [(sql, params), ...] atomically (one transaction per request).

        Big batches are split in chunks to keep requests small; each chunk is atomic.
        """
        statements = list(statements)
        for i in range(0, len(statements), chunk):
            part = statements[i:i + chunk]
            steps = [{"stmt": {"sql": "BEGIN"}}]
            for sql, params in part:
                steps.append({"stmt": self._stmt(sql, params), "condition": {"type": "ok", "step": len(steps) - 1}})
            commit = len(steps)
            steps.append({"stmt": {"sql": "COMMIT"}, "condition": {"type": "ok", "step": commit - 1}})
            steps.append({"stmt": {"sql": "ROLLBACK"},
                          "condition": {"type": "not", "cond": {"type": "ok", "step": commit}}})
            result = self._pipeline([{"type": "batch", "batch": {"steps": steps}}])[0]["result"]
            errors = [e for e in result["step_errors"] if e]
            if errors:
                raise RuntimeError(f"Turso batch failed: {errors[0]}")

    def execute(self, sql, params=()):
        self._pipeline([{"type": "execute", "stmt": self._stmt(sql, params)}])


def connect(path=None):
    """Turso when TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are set, else the SQLite file."""
    url, token = os.environ.get("TURSO_DATABASE_URL"), os.environ.get("TURSO_AUTH_TOKEN")
    db = TursoDB(url, token) if url and token else SQLiteDB(path)
    _migrate(db)
    db.batch([(s, ()) for s in _statements(SCHEMA)])
    return db


def _columns(db, table):
    return {r["name"] for r in db.query(f"PRAGMA table_info({table})")}


def _migrate(db):
    """Bring databases created by earlier versions to the current schema."""
    products = _columns(db, "products")
    if not products:
        return
    steps = []
    if "technical_specs" not in products:
        steps.append(("ALTER TABLE products ADD COLUMN technical_specs TEXT", ()))
    for column in ("removed_on", "details_failed_at", "details_error"):
        if column not in products:
            steps.append((f"ALTER TABLE products ADD COLUMN {column} TEXT", ()))
    if "description" not in _columns(db, "promotions"):
        steps.append(("ALTER TABLE promotions ADD COLUMN description TEXT", ()))
    db.batch(steps)

    prices = _columns(db, "prices")
    if "scrape_date" in prices:
        raise RuntimeError("database from the first version (one price row per day): not supported")
    if "last_seen" in products:
        # periods closed on every run (valid_to NOT NULL): the last run's periods become open
        last = db.query("SELECT MAX(last_seen) AS d FROM products")[0]["d"]
        db.batch([
            ("DROP VIEW IF EXISTS latest_prices", ()),
            ("DROP INDEX IF EXISTS prices_valid_to", ()),
            ("ALTER TABLE prices RENAME TO prices_old", ()),
            *[(s, ()) for s in _statements(SCHEMA)],
            ("INSERT INTO prices SELECT product_id, store_id, valid_from, "
             "CASE WHEN valid_to = ? THEN NULL ELSE valid_to END, "
             + ", ".join(f for f in ("price", "price_per_unit", "price_unit", "regular_price",
                                     "regular_price_per_unit", "has_promotion", "promo_type",
                                     "promo_code", "promo_value", "promo_start", "promo_end",
                                     "marketing_label", "stock_status"))
             + " FROM prices_old", (last,)),
            ("DROP TABLE prices_old", ()),
            ("UPDATE products SET removed_on = ? WHERE last_seen < ?", (last, last)),
            ("INSERT OR IGNORE INTO runs (run_date, store_id, products) "
             "SELECT ?, store_id, COUNT(*) FROM prices WHERE valid_to IS NULL GROUP BY store_id", (last,)),
            ("ALTER TABLE products DROP COLUMN last_seen", ()),
        ])


def upsert_sql(table, row: dict, key: tuple):
    cols = list(row)
    updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c not in key)
    sql = (f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))}) "
           f"ON CONFLICT ({', '.join(key)}) DO " + (f"UPDATE SET {updates}" if updates else "NOTHING"))
    return sql, [row[c] for c in cols]
