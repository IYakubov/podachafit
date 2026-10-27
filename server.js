'use strict';
/*
 * podacha.fit — table tennis challenges & ratings
 * One Node service: serves the app (public/) and the JSON API, stores data in Postgres.
 *
 * Privacy by design:
 *  - accounts are nickname + password only (no email, phone or real name)
 *  - passwords and recovery codes are stored as bcrypt hashes
 *  - an opponent's contact (Telegram / phone) is visible only to the two players of a
 *    booked match and is wiped when the match is finished, cancelled or expires
 *  - the app does not log IP addresses or request bodies
 *  - Telegram alerts are opt-in: only the numeric chat id is stored, and /stop or
 *    "Отключить" deletes it
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is not set. Add a Postgres database and reference its DATABASE_URL.'); process.exit(1); }
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); console.warn('SESSION_SECRET is not set: using a temporary one, everyone will be logged out on restart.'); }

const local = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: local || /railway\.internal/.test(DATABASE_URL) ? false : { rejectUnauthorized: false } });
const q = (text, params) => pool.query(text, params);

/* ---------------- rules shared with the app ---------------- */
const CITIES = ['Ташкент','Самарканд','Бухара','Андижан','Наманган','Фергана','Нукус','Карши','Коканд','Термез','Джизак','Ургенч','Навои','Гулистан'];
const KINDS = ['wolf','fox','tiger','lion','bear','panda','eagle','panther','bull','raccoon','owl','boar'];
const FURS = ['#E0742E','#D8A63C','#B84A3E','#C76A9A','#7A5CC9','#3D78C9','#2E9C8E','#5C9E48','#3A3D46'];
// nicknames: 3–16 characters, at least one letter; letters, digits and common symbols in any order
const NICK_LETTER = /[A-Za-zА-Яа-яЁё]/;
const NICK_OK = /^[A-Za-zА-Яа-яЁё0-9_.\-+!#$%&*=~^?()\[\]]+$/;
function nickError(n){
  n = String(n || '');
  if (n.length < 3) return 'Никнейм: минимум 3 символа';
  if (n.length > 16) return 'Никнейм: не больше 16 символов';
  if (!NICK_OK.test(n)) {
    const bad = [...n].find(ch => !NICK_OK.test(ch));
    return bad === ' ' ? 'В никнейме не должно быть пробелов' : `Символ «${bad}» нельзя использовать в никнейме`;
  }
  if (!NICK_LETTER.test(n)) return 'Никнейм должен содержать хотя бы одну букву';
  return null;
}
const RESERVED = ['admin','administrator','rally','podacha','podachafit','support','moderator','админ','модератор','поддержка'];
const need = bo => Math.floor(bo / 2) + 1;
const okScore = (bo, a, b) => { const n = need(bo); return (a === n && b >= 0 && b < n) || (b === n && a >= 0 && a < n); };
/*
 * Rating change (Elo-based, like German TTR / US USATT, with the RTTF habit that the loser
 * loses half of what a full Elo exchange would take):
 *  - expected score from the rating gap (400-point logistic, as in chess)
 *  - K = 48 for a player's first 10 matches (rating settles fast), then 32
 *  - a convincing win counts a little more: 3:0 ×1.2, 3:1 ×1.07, 3:2 ×0.93 (2:0 ×1.2, 2:1 ×1.0)
 *  - the winner gains the full amount, the loser loses half
 */
const kFor = played => played < 10 ? 48 : 32;
function ratingChange(w, l, gw, gl, bo){
  const ew = 1 / (1 + Math.pow(10, (l.rating - w.rating) / 400));
  const mult = 0.8 + 0.4 * ((gw - gl) / need(bo));
  const gain = Math.max(1, Math.round(kFor(w.wins + w.losses) * (1 - ew) * mult));
  const loss = Math.max(1, Math.round(kFor(l.wins + l.losses) * (1 - ew) * mult / 2));
  return { gain, loss };
}
const hasContactInText = t => /(https?:|www\.|t\.me|@[A-Za-z0-9_]{3,}|\d[\d\s\-()]{5,}\d)/i.test(t);
function normContact(type, v){
  v = String(v || '').trim();
  if (type === 'tg'){ v = v.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, ''); return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v) ? '@' + v : null; }
  let d = v.replace(/\D/g, ''); if (d.length === 9) d = '998' + d;
  return d.length >= 11 && d.length <= 15 ? '+' + d : null;
}
function newCode(){ const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const g = () => Array.from(crypto.randomBytes(4), b => a[b % a.length]).join(''); return `PDCH-${g()}-${g()}`; }

/* ---------------- schema (created automatically on start) ---------------- */
async function migrate(){
  await q(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nick text NOT NULL,
      nick_lower text NOT NULL UNIQUE,
      pass_hash text NOT NULL,
      code_hash text NOT NULL,
      city text NOT NULL,
      ava_kind text NOT NULL DEFAULT 'wolf',
      ava_fur text,
      rating int NOT NULL DEFAULT 1000,
      wins int NOT NULL DEFAULT 0,
      losses int NOT NULL DEFAULT 0,
      session_ver int NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS matches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      a uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      b uuid REFERENCES users(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('open','invite','booked','check','done','cancelled')),
      bo int NOT NULL CHECK (bo IN (3,5)),
      when_at timestamptz NOT NULL,
      place text NOT NULL,
      ca text, cb text,
      sa int, sb int,
      reported_by uuid,
      winner uuid,
      delta int,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS matches_status_idx ON matches(status);
    CREATE INDEX IF NOT EXISTS matches_a_idx ON matches(a);
    CREATE INDEX IF NOT EXISTS matches_b_idx ON matches(b);
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS delta_l int;
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS reported_at timestamptz;
    CREATE TABLE IF NOT EXISTS notifications (
      id bigserial PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind text NOT NULL,
      match_id uuid REFERENCES matches(id) ON DELETE CASCADE,
      actor uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_chat bigint;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_city boolean NOT NULL DEFAULT true;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_mine boolean NOT NULL DEFAULT true;
    CREATE INDEX IF NOT EXISTS users_tg_city_idx ON users(city) WHERE tg_chat IS NOT NULL;
    CREATE TABLE IF NOT EXISTS tg_links (
      code text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL
    );
  `);
}

/* ---------------- in-app notifications ---------------- */
/* a reported score counts automatically if the opponent does not confirm, correct or reject it within a day */
const SCORE_WAIT_MS = 24 * 3600e3;
async function notify(db, userId, kind, matchId, actor){
  if (!userId || userId === actor) return;
  await db.query('INSERT INTO notifications (user_id, kind, match_id, actor) VALUES ($1,$2,$3,$4)', [userId, kind, matchId, actor || null]);
  tgLater(() => tgPersonal(userId, kind, matchId, actor));
}

/* ---------------- Telegram bot (optional: active when TELEGRAM_BOT_TOKEN is set) ---------------- */
const TG = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_HOOK = crypto.createHash('sha256').update('tg:' + SECRET).digest('hex').slice(0, 32);
const APP_URL = (process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'http://localhost:' + PORT)).replace(/\/$/, '');
let BOT_NAME = '';
const h = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
async function tgCall(method, body){
  if (!TG) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { console.error('telegram:', method, e.message); return null; }
}
async function tgSend(chat, html, button){
  // the button opens the app right inside Telegram (Mini App) when the address is https
  const btn = button ? (/^https:/.test(APP_URL) ? { text: button, web_app: { url: APP_URL } } : { text: button, url: APP_URL }) : null;
  const r = await tgCall('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: btn ? { inline_keyboard: [[btn]] } : undefined });
  // the player blocked the bot or deleted the chat: stop messaging them
  if (r && !r.ok && (r.error_code === 403 || /chat not found/i.test(r.description || ''))) await q('UPDATE users SET tg_chat=NULL WHERE tg_chat=$1', [chat]);
  return r;
}
const tgQueue = [];
let tgBusy = false;
function tgLater(job){ if (!TG) return; tgQueue.push(job); if (!tgBusy) setTimeout(tgDrain, 400); }
async function tgDrain(){
  tgBusy = true;
  while (tgQueue.length){ try { await tgQueue.shift()(); } catch (e) { console.error('telegram job:', e.message); } await new Promise(r => setTimeout(r, 40)); }
  tgBusy = false;
}
const whenRu = t => new Date(t).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const rateRu = u => u.wins + u.losses > 0 ? `рейтинг ${u.rating}` : 'новичок';
async function tgPersonal(userId, kind, matchId, actorId){
  const u = (await q('SELECT tg_chat, tg_mine FROM users WHERE id=$1', [userId])).rows[0];
  if (!u || !u.tg_chat || !u.tg_mine) return;
  const m = matchId ? (await q('SELECT * FROM matches WHERE id=$1', [matchId])).rows[0] : null;
  const a = actorId ? (await q('SELECT nick, rating, wins, losses FROM users WHERE id=$1', [actorId])).rows[0] : null;
  const who = a ? `<b>${h(a.nick)}</b>` : '';
  const sc = m && m.sa != null ? (m.a === userId ? `${m.sa}:${m.sb}` : `${m.sb}:${m.sa}`) : '';
  const txt = {
    invite: m && `🏓 ${who} (${rateRu(a)}) бросает вам вызов\n${h(whenRu(m.when_at))} · ${h(m.place)} · до ${need(m.bo)} побед`,
    accepted: m && `✅ ${who} принял(а) ваш вызов\n${h(whenRu(m.when_at))} · ${h(m.place)}\nКонтакт соперника — в приложении.`,
    declined: `❌ ${who} отклонил(а) ваш вызов`,
    cancelled: m && `❌ ${who} отменил(а) матч ${h(whenRu(m.when_at))}`,
    score: m && `📝 ${who} внёс счёт <b>${sc}</b>.\nПодтвердите, исправьте или отклоните его в приложении. Если не ответить за сутки, счёт засчитается автоматически.`,
    corrected: m && `✏️ ${who} исправил(а) счёт на <b>${sc}</b>.\nПодтвердите, исправьте или отклоните. Через сутки без ответа этот счёт засчитается.`,
    rejected: m && `↩️ ${who} отклонил(а) счёт. Внесите правильный счёт в приложении.`,
    confirmed: m && (m.winner === userId ? `🏆 ${who} подтвердил(а) счёт ${sc}. Победа! <b>+${m.delta}</b> к рейтингу` : `${who} подтвердил(а) счёт ${sc}. <b>−${m.delta_l ?? m.delta}</b> к рейтингу`),
    auto: m && `Счёт ${sc} засчитан автоматически: соперник не ответил за сутки.`
  }[kind];
  if (txt) await tgSend(u.tg_chat, txt, 'Открыть Подачу');
}
async function tgCityAlert(matchId){
  const m = (await q(`SELECT m.*, u.nick, u.city, u.rating, u.wins, u.losses FROM matches m JOIN users u ON u.id=m.a WHERE m.id=$1`, [matchId])).rows[0];
  if (!m || m.status !== 'open') return;
  const people = (await q(`SELECT tg_chat FROM users WHERE city=$1 AND tg_chat IS NOT NULL AND tg_city AND id<>$2`, [m.city, m.a])).rows;
  const txt = `🏓 Новый вызов в городе ${h(m.city)}\n<b>${h(m.nick)}</b> (${rateRu(m)}) ищет соперника\n${h(whenRu(m.when_at))} · ${h(m.place)} · до ${need(m.bo)} побед`;
  for (const p of people){ tgLater(() => tgSend(p.tg_chat, txt, 'Принять вызов')); }
}
async function tgSetup(){
  if (!TG) { console.log('Telegram: TELEGRAM_BOT_TOKEN not set, bot disabled'); return; }
  const me = await tgCall('getMe', {});
  if (!me || !me.ok) { console.error('Telegram: token rejected'); return; }
  BOT_NAME = me.result.username;
  if (/^https:/.test(APP_URL)){
    const r = await tgCall('setWebhook', { url: `${APP_URL}/tg/${TG_HOOK}`, secret_token: TG_HOOK, allowed_updates: ['message'], drop_pending_updates: true });
    console.log('Telegram: @' + BOT_NAME + (r && r.ok ? ' ready' : ' webhook failed: ' + (r && r.description)));
  } else console.log('Telegram: @' + BOT_NAME + ' (no https APP_URL, webhook not set)');
  await tgCall('setMyCommands', { commands: [{ command: 'start', description: 'Открыть Подачу' }, { command: 'stop', description: 'Отключить уведомления' }] });
  if (/^https:/.test(APP_URL)) await tgCall('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: APP_URL } } });
  await tgCall('setMyShortDescription', { short_description: 'Найди соперника по настольному теннису 🏓 Вызовы, матчи и рейтинг — прямо в Telegram. Жми «Играть»' });
  await tgCall('setMyDescription', { description: '🏓 Подача FIT — соперник по настольному теннису прямо в Telegram.\n\nНажмите «Играть» внизу чата:\n• бросьте вызов любому игроку в городе или кому-то лично\n• примите чужой вызов — вы обменяетесь контактами\n• после игры внесите счёт — соперник подтвердит\n• поднимайтесь в рейтинге\n\nЯ пришлю новые вызовы в вашем городе, принятые матчи и счета на подтверждение.\n\nНужны только никнейм и город — без имени и телефона. Бесплатно.' });
}

/* ---------------- sessions: signed cookie, no session table ---------------- */
const COOKIE = 'pf_s';
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeToken(uid, ver){ const exp = Date.now() + 1000 * 60 * 60 * 24 * 60; const v = `${uid}.${ver}.${exp}`; return `${v}.${sign(v)}`; }
function readToken(t){
  if (!t) return null; const parts = t.split('.'); if (parts.length !== 4) return null;
  const v = parts.slice(0, 3).join('.'), sig = parts[3], good = sign(v);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (+parts[2] < Date.now()) return null;
  return { uid: parts[0], ver: +parts[1] };
}
function cookieOf(req){ const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`)); return m ? decodeURIComponent(m[1]) : null; }
function setSession(res, uid, ver){
  const tok = makeToken(uid, ver);
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  // inside Telegram (Desktop/Web run the app in a frame, where cookies are blocked) the page keeps the session in memory
  if (res.req && res.req.get('X-Pf-Tg') === '1') res.setHeader('X-Pf-Session', tok);
}
function clearSession(res){ res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }

/* ---------------- brute-force guard (per nickname, no IPs stored) ---------------- */
const fails = new Map();
function tooMany(key){ const f = fails.get(key); return f && f.n >= 8 && Date.now() - f.t < 15 * 60e3; }
function failed(key){ const f = fails.get(key); if (!f || Date.now() - f.t > 15 * 60e3) fails.set(key, { n: 1, t: Date.now() }); else f.n++; }

/* ---------------- app ---------------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
// one address for everyone: podacha.fit → https://www.podacha.fit
const CANON = process.env.CANONICAL_HOST || '';
app.use((req, res, next) => {
  if (CANON && req.hostname && req.hostname !== CANON && req.hostname.replace(/^www\./, '') === CANON.replace(/^www\./, '') && req.method === 'GET')
    return res.redirect(301, `https://${CANON}${req.originalUrl}`);
  next();
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // only Telegram may show the site inside a frame (Mini App on Telegram Desktop / Web)
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
  // API answers are personal and change all the time: never let a browser or Telegram's webview reuse an old one
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  if (e.status) return res.status(e.status).json({ error: e.message });
  console.error(e.message); res.status(500).json({ error: 'Ошибка сервера. Попробуйте ещё раз.' });
});
const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };

async function auth(req){
  const t = readToken(cookieOf(req) || req.get('X-Pf-Session')); if (!t) return null;
  const r = await q('SELECT * FROM users WHERE id = $1', [t.uid]);
  const u = r.rows[0]; if (!u || u.session_ver !== t.ver) return null;
  return u;
}
async function must(req){ const u = await auth(req); if (!u) bad('Войдите в аккаунт', 401); return u; }

const pub = u => ({ id: u.id, name: u.nick, city: u.city, rating: u.rating, w: u.wins, l: u.losses, ava: { k: u.ava_kind, fur: u.ava_fur } });
function matchOut(m, me){
  const mine = me && (m.a === me || m.b === me);
  const showContacts = mine && (m.status === 'booked' || m.status === 'check');
  return {
    id: m.id, a: m.a, b: m.b, status: m.status, bo: m.bo, when: new Date(m.when_at).getTime(), place: m.place,
    ca: showContacts || (mine && m.a === me) ? m.ca : undefined,
    cb: showContacts || (mine && m.b === me) ? m.cb : undefined,
    sa: m.sa, sb: m.sb, by: m.reported_by, winner: m.winner, d: m.delta, dl: m.delta_l == null ? m.delta : m.delta_l,
    due: m.status === 'check' ? new Date(m.reported_at || m.updated_at).getTime() + SCORE_WAIT_MS : undefined
  };
}

/* ---- auth ---- */
app.get('/api/me', wrap(async (req, res) => { const u = await auth(req); res.json({ me: u ? pub(u) : null }); }));

app.post('/api/register', wrap(async (req, res) => {
  const nick = String(req.body.nick || '').trim().replace(/^@/, ''), city = String(req.body.city || ''), pass = String(req.body.pass || '');
  { const ne = nickError(nick); if (ne) bad(ne); }
  if (RESERVED.includes(nick.toLowerCase())) bad('Этот никнейм уже существует. Выберите другой');
  if (!CITIES.includes(city)) bad('Выберите город');
  if (pass.length < 6 || pass.length > 100) bad('Пароль — минимум 6 символов');
  const ava = req.body.ava || {};
  const kind = KINDS.includes(ava.k) ? ava.k : KINDS[crypto.randomInt(KINDS.length)];
  const code = newCode();
  try {
    const r = await q(`INSERT INTO users (nick, nick_lower, pass_hash, code_hash, city, ava_kind) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nick, nick.toLowerCase(), await bcrypt.hash(pass, 10), await bcrypt.hash(code, 10), city, kind]);
    const u = r.rows[0]; setSession(res, u.id, u.session_ver); res.json({ me: pub(u), code });
  } catch (e) { if (e.code === '23505') bad('Этот никнейм уже существует. Выберите другой'); throw e; }
}));

app.post('/api/login', wrap(async (req, res) => {
  const nick = String(req.body.nick || '').trim().replace(/^@/, '').toLowerCase(), pass = String(req.body.pass || '');
  if (tooMany('l:' + nick)) bad('Слишком много попыток. Подождите 15 минут', 429);
  const u = (await q('SELECT * FROM users WHERE nick_lower = $1', [nick])).rows[0];
  if (!u || !(await bcrypt.compare(pass, u.pass_hash))) { failed('l:' + nick); bad('Неверный никнейм или пароль', 401); }
  fails.delete('l:' + nick); setSession(res, u.id, u.session_ver); res.json({ me: pub(u) });
}));

app.post('/api/reset', wrap(async (req, res) => {
  const nick = String(req.body.nick || '').trim().replace(/^@/, '').toLowerCase(), code = String(req.body.code || '').trim().toUpperCase(), pass = String(req.body.pass || '');
  if (tooMany('r:' + nick)) bad('Слишком много попыток. Подождите 15 минут', 429);
  const u = (await q('SELECT * FROM users WHERE nick_lower = $1', [nick])).rows[0];
  if (!u || !(await bcrypt.compare(code, u.code_hash))) { failed('r:' + nick); bad('Никнейм или код не подходят', 401); }
  if (pass.length < 6 || pass.length > 100) bad('Пароль — минимум 6 символов');
  const fresh = newCode();
  const r = await q('UPDATE users SET pass_hash=$2, code_hash=$3, session_ver=session_ver+1 WHERE id=$1 RETURNING *', [u.id, await bcrypt.hash(pass, 10), await bcrypt.hash(fresh, 10)]);
  fails.delete('r:' + nick); setSession(res, u.id, r.rows[0].session_ver); res.json({ me: pub(r.rows[0]), code: fresh });
}));

app.post('/api/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

/* ---- change password while logged in (current password required) ---- */
app.post('/api/password', wrap(async (req, res) => {
  const u = await must(req);
  const old = String(req.body.old || ''), pass = String(req.body.pass || '');
  if (tooMany('p:' + u.id)) bad('Слишком много попыток. Подождите 15 минут', 429);
  if (!(await bcrypt.compare(old, u.pass_hash))) { failed('p:' + u.id); bad('Текущий пароль неверный'); }
  if (pass.length < 6 || pass.length > 100) bad('Новый пароль — минимум 6 символов');
  fails.delete('p:' + u.id);
  // signs out every other device; this one gets a fresh session
  const r = await q('UPDATE users SET pass_hash=$2, session_ver=session_ver+1 WHERE id=$1 RETURNING session_ver', [u.id, await bcrypt.hash(pass, 10)]);
  setSession(res, u.id, r.rows[0].session_ver);
  res.json({ ok: true });
}));

/* ---- profile: nickname and city can be changed ---- */
function nickProblem(nick){
  { const ne = nickError(nick); if (ne) return ne; }
  if (RESERVED.includes(nick.toLowerCase())) return 'Этот никнейм уже существует. Выберите другой';
  return null;
}
app.get('/api/nick', wrap(async (req, res) => {
  const u = await auth(req);
  const nick = String(req.query.n || '').trim().replace(/^@/, '');
  const problem = nickProblem(nick);
  if (problem) return res.json({ free: false, error: problem });
  const r = await q('SELECT id FROM users WHERE nick_lower=$1', [nick.toLowerCase()]);
  const free = !r.rows[0] || (u && r.rows[0].id === u.id);
  res.json({ free, error: free ? null : 'Этот никнейм уже существует. Выберите другой' });
}));
app.post('/api/profile', wrap(async (req, res) => {
  const u = await must(req);
  const nick = String(req.body.nick || '').trim().replace(/^@/, ''), city = String(req.body.city || '');
  const problem = nickProblem(nick); if (problem) bad(problem);
  if (!CITIES.includes(city)) bad('Выберите город');
  try {
    const r = await q('UPDATE users SET nick=$2, nick_lower=$3, city=$4 WHERE id=$1 RETURNING *', [u.id, nick, nick.toLowerCase(), city]);
    res.json({ me: pub(r.rows[0]) });
  } catch (e) { if (e.code === '23505') bad('Этот никнейм уже существует. Выберите другой'); throw e; }
}));

app.post('/api/avatar', wrap(async (req, res) => {
  const u = await must(req);
  const k = req.body.k, fur = req.body.fur || null;
  if (!KINDS.includes(k)) bad('Выберите животное');
  if (fur && !FURS.includes(fur)) bad('Выберите цвет');
  const r = await q('UPDATE users SET ava_kind=$2, ava_fur=$3 WHERE id=$1 RETURNING *', [u.id, k, fur]);
  res.json({ me: pub(r.rows[0]) });
}));

/* ---- Telegram Mini App: sign in with the data Telegram signs for the page ---- */
function tgWebAppUser(initData){
  if (!TG || !initData) return null;
  const params = new URLSearchParams(String(initData));
  const hash = params.get('hash'); if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TG).digest();
  const good = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (good.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - +params.get('auth_date') > 7 * 86400) return null;
  try { const u = JSON.parse(params.get('user') || 'null'); return u && Number.isSafeInteger(u.id) ? u : null; } catch (e) { return null; }
}
app.post('/api/tg/webapp', wrap(async (req, res) => {
  const tu = tgWebAppUser(req.body.initData);
  if (!tu) bad('Не удалось проверить данные Telegram', 401);
  const u = (await q('SELECT * FROM users WHERE tg_chat=$1', [tu.id])).rows[0];
  if (!u) return res.json({ linked: false });
  setSession(res, u.id, u.session_ver);
  res.json({ linked: true, me: pub(u) });
}));
app.post('/api/tg/webapp/link', wrap(async (req, res) => {
  const u = await must(req);
  const tu = tgWebAppUser(req.body.initData);
  if (!tu) bad('Не удалось проверить данные Telegram', 401);
  await q('UPDATE users SET tg_chat=NULL WHERE tg_chat=$1 AND id<>$2', [tu.id, u.id]);
  const already = u.tg_chat && +u.tg_chat === tu.id;
  await q('UPDATE users SET tg_chat=$2, tg_city=true, tg_mine=true WHERE id=$1', [u.id, tu.id]);
  if (!already) tgLater(() => tgSend(tu.id, `Готово, <b>${h(u.nick)}</b>! 🏓 Теперь Подача всегда под рукой: кнопка «Играть» внизу чата. Я пришлю новые вызовы в городе ${h(u.city)} и новости о ваших матчах.`));
  res.json({ ok: true });
}));

/* ---- Telegram linking ---- */
app.get('/api/tg', wrap(async (req, res) => {
  const u = await must(req);
  res.json({ available: !!(TG && BOT_NAME), bot: BOT_NAME, linked: !!u.tg_chat, city: u.tg_city, mine: u.tg_mine });
}));
app.post('/api/tg/link', wrap(async (req, res) => {
  const u = await must(req);
  if (!TG || !BOT_NAME) bad('Telegram-бот пока не подключён');
  const code = crypto.randomBytes(12).toString('base64url');
  await q(`DELETE FROM tg_links WHERE user_id=$1 OR expires_at < now()`, [u.id]);
  await q(`INSERT INTO tg_links (code, user_id, expires_at) VALUES ($1,$2, now() + interval '15 minutes')`, [code, u.id]);
  res.json({ url: `https://t.me/${BOT_NAME}?start=${code}` });
}));
app.post('/api/tg/prefs', wrap(async (req, res) => {
  const u = await must(req);
  await q('UPDATE users SET tg_city=$2, tg_mine=$3 WHERE id=$1', [u.id, !!req.body.city, !!req.body.mine]);
  res.json({ ok: true });
}));
app.post('/api/tg/unlink', wrap(async (req, res) => {
  const u = await must(req);
  if (u.tg_chat) tgLater(() => tgSend(u.tg_chat, 'Уведомления отключены. Включить снова можно в профиле на сайте.'));
  await q('UPDATE users SET tg_chat=NULL WHERE id=$1', [u.id]);
  res.json({ ok: true });
}));
app.post('/tg/:hook', wrap(async (req, res) => {
  if (req.params.hook !== TG_HOOK || req.get('X-Telegram-Bot-Api-Secret-Token') !== TG_HOOK) return res.sendStatus(404);
  res.json({ ok: true });
  const msg = req.body && req.body.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private' || typeof msg.text !== 'string') return;
  const chat = msg.chat.id, text = msg.text.trim();
  if (/^\/stop/.test(text)){
    await q('UPDATE users SET tg_chat=NULL WHERE tg_chat=$1', [chat]);
    return tgSend(chat, 'Уведомления отключены. Играть можно как раньше — кнопка «Играть» внизу чата. Включить уведомления снова: «Играть» → Профиль → «Подключить бота».', 'Играть');
  }
  const code = (text.match(/^\/start\s+([A-Za-z0-9_-]{8,64})$/) || [])[1];
  if (!code){
    const linked = (await q('SELECT nick FROM users WHERE tg_chat=$1', [chat])).rows[0];
    return tgSend(chat, linked ? `С возвращением, <b>${h(linked.nick)}</b>! 🏓\nНажмите «Играть», чтобы открыть вызовы и матчи. Я пришлю новые вызовы в вашем городе и новости о ваших матчах.\n\n/stop — отключить уведомления.`
      : 'Привет! Это Подача FIT 🏓\nЗдесь можно найти соперника по настольному теннису, бросить вызов и следить за рейтингом.\n\nНажмите «Играть» внизу чата. Войти нужно один раз — дальше всё прямо в Telegram, а я буду присылать вызовы и новости о ваших матчах.', 'Играть');
  }
  const link = (await q(`DELETE FROM tg_links WHERE code=$1 AND expires_at > now() RETURNING user_id`, [code])).rows[0];
  if (!link) return tgSend(chat, 'Ссылка устарела. Просто нажмите «Играть» внизу чата — и войдите в Подачу прямо здесь.', 'Играть');
  await q('UPDATE users SET tg_chat=NULL WHERE tg_chat=$1', [chat]);
  const u = (await q('UPDATE users SET tg_chat=$2, tg_city=true, tg_mine=true WHERE id=$1 RETURNING nick, city', [link.user_id, chat])).rows[0];
  tgSend(chat, `Готово, <b>${h(u.nick)}</b>! 🏓\nТеперь всё прямо в Telegram — нажмите «Играть» внизу чата.\n\nЯ пришлю:\n• новые вызовы в городе ${h(u.city)}\n• вызовы вам, принятые матчи и счета\n\n/stop — отключить уведомления.`, 'Играть');
}));

/* ---- everything the app shows, in one request ---- */
// tiny "has anything changed?" check, polled every few seconds; the app reloads /api/state only when it changes
app.get('/api/stamp', wrap(async (req, res) => {
  const u = await must(req);
  const r = (await q(`SELECT
      (SELECT coalesce(max(extract(epoch FROM updated_at)), 0) || ':' || count(*) FROM matches
         WHERE (status = 'open' AND when_at > now() - interval '3 hours') OR a = $1 OR b = $1) AS m,
      (SELECT coalesce(max(id), 0) || ':' || count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL) AS n,
      (SELECT count(*) || ':' || coalesce(sum(rating), 0) FROM users) AS u`, [u.id])).rows[0];
  res.json({ s: `${r.m}|${r.n}|${r.u}` });
}));

app.get('/api/state', wrap(async (req, res) => {
  const u = await must(req);
  const players = (await q('SELECT * FROM users ORDER BY rating DESC LIMIT 2000')).rows.map(pub);
  const ms = (await q(`SELECT * FROM matches
      WHERE (status = 'open' AND when_at > now() - interval '3 hours')
         OR ((a = $1 OR b = $1) AND (status <> 'done' OR updated_at > now() - interval '120 days'))
      ORDER BY when_at DESC LIMIT 500`, [u.id])).rows;
  const notes = (await q(`SELECT id, kind, match_id, actor, created_at, read_at FROM notifications
      WHERE user_id = $1 AND read_at IS NULL AND created_at > now() - interval '30 days' ORDER BY created_at DESC LIMIT 40`, [u.id])).rows
    .map(n => ({ id: +n.id, kind: n.kind, match: n.match_id, actor: n.actor, at: new Date(n.created_at).getTime(), read: !!n.read_at }));
  res.json({ me: pub(u), players, matches: ms.map(m => matchOut(m, u.id)), notes,
    tg: { available: !!(TG && BOT_NAME), bot: BOT_NAME, linked: !!u.tg_chat, city: u.tg_city, mine: u.tg_mine } });
}));

app.post('/api/notifications/read', wrap(async (req, res) => {
  const u = await must(req);
  // once seen, a notification is gone for good
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isSafeInteger) : null;
  if (ids) await q('DELETE FROM notifications WHERE user_id = $1 AND id = ANY($2)', [u.id, ids]);
  else await q('DELETE FROM notifications WHERE user_id = $1', [u.id]);
  res.json({ ok: true });
}));

/* ---- challenges ---- */
app.post('/api/challenges', wrap(async (req, res) => {
  const u = await must(req);
  const { who, when, bo, contact } = req.body;
  const place = String(req.body.place || '').trim().slice(0, 80);
  const t = new Date(when);
  if (isNaN(t) || t < Date.now() - 5 * 60e3 || t > Date.now() + 30 * 864e5) bad('Выберите время в ближайшие 30 дней');
  if (![3, 5].includes(+bo)) bad('Выберите формат игры');
  if (!place) bad('Укажите, где играем');
  if (hasContactInText(place)) bad('В поле «Где» нельзя писать контакты — для них есть отдельное поле');
  const c = normContact(contact && contact.type, contact && contact.val);
  if (!c) bad('Проверьте контакт');
  if (who){
    if (who === u.id) bad('Нельзя вызвать самого себя');
    if (!(await q('SELECT 1 FROM users WHERE id=$1', [who])).rowCount) bad('Игрок не найден');
  }
  const waiting = (await q(`SELECT count(*)::int n FROM matches WHERE a=$1 AND status IN ('open','invite')`, [u.id])).rows[0].n;
  if (waiting >= 10) bad('У вас уже 10 ожидающих вызовов. Отмените один из них');
  const r = await q(`INSERT INTO matches (a, b, status, bo, when_at, place, ca) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [u.id, who || null, who ? 'invite' : 'open', +bo, t, place, c]);
  if (who) await notify(pool, who, 'invite', r.rows[0].id, u.id);
  else tgLater(() => tgCityAlert(r.rows[0].id));
  res.json({ ok: true });
}));

async function inTx(fn){ const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } }
async function lockMatch(c, id){ const r = await c.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE', [id]); if (!r.rows[0]) bad('Матч не найден', 404); return r.rows[0]; }

app.post('/api/challenges/:id/accept', wrap(async (req, res) => {
  const u = await must(req);
  const c = normContact(req.body.contact && req.body.contact.type, req.body.contact && req.body.contact.val);
  if (!c) bad('Проверьте контакт');
  await inTx(async db => {
    const m = await lockMatch(db, req.params.id);
    const ok = (m.status === 'open' && m.a !== u.id) || (m.status === 'invite' && m.b === u.id);
    if (!ok) bad('Этот вызов уже неактуален');
    await db.query(`UPDATE matches SET b=$2, cb=$3, status='booked', updated_at=now() WHERE id=$1`, [m.id, u.id, c]);
    await notify(db, m.a, 'accepted', m.id, u.id);
  });
  res.json({ ok: true });
}));

app.post('/api/challenges/:id/cancel', wrap(async (req, res) => {
  const u = await must(req);
  await inTx(async db => {
    const m = await lockMatch(db, req.params.id);
    const ok = (m.a === u.id && ['open', 'invite', 'booked'].includes(m.status)) || (m.b === u.id && ['invite', 'booked'].includes(m.status));
    if (!ok) bad('Этот матч нельзя отменить');
    await db.query(`UPDATE matches SET status='cancelled', ca=NULL, cb=NULL, updated_at=now() WHERE id=$1`, [m.id]);
    await notify(db, m.a === u.id ? m.b : m.a, m.status === 'invite' && m.b === u.id ? 'declined' : 'cancelled', m.id, u.id);
  });
  res.json({ ok: true });
}));

app.post('/api/challenges/:id/score', wrap(async (req, res) => {
  const u = await must(req);
  const mine = +req.body.mine, theirs = +req.body.theirs;
  await inTx(async db => {
    const m = await lockMatch(db, req.params.id);
    if (m.a !== u.id && m.b !== u.id) bad('Это не ваш матч', 403);
    if (!['booked', 'check'].includes(m.status)) bad('Счёт для этого матча уже нельзя изменить');
    if (!okScore(m.bo, mine, theirs)) bad(`Победитель набирает ${need(m.bo)}`);
    const [sa, sb] = m.a === u.id ? [mine, theirs] : [theirs, mine];
    // the opponent correcting a reported score: now the first reporter has a day to answer
    const corrected = m.status === 'check' && m.reported_by && m.reported_by !== u.id;
    await db.query(`UPDATE matches SET sa=$2, sb=$3, reported_by=$4, status='check', reported_at=now(), updated_at=now() WHERE id=$1`, [m.id, sa, sb, u.id]);
    await notify(db, m.a === u.id ? m.b : m.a, corrected ? 'corrected' : 'score', m.id, u.id);
  });
  res.json({ ok: true });
}));

async function finish(db, m, confirmer){
  const wid = m.sa > m.sb ? m.a : m.b, lid = wid === m.a ? m.b : m.a;
  const rows = (await db.query('SELECT id, rating, wins, losses FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[wid, lid]])).rows;
  const w = rows.find(r => r.id === wid), l = rows.find(r => r.id === lid);
  const gw = Math.max(m.sa, m.sb), gl = Math.min(m.sa, m.sb);
  const { gain, loss } = ratingChange(w, l, gw, gl, m.bo);
  await db.query('UPDATE users SET rating=rating+$2, wins=wins+1 WHERE id=$1', [wid, gain]);
  await db.query('UPDATE users SET rating=rating-$2, losses=losses+1 WHERE id=$1', [lid, loss]);
  await db.query(`UPDATE matches SET status='done', winner=$2, delta=$3, delta_l=$4, ca=NULL, cb=NULL, updated_at=now() WHERE id=$1`, [m.id, wid, gain, loss]);
  if (confirmer) await notify(db, m.reported_by, 'confirmed', m.id, confirmer);
  else { await notify(db, m.a, 'auto', m.id, null); await notify(db, m.b, 'auto', m.id, null); }
  return { winner: wid, gain, loss };
}

app.post('/api/challenges/:id/confirm', wrap(async (req, res) => {
  const u = await must(req);
  const out = await inTx(async db => {
    const m = await lockMatch(db, req.params.id);
    if (m.a !== u.id && m.b !== u.id) bad('Это не ваш матч', 403);
    if (m.status !== 'check' || m.reported_by === u.id) bad('Нечего подтверждать');
    return finish(db, m, u.id);
  });
  res.json({ ok: true, won: out.winner === u.id, gain: out.gain, loss: out.loss });
}));

app.post('/api/challenges/:id/reject', wrap(async (req, res) => {
  const u = await must(req);
  await inTx(async db => {
    const m = await lockMatch(db, req.params.id);
    if (m.a !== u.id && m.b !== u.id) bad('Это не ваш матч', 403);
    if (m.status !== 'check' || m.reported_by === u.id) bad('Нечего отклонять');
    // back to "played, no score yet": either player can enter the right score
    await db.query(`UPDATE matches SET sa=NULL, sb=NULL, reported_by=NULL, reported_at=NULL, status='booked', updated_at=now() WHERE id=$1`, [m.id]);
    await notify(db, m.reported_by, 'rejected', m.id, u.id);
  });
  res.json({ ok: true });
}));

// public card of a player for the challenge details: record and last 5 results (no contacts)
app.get('/api/players/:id', wrap(async (req, res) => {
  await must(req);
  const u = (await q('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!u) bad('Игрок не найден', 404);
  const last = (await q(`SELECT winner FROM matches WHERE status='done' AND (a=$1 OR b=$1) ORDER BY updated_at DESC LIMIT 5`, [u.id])).rows;
  const rank = u.wins + u.losses > 0 ? +(await q(`SELECT count(*) FROM users WHERE wins + losses > 0 AND rating > $1`, [u.rating])).rows[0].count + 1 : null;
  res.json({ player: pub(u), form: last.map(r => r.winner === u.id ? 'W' : 'L'), rank });
}));

/* ---- housekeeping: expire stale matches and wipe their contacts ---- */
async function housekeeping(){
  try {
    await q(`DELETE FROM notifications WHERE created_at < now() - interval '30 days'`);
    await q(`DELETE FROM tg_links WHERE expires_at < now()`);
    // challenges nobody played: cancelled 3 days after the planned time (a just-rejected score gets 2 more days)
    await q(`UPDATE matches SET status='cancelled', ca=NULL, cb=NULL, updated_at=now()
             WHERE status IN ('open','invite','booked') AND when_at < now() - interval '3 days' AND updated_at < now() - interval '2 days'`);
    // a reported score the opponent did not confirm, correct or reject within a day counts as confirmed
    const stale = (await q(`SELECT id FROM matches WHERE status='check' AND COALESCE(reported_at, updated_at) < now() - $1::int * interval '1 millisecond'`, [SCORE_WAIT_MS])).rows;
    for (const { id } of stale) await inTx(async db => { const m = await lockMatch(db, id); if (m.status === 'check') await finish(db, m, null); });
  } catch (e) { console.error('housekeeping:', e.message); }
}

/* ---- the app itself ---- */
app.get('/health', (req, res) => res.json({ ok: true }));
// the page itself is never cached, so phones always get the latest version after a deploy
const noCache = res => res.setHeader('Cache-Control', 'no-cache, must-revalidate');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html', setHeaders: (res, file) => { if (file.endsWith('.html')) noCache(res); } }));
app.get('*', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

/* admin: delete accounts listed in the DELETE_NICKS variable (comma separated) at start-up.
   Their matches and notifications go with them (ON DELETE CASCADE). Remove the variable afterwards. */
async function adminDeletes(){
  const list = String(process.env.DELETE_NICKS || '').split(',').map(x => x.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
  for (const nick of list){
    try {
      const u = (await q('SELECT id, nick, city, rating, wins, losses FROM users WHERE nick_lower=$1', [nick])).rows[0];
      if (!u) { console.log(`admin delete: «${nick}» not found`); continue; }
      const m = (await q(`SELECT count(*) FILTER (WHERE status='done') AS done, count(*) FILTER (WHERE status<>'done') AS other FROM matches WHERE a=$1 OR b=$1`, [u.id])).rows[0];
      await q('DELETE FROM users WHERE id=$1', [u.id]);
      console.log(`admin delete: removed «${u.nick}» (${u.city}, rating ${u.rating}, ${u.wins}W/${u.losses}L) with ${m.done} played and ${m.other} other matches`);
    } catch (e) { console.error(`admin delete «${nick}»:`, e.message); }
  }
}

(async () => {
  for (let i = 0; i < 10; i++){ try { await migrate(); break; } catch (e) { console.error('DB not ready:', e.message); await new Promise(r => setTimeout(r, 3000)); if (i === 9) process.exit(1); } }
  await adminDeletes();
  housekeeping(); setInterval(housekeeping, 5 * 60e3);
  tgSetup().catch(e => console.error('telegram setup:', e.message));
  app.listen(PORT, () => console.log(`podacha.fit listening on ${PORT}`));
})();
