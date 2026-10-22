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
const NICK_RE = /^[A-Za-zА-Яа-яЁё0-9_]{3,16}$/;
const RESERVED = ['admin','administrator','rally','podacha','podachafit','support','moderator','админ','модератор','поддержка'];
const need = bo => Math.floor(bo / 2) + 1;
const okScore = (bo, a, b) => { const n = need(bo); return (a === n && b >= 0 && b < n) || (b === n && a >= 0 && a < n); };
const elo = (w, l) => Math.max(1, Math.round(32 * (1 - 1 / (1 + Math.pow(10, (l - w) / 400)))));
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
  `);
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
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeToken(uid, ver))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
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
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  if (e.status) return res.status(e.status).json({ error: e.message });
  console.error(e.message); res.status(500).json({ error: 'Ошибка сервера. Попробуйте ещё раз.' });
});
const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };

async function auth(req){
  const t = readToken(cookieOf(req)); if (!t) return null;
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
    sa: m.sa, sb: m.sb, by: m.reported_by, winner: m.winner, d: m.delta
  };
}

/* ---- auth ---- */
app.get('/api/me', wrap(async (req, res) => { const u = await auth(req); res.json({ me: u ? pub(u) : null }); }));

app.post('/api/register', wrap(async (req, res) => {
  const nick = String(req.body.nick || '').trim().replace(/^@/, ''), city = String(req.body.city || ''), pass = String(req.body.pass || '');
  if (!NICK_RE.test(nick)) bad('Никнейм: 3–16 символов, буквы, цифры или _');
  if (RESERVED.includes(nick.toLowerCase())) bad('Этот никнейм занят');
  if (!CITIES.includes(city)) bad('Выберите город');
  if (pass.length < 6 || pass.length > 100) bad('Пароль — минимум 6 символов');
  const ava = req.body.ava || {};
  const kind = KINDS.includes(ava.k) ? ava.k : KINDS[crypto.randomInt(KINDS.length)];
  const code = newCode();
  try {
    const r = await q(`INSERT INTO users (nick, nick_lower, pass_hash, code_hash, city, ava_kind) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nick, nick.toLowerCase(), await bcrypt.hash(pass, 10), await bcrypt.hash(code, 10), city, kind]);
    const u = r.rows[0]; setSession(res, u.id, u.session_ver); res.json({ me: pub(u), code });
  } catch (e) { if (e.code === '23505') bad('Этот никнейм уже занят. Попробуйте другой'); throw e; }
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

app.post('/api/avatar', wrap(async (req, res) => {
  const u = await must(req);
  const k = req.body.k, fur = req.body.fur || null;
  if (!KINDS.includes(k)) bad('Выберите животное');
  if (fur && !FURS.includes(fur)) bad('Выберите цвет');
  const r = await q('UPDATE users SET ava_kind=$2, ava_fur=$3 WHERE id=$1 RETURNING *', [u.id, k, fur]);
  res.json({ me: pub(r.rows[0]) });
}));

/* ---- everything the app shows, in one request ---- */
app.get('/api/state', wrap(async (req, res) => {
  const u = await must(req);
  const players = (await q('SELECT * FROM users ORDER BY rating DESC LIMIT 2000')).rows.map(pub);
  const ms = (await q(`SELECT * FROM matches
      WHERE (status = 'open' AND when_at > now() - interval '3 hours')
         OR ((a = $1 OR b = $1) AND (status <> 'done' OR updated_at > now() - interval '120 days'))
      ORDER BY when_at DESC LIMIT 500`, [u.id])).rows;
  res.json({ me: pub(u), players, matches: ms.map(m => matchOut(m, u.id)) });
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
  await q(`INSERT INTO matches (a, b, status, bo, when_at, place, ca) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [u.id, who || null, who ? 'invite' : 'open', +bo, t, place, c]);
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
    await db.query(`UPDATE matches SET sa=$2, sb=$3, reported_by=$4, status='check', updated_at=now() WHERE id=$1`, [m.id, sa, sb, u.id]);
  });
  res.json({ ok: true });
}));

async function finish(db, m){
  const wid = m.sa > m.sb ? m.a : m.b, lid = wid === m.a ? m.b : m.a;
  const rows = (await db.query('SELECT id, rating FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[wid, lid]])).rows;
  const w = rows.find(r => r.id === wid), l = rows.find(r => r.id === lid);
  const d = elo(w.rating, l.rating);
  await db.query('UPDATE users SET rating=rating+$2, wins=wins+1 WHERE id=$1', [wid, d]);
  await db.query('UPDATE users SET rating=rating-$2, losses=losses+1 WHERE id=$1', [lid, d]);
  await db.query(`UPDATE matches SET status='done', winner=$2, delta=$3, ca=NULL, cb=NULL, updated_at=now() WHERE id=$1`, [m.id, wid, d]);
  return { winner: wid, d };
}

app.post('/api/challenges/:id/confirm', wrap(async (req, res) => {
  const u = await must(req);
  const out = await inTx(async db => {
    const m = await lockMatch(db, req.params.id);
    if (m.a !== u.id && m.b !== u.id) bad('Это не ваш матч', 403);
    if (m.status !== 'check' || m.reported_by === u.id) bad('Нечего подтверждать');
    return finish(db, m);
  });
  res.json({ ok: true, won: out.winner === u.id, d: out.d });
}));

/* ---- housekeeping: expire stale matches and wipe their contacts ---- */
async function housekeeping(){
  try {
    // challenges nobody played: cancelled 3 days after the planned time
    await q(`UPDATE matches SET status='cancelled', ca=NULL, cb=NULL, updated_at=now()
             WHERE status IN ('open','invite','booked') AND when_at < now() - interval '3 days'`);
    // a reported score the opponent ignored for 3 days counts as confirmed
    const stale = (await q(`SELECT id FROM matches WHERE status='check' AND updated_at < now() - interval '3 days'`)).rows;
    for (const { id } of stale) await inTx(async db => { const m = await lockMatch(db, id); if (m.status === 'check') await finish(db, m); });
  } catch (e) { console.error('housekeeping:', e.message); }
}

/* ---- the app itself ---- */
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

(async () => {
  for (let i = 0; i < 10; i++){ try { await migrate(); break; } catch (e) { console.error('DB not ready:', e.message); await new Promise(r => setTimeout(r, 3000)); if (i === 9) process.exit(1); } }
  housekeeping(); setInterval(housekeeping, 60 * 60e3);
  app.listen(PORT, () => console.log(`podacha.fit listening on ${PORT}`));
})();
