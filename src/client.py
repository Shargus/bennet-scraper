"""HTTP access to bennet.com and to its FACT-Finder search backend."""

import json
import logging
import re
import time

from curl_cffi import requests

log = logging.getLogger(__name__)

SITE = "https://www.bennet.com"
FF_NAVIGATION = "https://search-prod.bennet.com/fact-finder/rest/v5/navigation/Bennet_PROD"
FF_MAX_HITS_PER_PAGE = 200  # FACT-Finder caps hitsPerPage at 200

# bennet.com/robots.txt asks for "Crawl-delay: 10".
DEFAULT_DELAY = 10.0


class BennetClient:
    """A browser-like session bound to one point of sale.

    bennet.com sits behind Akamai, which rejects plain HTTP clients; curl_cffi
    impersonates Chrome's TLS fingerprint so requests go through.
    """

    def __init__(self, store_id: str, delay: float = DEFAULT_DELAY, timeout: float = 30):
        self.store_id = store_id
        self.delay = delay
        self.timeout = timeout
        self._last_request = 0.0
        self.session = requests.Session(impersonate="chrome")
        self.session.headers.update({"Accept-Language": "it-IT,it;q=0.9,en;q=0.8"})
        # The search backend is stateless (the store is an explicit filter) and
        # answers 403 when it gets back Akamai cookies that were never validated
        # by the browser's JS, so it gets a separate session cleared before each call.
        self.search_session = requests.Session(impersonate="chrome")
        self.csrf_token = None
        # Store whose online catalog is used for prices; a physical store without
        # its own e-commerce (e.g. 0113) is served by a nearby one (e.g. 0009).
        self.search_store_id = None

    def _get(self, url, **kwargs):
        return self._request("GET", url, **kwargs)

    def _request(self, method, url, retries=3, session=None, **kwargs):
        session = session or self.session
        for attempt in range(1, retries + 1):
            wait = self._last_request + self.delay - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last_request = time.monotonic()
            if session is self.search_session:
                session.cookies.clear()
            try:
                r = session.request(method, url, timeout=self.timeout, **kwargs)
            except requests.RequestsError as e:
                log.warning("%s %s failed (%s), attempt %d/%d", method, url, e, attempt, retries)
            else:
                if r.status_code < 500 and r.status_code != 429:
                    r.raise_for_status()
                    return r
                log.warning("%s %s -> HTTP %d, attempt %d/%d", method, url, r.status_code, attempt, retries)
            time.sleep(self.delay * attempt)
        raise RuntimeError(f"giving up on {method} {url}")

    def select_store(self):
        home = self._get(SITE + "/").text
        self.csrf_token = re.search(r'data-csrftoken="([^"]+)"', home).group(1)
        r = self._request(
            "POST", SITE + "/pos/select",
            data=json.dumps(self.store_id),
            headers={
                "X-Requested-With": "XMLHttpRequest",
                "Content-Type": "application/json",
                "CSRFToken": self.csrf_token,
            },
        )
        if r.text.strip() != "true":
            raise RuntimeError(f"store selection failed: {r.text[:200]}")
        home = self._get(SITE + "/").text
        m = re.search(r'data-store="%s"[^>]*data-store-addToCart="(\d+)"' % self.store_id, home)
        if not m:
            m = re.search(r'data-search-store="(\d+)"', home)
        self.search_store_id = m.group(1) if m else self.store_id
        log.info("store %s selected, online catalog of store %s", self.store_id, self.search_store_id)

    def nearest_stores(self, latitude: float, longitude: float):
        if self.csrf_token is None:
            home = self._get(SITE + "/").text
            self.csrf_token = re.search(r'data-csrftoken="([^"]+)"', home).group(1)
        r = self._get(
            f"{SITE}/pos/nearestList",
            params={"latitude": latitude, "longitude": longitude},
            headers={"X-Requested-With": "XMLHttpRequest", "CSRFToken": self.csrf_token},
        )
        return r.json()

    def catalog_page(self, page: int, hits_per_page: int = FF_MAX_HITS_PER_PAGE, extra_filters=()):
        """One page of the whole catalog of the selected store, as FACT-Finder JSON.

        Out-of-stock products are included (stockLevelStatus "absent"), so a product
        missing from the catalog has really been removed from the site.
        """
        if self.search_store_id is None:
            self.select_store()
        params = [
            ("hitsPerPage", hits_per_page),
            ("page", page),
            ("filter", f"StoreID:{self.search_store_id}"),
            *[("filter", f) for f in extra_filters],
        ]
        r = self._get(
            FF_NAVIGATION, params=params, session=self.search_session,
            headers={"Accept": "application/json", "Referer": SITE + "/", "Origin": SITE},
        )
        return r.json()

    def fetch_catalog(self):
        """All products of the store, plus the total the search reported at the start."""
        hits, page, page_count, total = [], 1, 1, None
        while page <= page_count:
            data = self.catalog_page(page)
            page_count = data["paging"]["pageCount"]
            total = total or data["totalHits"]
            log.info("catalog page %d/%d (%d hits total)", page, page_count, data["totalHits"])
            hits.extend(data["hits"])
            page += 1
        return hits, total

    def product_page(self, url: str) -> str:
        if self.search_store_id is None:
            self.select_store()
        if url.startswith("/"):
            url = SITE + url
        return self._get(url).text
