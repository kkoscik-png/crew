# Crew Rotation Schedule — Stena Scandica

A Cloudflare Workers app that:

- reads data from the **Planning** sheet of an Excel file (who works on board, and when),
- lets you pick your name from a dropdown and shows whether you're currently on the ship or at home, when your next rotation is, and a list of every upcoming rotation until the end of the year, plus a 3-month calendar with a green/red bar under each day showing which port the ship is in,
- reads the ship's PDF timetable (Stena Line SNV format) and shows a full "Ship timetable" page (`/timetable`) projecting the port schedule forward to the end of the year,
- has an admin panel (`/admin`, password-protected) for uploading a new Excel file and/or a new timetable PDF — once uploaded, everything recalculates and saves automatically.

The initial data (from the files you sent me) is already baked into `public/seed.json` and `public/timetable-seed.json`, so the app works right after deployment, even before you upload anything through the admin panel.

## How it's built

- `src/worker.js` — the Cloudflare Worker: serves `/api/schedule`, `/api/timetable` (public data), `/api/admin/login`, `/api/admin/upload`, `/api/admin/upload-timetable`, `/api/admin/status`.
- `src/parse.js` — logic for reading the "Planning" sheet and computing on-board periods.
- `src/timetable.js` — logic for reading the PDF timetable (by text position, not reading order — see below) and building a repeating port-call cycle.
- `public/index.html` — the main page with the dropdown and 3-month calendar.
- `public/timetable.html` — the "Ship timetable" page.
- `public/admin.html` — the admin panel (password login + Excel/PDF upload).
- `public/seed.json` / `public/timetable-seed.json` — data generated from your original files (used as the starting point).

### How "on board" / "at home" is determined

In the Planning sheet, every day has a code (per the legend in columns B/C of the sheet):
`M, C, 2, 3, S, B, A, O, SC, X` = the person is actually working on board that day.
A blank cell, `T` (Travel Day), `LA`, `P`, `L`, `V`, `CT` = the person is not on the ship (home / leave / training / sick leave / travel).

Consecutive days with a working code are grouped into a "rotation" (interval). If today falls inside such an interval, the person is "on board", and the day they go home is the **last marked working day itself** (not the day after). If today falls outside any interval, the app shows the next upcoming rotation (boarding date and the date they go home again), plus a table of every later rotation until the end of the year.

If you ever want to change this logic (e.g. treat "T" differently), the `ONBOARD_CODES` set in `src/parse.js` is the single place that decides it.

### How the ship timetable is read from the PDF

The Stena Line SNV timetable PDF lists **two ships** (Stena Scandica and Stena Baltica) side by side, alternating week to week. `src/timetable.js` reads the PDF's text by its on-page x/y position (not reading order, which interleaves the two ships) to reconstruct the table, then keeps only the **Stena Scandica** columns for both ports. It detects the cycle length automatically (currently 14 days: an odd week + an even week) by finding where the pattern repeats, and reads the start date from the "timetable from ..." line — so it isn't hardcoded to this specific PDF's dates or cycle length, only to the general Stena Line table layout (ship name headers above "Arrival / Depart." column pairs, two port blocks side by side). This was verified to match, day-for-day, a version of this same schedule that had been manually cross-checked against the official PDF.

Once the cycle is known, any date's port schedule is found by projecting it onto the cycle (`date − start, mod cycle length`) — this is what both `/timetable` and the port bar in the crew calendar use, so a date far in the future (or slightly before the PDF's stated start) still gets a plausible answer.

If a future timetable ever covers a **different ship** than Stena Scandica, or the PDF layout changes significantly, `src/timetable.js` is the only file that needs updating — the default ship name it looks for is set where `parseTimetableItems` is called in `src/worker.js` (and in `scripts/generate-timetable-seed.mjs`).

## Requirements

- A Cloudflare account (you have one).
- Node.js 18+ and npm on your computer (to deploy locally with `wrangler`).

## Step-by-step deployment

Run all commands in a terminal, inside this project's folder (where `wrangler.toml` lives).

### 1. Install dependencies

```bash
npm install
```

### 2. Log Wrangler into your Cloudflare account

Easiest via the browser:

```bash
npx wrangler login
```

A browser window will open asking you to log in and approve — confirm it.

*(Alternatively, if you'd rather use an API token instead of browser login, you can `export CLOUDFLARE_API_TOKEN=your_token` in the same terminal before the next steps — then `wrangler login` isn't needed. If you used a token pasted earlier in this conversation, **make sure to revoke it / generate a new one** afterwards in the Cloudflare Dashboard → My Profile → API Tokens, since a token shared in chat shouldn't be kept in permanent use.)*

The account (`account_id`) is already set in `wrangler.toml`.

### 3. Create a KV namespace (to store the uploaded schedule)

```bash
npx wrangler kv namespace create SCHEDULE_KV
```

This prints something like:

```
[[kv_namespaces]]
binding = "SCHEDULE_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Copy the `id` value and paste it into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

### 4. Set the admin password and session secret

```bash
npx wrangler secret put ADMIN_PASSWORD
```

You'll be prompted to type a password — this is what you'll use to log into `/admin`.

```bash
npx wrangler secret put SESSION_SECRET
```

Enter any long random string here (e.g. generated with the command below) — this is used internally to sign sessions, you don't need to remember it:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5. Deploy

```bash
npx wrangler deploy
```

After a moment you'll get a URL like `https://crew-schedule.<your-subdomain>.workers.dev` — that's your live app. The admin panel is at `https://.../admin`.

### 6. (Optional) Custom domain

If you'd like to use your own domain (e.g. `crew.yourcompany.com`) instead of the `workers.dev` address, in the Cloudflare Dashboard go to **Workers & Pages → crew-schedule → Settings → Domains & Routes → Add** and follow the prompts (the domain must already be on Cloudflare).

## Updating the schedule

Go to `/admin`, log in with the password from step 4, and upload a new `.xlsx`/`.xlsm` file (it must have a "Planning" sheet laid out the same way as the original). The data updates instantly for everyone visiting the main page.

## Updating the app's code later

If you ever want to change something in the code (`src/`, `public/`), just run this again after making changes:

```bash
npx wrangler deploy
```

## Local testing before deploying (optional)

```bash
npx wrangler dev
```

This starts a local server (default `http://localhost:8787`) with a full simulation of the Worker — you can test the page and admin panel before deploying to production. For local testing of the admin panel, create a `.dev.vars` file (not deployed to Cloudflare) containing:

```
ADMIN_PASSWORD=your-test-password
SESSION_SECRET=anything-long
```
