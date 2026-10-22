# Bennet price tracker

Scarica ogni giorno prezzi, promozioni e schede prodotto del catalogo online Bennet
per un punto vendita e li salva in un database SQLite: in locale un file (`bennet.db`),
in produzione un database [Turso](https://turso.tech) aggiornato ogni notte da GitHub Actions.
Lo storico è consultabile sul sito <https://shargus.github.io/bennet-scraper/>.

**Punto vendita:** Bennet di **Torino, via Giordano Bruno 142** (codice `0113`, il default di
`--store`). Questo negozio non ha un e-commerce proprio: il sito Bennet gli associa il catalogo
online di Torino San Paolo (`0009`), quindi i prezzi raccolti sono quelli online e quelli a
scaffale in via Giordano Bruno possono essere diversi.

## Uso

```sh
uv sync
uv run python main.py daily                    # prezzi + date promo + fino a 500 schede da scaricare
uv run python main.py daily --details-minutes 60  # ... con al massimo 60 minuti di schede
uv run python main.py prices                   # solo prezzi e date promo
uv run python main.py details --limit 2000     # solo schede dei prodotti nuovi o rinominati
uv run python main.py export ultimi_prezzi.csv # vista latest_prices in CSV
uv run python main.py stores 45.0375 7.6590    # punti vendita vicini a una posizione
uv run python main.py upload                   # copia bennet.db su Turso
uv run python main.py site                     # costruisce il sito statico in _site/
```

Se sono impostate le variabili `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` (anche in un file
`.env`, escluso da git), tutti i comandi usano Turso invece del file locale.

Opzioni globali: `--store` (default `0113`, Torino via Giordano Bruno), `--db`,
`--delay` (secondi tra due richieste, default 10 come chiede il `robots.txt`).

## Come funziona il sito

- `www.bennet.com` è SAP Commerce dietro Akamai: un client HTTP normale riceve 403,
  per questo si usa `curl_cffi`, che imita l'impronta TLS di Chrome.
- Il punto vendita si sceglie con `POST /pos/select` (body: `"0113"`, header `CSRFToken`
  preso dall'attributo `data-csrftoken` della home). Il negozio 0113 non ha un
  e-commerce proprio: ricerca e prezzi online usano il catalogo del **0009 (Torino San Paolo)**.
  I prezzi a scaffale in via Giordano Bruno potrebbero quindi differire.
- L'elenco prodotti arriva da FACT-Finder:
  `https://search-prod.bennet.com/fact-finder/rest/v5/navigation/Bennet_PROD?filter=StoreID:0009&hitsPerPage=200&page=N`.
  Circa 20.000 prodotti in circa 100 richieste, compresi quelli esauriti (`stockLevelStatus` `absent`), con prezzo, prezzo barrato, prezzo al kg/l,
  tipo e percentuale di sconto, EAN, marca, categorie e caratteristiche.
  Questo host risponde 403 se riceve i cookie Akamai di www.bennet.com, quindi usa una sessione separata.
- Le offerte di un giorno ("Prezzo Eccezionale il 7/10") nel catalogo hanno solo l'etichetta
  `marketingLabel`: prezzo pieno e `hasPromotion` falso. Il prezzo scontato è solo nella pagina
  prodotto, che il run giornaliero legge una volta per offerta; nello storico prezzi queste
  offerte hanno `promo_type` `PrezzoEccezionale`.
- Le **date delle promozioni** e i dati statici (ingredienti, allergeni, valori nutrizionali,
  conservazione, produttore, foto 1000×1000) sono solo nella pagina prodotto. Le date sono
  uguali per tutti i prodotti con lo stesso codice promo, quindi basta una pagina per codice.

## Tempi (con 10 s tra le richieste)

| Job | Richieste | Durata |
| --- | --- | --- |
| Prezzi di tutto il catalogo | ~100 | ~17 min |
| Date promo (una pagina per codice nuovo) | qualche decina | ~5–20 min |
| Schede prodotto, prima volta | ~20.000 | ~55 h, da distribuire su più giorni con `--limit` |
| Schede prodotto, a regime | solo prodotti nuovi o rinominati | pochi minuti al giorno |

Il `robots.txt` chiede anche di visitare il sito tra le 04:00 e le 08:45 UTC.

## Tabelle

- `products`: una riga per prodotto (anagrafica e scheda). I bundle (mix di più
  prodotti, ID `B_...`) sono esclusi.
- `products`: `first_seen` è il primo run che l'ha trovato, `removed_on` il primo run che
  non l'ha più trovato nel catalogo (vuoto se c'è). Un prodotto che sparisce resta nel database
  con il suo storico prezzi; se ricompare, `removed_on` torna vuoto e si apre un nuovo periodo
  di prezzo. Molti prodotti spariscono per qualche giorno e poi tornano.
  La scheda si scarica una volta sola e si riscarica solo se il prodotto cambia nome
  (`details_fetched_at` vuoto = scheda da scaricare). I prodotti esauriti o fuori catalogo non
  hanno una pagina (il sito risponde 404): la loro scheda si scarica quando tornano.
- `prices`: storico prezzi a periodi. Una riga per ogni periodo in cui prezzo, promo e
  disponibilità non cambiano. Il periodo corrente ha `valid_to` vuoto; quando qualcosa
  cambia viene chiuso con la data dell'ultimo run che l'ha visto e se ne apre uno nuovo.
  Un giorno senza cambi non scrive nulla. Prezzo di un prodotto in una data:
  `SELECT * FROM prices WHERE product_id = ? AND ? BETWEEN valid_from AND COALESCE(valid_to, '9999-12-31')`.
- `promotions`: date di inizio e fine per ogni codice promo.
- `runs`: un run completato per giorno, con quanti prodotti, cambi, novità e rimozioni.
- `latest_prices` (vista): prezzi correnti uniti all'anagrafica.

Il run giornaliero scarica prima l'intero catalogo e scrive solo se è completo (almeno il
98% del totale dichiarato dal sito): un run interrotto non lascia dati a metà e non cancella prodotti.

## Produzione: Turso + GitHub Actions

Il workflow `.github/workflows/daily.yml` esegue `daily` ogni giorno alle 04:15 UTC, avviato da
un servizio di cron esterno ([cron-job.org](https://cron-job.org)) con una chiamata all'API di
GitHub; si può avviare anche a mano da *Actions → Daily scrape → Run workflow*. Il workflow non ha
un cron proprio: GitHub avvia i workflow pianificati con ore di ritardo, fuori dalla finestra
04:00–08:45 UTC chiesta dal `robots.txt`. Se il cron esterno smette di funzionare (per esempio
alla scadenza del token), lo scraping si ferma finché non viene sistemato.

Configurazione del cron esterno:

1. Su GitHub crea un *fine-grained personal access token* (*Settings → Developer settings*)
   limitato a questo repository, con il solo permesso *Actions: Read and write*.
2. Su cron-job.org crea un job giornaliero alle 04:15, fuso orario UTC, con richiesta
   `POST https://api.github.com/repos/Shargus/bennet-scraper/actions/workflows/daily.yml/dispatches`,
   header `Accept: application/vnd.github+json`, `Authorization: Bearer <token>`,
   `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json` e body `{"ref": "main"}`.
   GitHub risponde `204` quando avvia il workflow.
3. Alla scadenza del token, creane uno nuovo e aggiorna l'header del job.

Database e secret:

1. Su [turso.tech](https://turso.tech) crea un database (regione europea) e un token.
2. Nel repository GitHub, *Settings → Secrets and variables → Actions*: aggiungi i secret
   `TURSO_DATABASE_URL` (`libsql://...`) e `TURSO_AUTH_TOKEN`.
3. Variabili di repository opzionali (scheda *Variables*):
   - `DETAILS_MINUTES`: minuti dedicati alle schede prodotto (default 180). Con un repository
     privato i minuti gratuiti di Actions sono limitati: tienila bassa (~30).
   - `DELAY`: secondi tra due richieste (default 10, come chiede il `robots.txt`).

   Avviando il workflow a mano si possono sovrascrivere entrambe solo per quel run.
4. Per caricare i dati già scaricati in locale: `uv run python main.py upload`.

## Sito con lo storico prezzi

`site/` contiene un sito statico (HTML, CSS e JavaScript, senza build) che mostra il catalogo
diviso per categoria e sottocategoria, con ricerca, filtri e paginazione. Di default mostra solo
i prodotti in catalogo; un filtro permette di includere anche quelli non più in catalogo, con
l'ultimo prezzo rilevato e i giorni fuori catalogo nel grafico. La pagina di ogni
prodotto mostra il grafico dell'andamento del prezzo (stile Keepa: prezzo pagato, prezzo pieno,
promozioni, periodi non acquistabili), lo storico dei periodi e la scheda prodotto.

`main.py site` legge il database e scrive in `_site/` i file del sito più i dati:
`data/catalog.json` (una riga per prodotto) e `data/p/<id>.json` (storico e scheda di un
prodotto). Per provarlo in locale:

```sh
uv run python main.py site && python -m http.server -d _site 8000
```

Il workflow `.github/workflows/site.yml` ricostruisce il sito dopo ogni run riuscito di
*Daily scrape* (e quando cambia il codice del sito) e lo pubblica su GitHub Pages. Va abilitato
una volta da *Settings → Pages → Source: GitHub Actions*; con un account gratuito GitHub Pages
richiede un repository pubblico.

Nel catalogo il flag `privateLabel` è invertito: vale falso per i marchi Bennet (BENNET,
BENNET BIO, SELEZIONE GOURMET BENNET...) e vero per tutti gli altri. Il sito ne tiene conto.
