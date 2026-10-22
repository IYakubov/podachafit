# Подача FIT — podacha.fit

Find a table tennis opponent, send or accept a challenge, play, report the score, and climb the rating.

One Node.js service serves the app and its API, with data in Postgres. There is no build step: the whole app is `public/index.html`.

## How it works

- **Accounts:** a nickname, a city and a password. No email, phone or real name. At sign-up the player gets a one-time recovery code (`PDCH-XXXX-XXXX`) to reset a forgotten password.
- **Challenges:** open to anyone or sent to a specific player, with a day, time, place and format (to 2 or 3 wins).
- **Contacts:** whoever creates or accepts a challenge enters a Telegram username or phone number. Only the opponent sees it, only after the challenge is accepted, and it is deleted when the match is finished, cancelled or expires.
- **Scores:** one player enters the score and the other confirms it. Ratings change only after confirmation. A score left unconfirmed for 3 days counts as confirmed.
- **Rating:** Elo, everyone starts at 1000, K = 32. Calculated on the server only.
- **Housekeeping:** challenges nobody played are cancelled 3 days after their planned time, and their contacts are wiped.

## Privacy

- Passwords and recovery codes are stored as bcrypt hashes.
- The app does not log IP addresses or request contents.
- The place field rejects phone numbers, links and @handles, so contacts only travel through the contact field.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo →** `podachafit`.
2. In the same project: **+ New → Database → PostgreSQL**.
3. Open the app service → **Variables** and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (reference to the database)
   - `SESSION_SECRET` = a long random string
   - `NODE_ENV` = `production`
4. **Settings → Networking → Generate Domain** to get a public address. Add `podacha.fit` there later as a custom domain.

Tables are created automatically on first start.

## Run locally

```bash
npm install
DATABASE_URL=postgresql://postgres@localhost:5432/podacha SESSION_SECRET=dev node server.js
```

Then open http://localhost:3000.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/me` | Current player or `null` |
| POST | `/api/register` | `{nick, city, pass}` → player + recovery code |
| POST | `/api/login` | `{nick, pass}` |
| POST | `/api/reset` | `{nick, code, pass}` → new recovery code |
| POST | `/api/logout` | |
| GET | `/api/state` | Players, open challenges and my matches |
| POST | `/api/avatar` | `{k, fur}` |
| POST | `/api/challenges` | `{who?, when, place, bo, contact}` |
| POST | `/api/challenges/:id/accept` | `{contact}` |
| POST | `/api/challenges/:id/cancel` | |
| POST | `/api/challenges/:id/score` | `{mine, theirs}` |
| POST | `/api/challenges/:id/confirm` | |
