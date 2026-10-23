# Подача FIT — podacha.fit

Find a table tennis opponent, send or accept a challenge, play, report the score, and climb the rating.

One Node.js service serves the app and its API, with data in Postgres. There is no build step: the whole app is `public/index.html`.

## How it works

- **Accounts:** a nickname, a city and a password. No email, phone or real name. At sign-up the player gets a one-time recovery code (`PDCH-XXXX-XXXX`) to reset a forgotten password.
- **Challenges:** open to anyone or sent to a specific player, with a day, time, place and format (to 2 or 3 wins).
- **Challenge details:** tapping a challenge opens who is calling (nickname, city, rating, record, last 5 results), the full date and time, the venue, the format and who it is for. The caller's contact is not sent to the app until you accept.
- **Contacts:** whoever creates or accepts a challenge enters a Telegram username or phone number. Only the opponent sees it, only after the challenge is accepted, and it is deleted when the match is finished, cancelled or expires.
- **Scores:** one player enters the score. Within 24 hours the opponent can confirm it, correct it (then the first player gets 24 hours to answer the new score) or reject it (the match goes back to «enter score»). If the opponent does nothing for 24 hours, the entered score counts and ratings are updated.
- **Rating:** Elo-based (like German TTR and US USATT), calculated on the server only. Everyone starts at 1000 internally but is shown as "Новичок" until the first confirmed match. The winner gains the full Elo amount and the loser loses half (as in the Russian amateur RTTF rating). K = 48 for a player's first 10 matches, then 32. A convincing win counts more: 3:0 ×1.2, 3:1 ×1.07, 3:2 ×0.93.
- **Notifications:** in-app notifications (bell with a counter) when someone challenges you, accepts or declines your challenge, cancels a match, enters a score, or confirms it. Optional browser notifications while the site is open in a tab.
- **Telegram alerts (optional):** with `TELEGRAM_BOT_TOKEN` set, players can connect Telegram in their profile. The bot sends new open challenges in the player's city and news about their own matches; each can be switched off, and `/stop` disconnects. Only the numeric chat id is stored.
- **Telegram Mini App:** the bot's menu button «Играть» opens the app inside Telegram. The server verifies Telegram's signed `initData` with the bot token and signs the player in automatically once their Telegram is linked; the first time, they log in or register and the account is linked. Back button, haptics and Telegram colours are used inside Telegram; normal visitors never load Telegram's script.
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
   - `TELEGRAM_BOT_TOKEN` = token from @BotFather (optional, enables Telegram alerts)
   - `APP_URL` = public address, e.g. `https://www.podacha.fit` (used for the bot webhook and links)
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
| POST | `/api/challenges/:id/reject` | opponent rejects the reported score |
| GET | `/api/players/:id` | public player card: record, last 5 results, rank (no contacts) |
