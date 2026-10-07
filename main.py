import argparse
import csv
import logging
import os
from datetime import date

from src.client import DEFAULT_DELAY, BennetClient
from src.db import TursoDB, connect, upsert_sql
from src.jobs import update_details, update_prices, update_promotions

DEFAULT_STORE = "0113"  # Torino, via Giordano Bruno 142 (10134)
TABLES = {  # table: primary key
    "products": ("product_id",),
    "prices": ("product_id", "store_id", "valid_from"),
    "promotions": ("promo_code",),
    "runs": ("run_date", "store_id"),
}


def load_dotenv(path=".env"):
    """KEY=VALUE lines from .env into the environment (real env vars win)."""
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            key, sep, value = line.strip().partition("=")
            if sep and not key.startswith("#"):
                os.environ.setdefault(key.strip(), value.strip().strip('"'))


def upload(local_path):
    """Copy a local SQLite database to Turso."""
    url, token = os.environ.get("TURSO_DATABASE_URL"), os.environ.get("TURSO_AUTH_TOKEN")
    if not (url and token):
        raise SystemExit("set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (e.g. in .env)")
    os.environ.pop("TURSO_DATABASE_URL")
    source = connect(local_path)  # also migrates the local file to the current schema
    os.environ["TURSO_DATABASE_URL"] = url
    target = connect()
    for table, key in TABLES.items():
        rows = source.query(f"SELECT * FROM {table}")
        target.batch([upsert_sql(table, r, key) for r in rows], chunk=200)
        logging.info("%s: %d rows uploaded", table, len(rows))


def main():
    load_dotenv()
    ap = argparse.ArgumentParser(description="Bennet price tracker")
    ap.add_argument("--db", default="bennet.db",
                    help="local SQLite file, used when TURSO_DATABASE_URL/TURSO_AUTH_TOKEN are not set")
    ap.add_argument("--store", default=DEFAULT_STORE)
    ap.add_argument("--delay", type=float, default=DEFAULT_DELAY,
                    help="seconds between requests (robots.txt asks for 10)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    st = sub.add_parser("stores", help="list the stores closest to a position")
    st.add_argument("lat", type=float)
    st.add_argument("lon", type=float)

    sub.add_parser("prices", help="download today's prices of the whole catalog and promo dates")

    de = sub.add_parser("details", help="download pages of new or renamed products (ingredients, nutrition, images)")
    de.add_argument("--limit", type=int, default=500)
    de.add_argument("--max-minutes", type=float, help="stop after this many minutes")

    da = sub.add_parser("daily", help="prices + promotions + a batch of details")
    da.add_argument("--details-limit", type=int, default=500)
    da.add_argument("--details-minutes", type=float, help="time budget for the details step")

    ex = sub.add_parser("export", help="export current prices joined with product data to CSV")
    ex.add_argument("out")

    sub.add_parser("upload", help="copy the local --db file to Turso")

    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.cmd == "stores":
        for s in BennetClient(args.store, delay=1).nearest_stores(args.lat, args.lon):
            print(s["name"], s["formattedDistance"], s["displayName"], "-", s["address"]["formattedAddress"])
        return
    if args.cmd == "upload":
        upload(args.db)
        return

    db = connect(args.db)
    logging.info("database: %s", "Turso" if isinstance(db, TursoDB) else args.db)
    if args.cmd == "export":
        rows = db.query("SELECT * FROM latest_prices")
        with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(rows[0].keys() if rows else [])
            w.writerows(r.values() for r in rows)
        print(f"{len(rows)} rows written to {args.out}")
        return

    client = BennetClient(args.store, delay=args.delay)
    client.select_store()
    today = date.today()
    if args.cmd in ("prices", "daily"):
        update_prices(client, db, today)
        update_promotions(client, db, today)
    if args.cmd == "details":
        update_details(client, db, today, args.limit, args.max_minutes)
    if args.cmd == "daily":
        update_details(client, db, today, args.details_limit, max_minutes=args.details_minutes)


if __name__ == "__main__":
    main()
