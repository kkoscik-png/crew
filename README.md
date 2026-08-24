# Harmonogram podmian załogi — Stena Scandica

Aplikacja na Cloudflare Workers, która:

- czyta dane z zakładki **Planning** pliku Excel (kto, od kiedy pracuje na statku),
- pozwala wybrać z listy rozwijanej imię i nazwisko i pokazuje: czy dana osoba jest teraz na statku czy w domu, kiedy ma najbliższą podmianę, oraz listę kolejnych podmian do końca roku,
- ma panel administratora (`/admin`, chroniony hasłem) do wgrywania nowego pliku Excel — po wgraniu dane są automatycznie przeliczane i zapisywane.

Dane początkowe (z pliku, który mi wysłałeś) są już wbudowane w `public/seed.json`, więc aplikacja działa od razu po wdrożeniu, zanim jeszcze wgrasz cokolwiek przez panel admina.

## Jak to jest zbudowane

- `src/worker.js` — Cloudflare Worker: udostępnia `/api/schedule` (dane publiczne), `/api/admin/login`, `/api/admin/upload`, `/api/admin/status`.
- `src/parse.js` — logika czytania zakładki „Planning” i liczenia okresów pracy na statku.
- `public/index.html` — strona główna z listą rozwijaną.
- `public/admin.html` — panel admina (logowanie hasłem + upload Excela).
- `public/seed.json` — dane wygenerowane z Twojego pliku (na start).

### Jak rozpoznawane jest „na statku” / „w domu”

W zakładce Planning każdy dzień ma kod (wg legendy w kolumnach B/C arkusza):
`M, C, 2, 3, S, B, A, O, SC, X` = osoba faktycznie pracuje na statku tego dnia.
Puste pole, `T` (Travel Day), `LA`, `P`, `L`, `V`, `CT` = osoba nie jest na statku (dom / urlop / szkolenie / zwolnienie / podróż).

Kolejne dni z kodem pracy są grupowane w „turę” (interval). Jeśli dziś mieścisz się w takiej turze — jesteś „na statku”, a data zejścia do domu to dzień po ostatnim dniu pracy. Jeśli nie — pokazywana jest najbliższa nadchodząca tura (data wejścia i data zejścia po niej), a pod spodem lista wszystkich kolejnych tur do końca roku.

Jeśli chcesz zmienić tę logikę (np. inaczej traktować dzień „T”), zmień zbiór `ONBOARD_CODES` w `src/parse.js` — to jedyne miejsce, które o tym decyduje.

## Wymagania

- Konto Cloudflare (masz).
- Node.js 18+ i npm na Twoim komputerze (do wdrożenia lokalnie przez `wrangler`).

## Wdrożenie krok po kroku

Wszystkie polecenia wpisujesz w terminalu, w folderze tego projektu (tam gdzie jest `wrangler.toml`).

### 1. Instalacja zależności

```bash
npm install
```

### 2. Zaloguj Wranglera do swojego konta Cloudflare

Najprościej przez przeglądarkę:

```bash
npx wrangler login
```

Otworzy się przeglądarka z prośbą o zalogowanie i zgodę — potwierdź.

*(Alternatywnie, jeśli wolisz użyć tokena API zamiast logowania przez przeglądarkę, możesz w tym samym terminalu ustawić `export CLOUDFLARE_API_TOKEN=twój_token` przed kolejnymi krokami — wtedy `wrangler login` nie jest potrzebny. Jeśli używałeś tokena wklejonego wcześniej w tej rozmowie, **koniecznie go potem usuń/wygeneruj nowy** w Cloudflare Dashboard → My Profile → API Tokens, bo token wklejony na czacie nie powinien zostać użyty na stałe.)*

Konto (`account_id`) jest już wpisane w `wrangler.toml`.

### 3. Utwórz magazyn KV (do przechowywania wgranego harmonogramu)

```bash
npx wrangler kv namespace create SCHEDULE_KV
```

Polecenie wypisze coś w stylu:

```
[[kv_namespaces]]
binding = "SCHEDULE_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Skopiuj wartość `id` i wklej ją w pliku `wrangler.toml`, zastępując `REPLACE_WITH_KV_NAMESPACE_ID`.

### 4. Ustaw hasło administratora i sekret sesji

```bash
npx wrangler secret put ADMIN_PASSWORD
```

Poda się o wpisanie hasła — wpisz hasło, którym będziesz logować się do `/admin`.

```bash
npx wrangler secret put SESSION_SECRET
```

Tu wpisz dowolny długi losowy ciąg znaków (np. wygenerowany poleceniem poniżej) — to sekret używany wewnętrznie do podpisywania sesji, nie musisz go zapamiętywać:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5. Wdróż aplikację

```bash
npx wrangler deploy
```

Po chwili dostaniesz adres w stylu `https://crew-schedule.<twoja-subdomena>.workers.dev` — to jest gotowa aplikacja. Panel admina jest pod `https://.../admin`.

### 6. (Opcjonalnie) własna domena

Jeśli chcesz podpiąć własną domenę (np. `zaloga.twojafirma.pl`) zamiast adresu `workers.dev`, w Cloudflare Dashboard wejdź w **Workers & Pages → crew-schedule → Settings → Domains & Routes → Add** i postępuj zgodnie z instrukcją (domena musi być podpięta pod Cloudflare).

## Aktualizacja harmonogramu

Wejdź na `/admin`, zaloguj się hasłem ustawionym w kroku 4, i wgraj nowy plik `.xlsx`/`.xlsm` (musi mieć zakładkę „Planning” w tym samym układzie co oryginał). Dane zaktualizują się natychmiast dla wszystkich użytkowników strony głównej.

## Aktualizacja kodu aplikacji w przyszłości

Jeśli kiedyś zechcesz coś zmienić w kodzie (`src/`, `public/`), wystarczy po zmianach ponownie uruchomić:

```bash
npx wrangler deploy
```

## Test lokalny przed wdrożeniem (opcjonalnie)

```bash
npx wrangler dev
```

Otworzy lokalny serwer (domyślnie `http://localhost:8787`) z pełną symulacją Workera — możesz przetestować stronę i panel admina zanim wdrożysz na produkcję. Do testu lokalnego panelu admina utwórz plik `.dev.vars` (nie jest wgrywany na Cloudflare) z zawartością:

```
ADMIN_PASSWORD=twoje-haslo-testowe
SESSION_SECRET=cokolwiek-dlugiego
```
