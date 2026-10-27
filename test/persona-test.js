'use strict';
/*
 * podacha.fit persona tester
 * Plays the real API with simulated players, then checks the results.
 *
 *   Part 1  targeted checks   — validation, privacy, races, score rules, exploits
 *   Part 2  swarm simulation  — ~40 players with different personalities play for N "days"
 *
 * Run against a LOCAL server with a throwaway database (it rewinds timestamps in the DB
 * to simulate days passing, and restarts the server so housekeeping runs):
 *   BASE=http://localhost:3999 DATABASE_URL=postgres://... RESTART=./start.sh node test/persona-test.js
 * Never point it at production.
 */
const { execSync } = require('child_process');
const { Pool } = require('pg');

const BASE = process.env.BASE || 'http://localhost:3999';
const DB = new Pool({ connectionString: process.env.DATABASE_URL });
const RESTART = process.env.RESTART;
const DAYS = +(process.env.DAYS || 7);
const SEED = +(process.env.SEED || 42);
if (/podacha\.fit|railway\.app/.test(BASE)) { console.error('Refusing to run against production'); process.exit(1); }

/* ---------- tiny seeded random ---------- */
let rs = SEED; const rnd = () => ((rs = (rs * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = a => a[Math.floor(rnd() * a.length)];
const chance = p => rnd() < p;

/* ---------- results ---------- */
const results = []; // {area, name, status: PASS|FAIL|FINDING, detail}
const rec = (area, name, status, detail = '') => { results.push({ area, name, status, detail }); console.log(`${status.padEnd(7)} ${area} · ${name}${detail ? ' — ' + detail : ''}`); };
const check = (area, name, ok, detail) => rec(area, name, ok ? 'PASS' : 'FAIL', ok ? '' : detail);

/* ---------- API client with its own cookie ---------- */
class Client {
  constructor(label){ this.label = label; this.cookie = null; this.me = null; }
  async call(method, path, body, headers = {}){
    const h = { ...headers }; if (body !== undefined && typeof body !== 'string') h['Content-Type'] = 'application/json';
    if (typeof body === 'string') h['Content-Type'] = 'application/json';
    if (this.cookie) h.Cookie = this.cookie;
    const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const sc = r.headers.get('set-cookie'); if (sc) { const m = sc.match(/pf_s=([^;]*)/); if (m) this.cookie = m[1] ? 'pf_s=' + m[1] : null; }
    let data = null; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data, headers: r.headers };
  }
  get(p){ return this.call('GET', p); }
  post(p, b = {}){ return this.call('POST', p, b); }
  async register(nick, city = 'Ташкент', pass = 'secret123'){
    const r = await this.post('/api/register', { nick, city, pass });
    if (r.status === 200) { this.me = r.data.me; this.code = r.data.code; this.pass = pass; }
    return r;
  }
  state(){ return this.get('/api/state'); }
}
const CITIES = ['Ташкент', 'Самарканд', 'Бухара'];
const later = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const TG = { type: 'tg', val: '@test_player' };
const PH = { type: 'phone', val: '901234567' };
let nickN = 0; const nick = (p = 'p') => `${p}${++nickN}_${SEED}`.slice(0, 16);
async function newPlayer(prefix, city){ const c = new Client(prefix); const r = await c.register(nick(prefix), city || 'Ташкент'); if (r.status !== 200) throw new Error('register failed ' + JSON.stringify(r.data)); return c; }
async function matchOf(c, id){ const s = await c.state(); return s.data.matches.find(m => m.id === id); }
async function createChallenge(c, opts = {}){
  const before = new Set((await c.state()).data.matches.map(m => m.id));
  const r = await c.post('/api/challenges', { who: opts.who || null, when: opts.when || later(opts.inHours ?? 20), bo: opts.bo || 5, place: opts.place || 'Зал Олимпийский', contact: opts.contact || TG });
  if (r.status !== 200) return { r };
  const s = await c.state(); const m = s.data.matches.find(m => !before.has(m.id));
  return { r, id: m && m.id };
}

/* ---------- time travel: move every timestamp back, then restart so housekeeping runs ---------- */
async function shiftHours(h){
  await DB.query(`UPDATE matches SET when_at = when_at - $1 * interval '1 hour', created_at = created_at - $1 * interval '1 hour',
    updated_at = updated_at - $1 * interval '1 hour', reported_at = reported_at - $1 * interval '1 hour'`, [h]);
  await DB.query(`UPDATE notifications SET created_at = created_at - $1 * interval '1 hour'`, [h]);
}
async function runHousekeeping(){ if (!RESTART) throw new Error('RESTART not set'); execSync(RESTART, { stdio: 'ignore' }); await new Promise(r => setTimeout(r, 1500)); }

/* =====================================================================
 * PART 1 — targeted checks
 * ===================================================================== */
async function targeted(){
  const A = 'Registration';
  const c = new Client('x');
  let r;
  r = await c.post('/api/register', { nick: 'Admin', city: 'Ташкент', pass: 'secret123' }); check(A, 'reserved nick «Admin» rejected', r.status === 400, r.status);
  r = await c.post('/api/register', { nick: 'ab', city: 'Ташкент', pass: 'secret123' }); check(A, '2-char nick rejected', r.status === 400, r.status);
  r = await c.post('/api/register', { nick: '12345', city: 'Ташкент', pass: 'secret123' }); check(A, 'digits-only nick rejected', r.status === 400, r.status);
  r = await c.post('/api/register', { nick: 'two words', city: 'Ташкент', pass: 'secret123' }); check(A, 'nick with space rejected', r.status === 400, r.status);
  r = await c.post('/api/register', { nick: '<script>', city: 'Ташкент', pass: 'secret123' }); check(A, 'HTML in nick rejected', r.status === 400, r.status);
  r = await c.post('/api/register', { nick: 'ok_nick1', city: 'Москва', pass: 'secret123' }); check(A, 'unknown city rejected', r.status === 400, r.status);
  r = await c.post('/api/register', { nick: 'ok_nick1', city: 'Ташкент', pass: '123' }); check(A, 'short password rejected', r.status === 400, r.status);
  const base = nick('Игрок');
  const p1 = new Client('a'); r = await p1.register(base); check(A, 'Cyrillic nick accepted', r.status === 200, JSON.stringify(r.data));
  check(A, 'recovery code issued (PDCH-XXXX-XXXX)', /^PDCH-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(p1.code || ''), p1.code);
  r = await new Client('b').register(base.toUpperCase()); check(A, 'same nick in other case rejected', r.status === 400, r.status);

  const L = 'Login & sessions';
  const lc = new Client('l');
  let locked = false; for (let i = 0; i < 9; i++){ r = await lc.post('/api/login', { nick: base, pass: 'wrong' }); if (r.status === 429) locked = true; }
  check(L, 'login locks after 8 wrong passwords', locked, 'never got 429');
  r = await lc.post('/api/login', { nick: base, pass: 'secret123' }); check(L, 'correct password also blocked while locked', r.status === 429, r.status);
  const d1 = await newPlayer('dev'); const d2 = new Client('dev2');
  r = await d2.post('/api/login', { nick: d1.me.name, pass: d1.pass }); check(L, 'second device can log in', r.status === 200, r.status);
  r = await d1.post('/api/password', { old: 'secret123', pass: 'newsecret1' }); check(L, 'password change works', r.status === 200, JSON.stringify(r.data));
  r = await d2.get('/api/state'); check(L, 'other device signed out after password change', r.status === 401, r.status);
  r = await d1.get('/api/state'); check(L, 'this device stays signed in', r.status === 200, r.status);
  const rc = new Client('rc'); r = await rc.post('/api/reset', { nick: d1.me.name, code: d1.code, pass: 'thirdpass1' }); check(L, 'reset with recovery code works', r.status === 200, JSON.stringify(r.data));
  r = await new Client('rc2').post('/api/reset', { nick: d1.me.name, code: d1.code, pass: 'fourth111' }); check(L, 'recovery code is single-use', r.status === 401, r.status);
  // Telegram Mini App path: session in a header instead of a cookie
  const tgc = new Client('tg'); r = await tgc.call('POST', '/api/login', { nick: d1.me.name, pass: 'thirdpass1' }, { 'X-Pf-Tg': '1' });
  const tok = r.headers.get('x-pf-session');
  const hdr = await fetch(BASE + '/api/state', { headers: { 'X-Pf-Session': tok || '' } });
  check(L, 'Mini App header session works', hdr.status === 200, hdr.status);
  r = await fetch(BASE + '/api/state', { headers: { Cookie: 'pf_s=' + encodeURIComponent((tok || 'x.y.z.w').replace(/.$/, c => c === 'A' ? 'B' : 'A')) } });
  check(L, 'tampered session token rejected', r.status === 401, r.status);

  const P = 'Profile';
  const pa = await newPlayer('pa'), pb = await newPlayer('pb');
  r = await pa.post('/api/profile', { nick: pb.me.name.toUpperCase(), city: 'Ташкент' }); check(P, "can't take another player's nick (other case)", r.status === 400, r.status);
  r = await pa.post('/api/profile', { nick: 'support', city: 'Ташкент' }); check(P, "can't rename to reserved nick", r.status === 400, r.status);
  r = await pa.post('/api/avatar', { k: 'dragon' }); check(P, 'unknown avatar rejected', r.status === 400, r.status);

  const C = 'Challenges';
  const ca = await newPlayer('ca'), cb = await newPlayer('cb'), cx = await newPlayer('cx');
  r = await ca.post('/api/challenges', { when: later(-1), bo: 5, place: 'Зал', contact: TG }); check(C, 'challenge in the past rejected', r.status === 400, r.status);
  r = await ca.post('/api/challenges', { when: later(24 * 31), bo: 5, place: 'Зал', contact: TG }); check(C, 'challenge >30 days ahead rejected', r.status === 400, r.status);
  r = await ca.post('/api/challenges', { when: later(5), bo: 7, place: 'Зал', contact: TG }); check(C, 'bo7 format rejected', r.status === 400, r.status);
  r = await ca.post('/api/challenges', { when: later(5), bo: 5, place: 'звони 90 123 45 67', contact: TG }); check(C, 'phone number in «Где» blocked', r.status === 400, r.status);
  r = await ca.post('/api/challenges', { when: later(5), bo: 5, place: 'Зал', contact: { type: 'tg', val: '@ab' } }); check(C, 'too-short Telegram username rejected', r.status === 400, r.status);
  r = await ca.post('/api/challenges', { who: ca.me.id, when: later(5), bo: 5, place: 'Зал', contact: TG }); check(C, "can't challenge yourself", r.status === 400, r.status);
  r = await ca.post('/api/challenges', { who: '00000000-0000-0000-0000-000000000000', when: later(5), bo: 5, place: 'Зал', contact: TG }); check(C, 'challenge to unknown player rejected', r.status === 400, r.status);
  r = await ca.post('/api/challenges', { who: 'not-a-uuid', when: later(5), bo: 5, place: 'Зал', contact: TG });
  check(C, 'malformed player id gives a clean error (not 500)', r.status < 500, `HTTP ${r.status} «${r.data && r.data.error}»`);
  // real addresses that look a bit like phone numbers
  const addrs = ['Юнусабад 11-12-15', 'Чиланзар 19 квартал, дом 12', 'ТЦ Compass, 3 этаж', 'Мирабад, ул. Афросиаб 4Б', 'Ц-1 (около 64 школы)', 'Спорткомплекс «Юнусабад» 2024-2025'];
  const blocked = [];
  for (const place of addrs){ r = await ca.post('/api/challenges', { when: later(5), bo: 5, place, contact: TG }); if (r.status === 400) blocked.push(place); else if (r.status === 200) { const s = await ca.state(); const m = s.data.matches.find(x => x.place === place && x.status === 'open'); if (m) await ca.post(`/api/challenges/${m.id}/cancel`); } }
  if (blocked.length) rec(C, 'normal addresses wrongly blocked as "contacts" in «Где»', 'FINDING', blocked.map(x => `«${x}»`).join(', '));
  else rec(C, 'normal addresses accepted in «Где»', 'PASS');
  // limit of 10 waiting challenges
  const sp = await newPlayer('spam'); let tenOk = 0, eleventh;
  for (let i = 0; i < 11; i++){ r = await sp.post('/api/challenges', { when: later(3 + i), bo: 3, place: 'Зал', contact: TG }); if (r.status === 200) tenOk++; else eleventh = r; }
  check(C, 'max 10 waiting challenges per player', tenOk === 10 && eleventh && eleventh.status === 400, `${tenOk} created`);

  const V = 'Privacy';
  const { id: oid } = await createChallenge(ca, { contact: { type: 'tg', val: '@secret_caller' } });
  let mx = await matchOf(cx, oid); check(V, 'open challenge: caller contact hidden from others', mx && mx.ca === undefined, JSON.stringify(mx));
  r = await cb.post(`/api/challenges/${oid}/accept`, { contact: { type: 'tg', val: '@secret_accepter' } }); check(V, 'accept works', r.status === 200, JSON.stringify(r.data));
  const ma = await matchOf(ca, oid), mb = await matchOf(cb, oid); mx = await matchOf(cx, oid);
  check(V, 'after accept, both players see each other\'s contact', ma.cb === '@secret_accepter' && mb.ca === '@secret_caller', JSON.stringify({ ma, mb }));
  const leak = JSON.stringify((await cx.state()).data).includes('secret_');
  check(V, 'third player never receives the contacts', !leak && !mx, 'leaked in /api/state');
  r = await cx.get('/api/players/' + ca.me.id); check(V, 'player card has no contact', !JSON.stringify(r.data).includes('secret_'), '');
  r = await ca.post(`/api/challenges/${oid}/cancel`);
  const dbRow = (await DB.query('SELECT ca, cb FROM matches WHERE id=$1', [oid])).rows[0];
  check(V, 'contacts wiped from DB on cancel', dbRow.ca === null && dbRow.cb === null, JSON.stringify(dbRow));

  const R = 'Race conditions';
  const host = await newPlayer('host'); const { id: rid } = await createChallenge(host);
  const racers = await Promise.all([1, 2, 3, 4, 5, 6].map(i => newPlayer('race')));
  const rr = await Promise.all(racers.map(p => p.post(`/api/challenges/${rid}/accept`, { contact: PH })));
  const wins = rr.filter(x => x.status === 200).length;
  check(R, '6 players accept the same challenge at once → exactly 1 gets it', wins === 1, `${wins} succeeded`);
  const winner = racers[rr.findIndex(x => x.status === 200)];
  // both report at the same moment
  await shiftHours(21);
  const both = await Promise.all([host.post(`/api/challenges/${rid}/score`, { mine: 3, theirs: 1 }), winner.post(`/api/challenges/${rid}/score`, { mine: 3, theirs: 2 })]);
  const row = (await DB.query('SELECT status, sa, sb, reported_by FROM matches WHERE id=$1', [rid])).rows[0];
  rec(R, 'both players enter different scores at the same second', 'PASS', `ends as status=${row.status}, last report wins (${row.sa}:${row.sb}); the other player is asked to answer — OK`);
  // double confirm
  const confirmer = row.reported_by === host.me.id ? winner : host;
  const dc = await Promise.all([confirmer.post(`/api/challenges/${rid}/confirm`), confirmer.post(`/api/challenges/${rid}/confirm`)]);
  const ratingRows = (await DB.query('SELECT wins + losses AS n FROM users WHERE id = ANY($1)', [[host.me.id, winner.me.id]])).rows;
  check(R, 'double-tap «Подтвердить» counts the match once', dc.filter(x => x.status === 200).length === 1 && ratingRows.every(x => +x.n === 1), JSON.stringify(dc.map(x => x.status)));

  const S = 'Scores';
  const s1 = await newPlayer('s1'), s2 = await newPlayer('s2'), s3 = await newPlayer('s3');
  const { id: sid } = await createChallenge(s1, { who: s2.me.id, bo: 5 });
  r = await s3.post(`/api/challenges/${sid}/accept`, { contact: TG }); check(S, 'only the invited player can accept a personal challenge', r.status === 400, r.status);
  r = await s2.post(`/api/challenges/${sid}/accept`, { contact: TG });
  for (const [a, b] of [[3, 3], [4, 0], [2, 1], [-1, 3], [3, -1]]){ r = await s1.post(`/api/challenges/${sid}/score`, { mine: a, theirs: b }); check(S, `impossible score ${a}:${b} (to 3 wins) rejected`, r.status === 400, r.status); }
  r = await s1.post(`/api/challenges/${sid}/score`, { mine: 3, theirs: 1.5 }); check(S, 'fractional score 3:1.5 gives a clean error (not 500)', r.status < 500, `HTTP ${r.status} «${r.data && r.data.error}»`);
  r = await s1.post(`/api/challenges/${sid}/score`, { mine: '3', theirs: '' }); check(S, 'empty score field rejected or clean', r.status < 500, `HTTP ${r.status}`);
  r = await s3.post(`/api/challenges/${sid}/score`, { mine: 3, theirs: 0 }); check(S, 'outsider cannot enter a score', r.status === 403, r.status);
  // match is planned 20h ahead — try to enter a score right now
  r = await s1.post(`/api/challenges/${sid}/score`, { mine: 3, theirs: 0 });
  if (r.status === 200) rec(S, 'score can be entered BEFORE the match time', 'FINDING', 'a cheater can "report" a 3:0 win minutes after the challenge is accepted, days before playing');
  else rec(S, 'score blocked before match time', 'PASS');
  r = await s1.post(`/api/challenges/${sid}/confirm`); check(S, 'reporter cannot confirm own score', r.status === 400, r.status);
  r = await s3.post(`/api/challenges/${sid}/confirm`); check(S, 'outsider cannot confirm', r.status === 403, r.status);
  r = await s1.post(`/api/challenges/${sid}/cancel`); check(S, 'cannot cancel while a score is waiting', r.status === 400, r.status);

  const X = 'Exploits';
  // sore loser: reject the score, then cancel the match → loss disappears
  const w = await newPlayer('winner'), l = await newPlayer('loser');
  const { id: xid } = await createChallenge(w, { who: l.me.id });
  await l.post(`/api/challenges/${xid}/accept`, { contact: TG }); await shiftHours(21);
  await w.post(`/api/challenges/${xid}/score`, { mine: 3, theirs: 0 });
  r = await l.post(`/api/challenges/${xid}/reject`); const rej = r.status;
  r = await l.post(`/api/challenges/${xid}/cancel`);
  const xrow = (await DB.query('SELECT status FROM matches WHERE id=$1', [xid])).rows[0];
  if (rej === 200 && r.status === 200 && xrow.status === 'cancelled') rec(X, 'loser can erase a loss: «Отклонить» score → «Отменить» match', 'FINDING', 'match ends as cancelled, no rating change, winner gets nothing');
  else rec(X, 'reject-then-cancel blocked', 'PASS');
  // endless dispute: reject / report again
  const e1 = await newPlayer('dispA'), e2 = await newPlayer('dispB');
  const { id: eid } = await createChallenge(e1, { who: e2.me.id }); await e2.post(`/api/challenges/${eid}/accept`, { contact: TG }); await shiftHours(21);
  let loops = 0; for (let i = 0; i < 6; i++){ const a = await e1.post(`/api/challenges/${eid}/score`, { mine: 3, theirs: 0 }); const b = await e2.post(`/api/challenges/${eid}/reject`); if (a.status === 200 && b.status === 200) loops++; }
  if (loops === 6) rec(X, 'disputes never end: report ↔ reject can loop forever', 'FINDING', 'no limit, no "disputed" state; whoever stops answering first loses after 24h');
  // rating farming: same two players, many matches
  const f1 = await newPlayer('farm'), f2 = await newPlayer('alt');
  for (let i = 0; i < 8; i++){
    const { id } = await createChallenge(f1, { who: f2.me.id, inHours: 1 }); await f2.post(`/api/challenges/${id}/accept`, { contact: TG });
    await f1.post(`/api/challenges/${id}/score`, { mine: 3, theirs: 0 }); await f2.post(`/api/challenges/${id}/confirm`);
  }
  const fr = (await DB.query('SELECT rating, wins FROM users WHERE id=$1', [f1.me.id])).rows[0];
  if (fr.wins === 8) rec(X, 'rating farming with a second account', 'FINDING', `8 wins vs the same "alt" in a few seconds → rating ${fr.rating} (from 1000); no limit on repeat matches, no account-creation limit`);
  // accepting a challenge whose time already passed
  const o1 = await newPlayer('old'), o2 = await newPlayer('late');
  const { id: lid } = await createChallenge(o1, { inHours: 1 }); await shiftHours(2);
  r = await o2.post(`/api/challenges/${lid}/accept`, { contact: TG });
  if (r.status === 200) rec(X, 'challenge can be accepted after its time has passed', 'FINDING', 'open challenges stay acceptable up to 3h after start (shown in the list too)');

  const H = 'Housekeeping';
  const h1 = await newPlayer('hk1'), h2 = await newPlayer('hk2');
  const { id: hid } = await createChallenge(h1, { who: h2.me.id, inHours: 1 }); await h2.post(`/api/challenges/${hid}/accept`, { contact: TG });
  await shiftHours(2); await h1.post(`/api/challenges/${hid}/score`, { mine: 3, theirs: 2 });
  const { id: gid } = await createChallenge(h1, { inHours: 1 }); // nobody accepts
  await shiftHours(25); await runHousekeeping();
  let hr = (await DB.query('SELECT status, ca, cb, delta FROM matches WHERE id=$1', [hid])).rows[0];
  check(H, 'unanswered score counts automatically after 24h', hr.status === 'done' && hr.ca === null, JSON.stringify(hr));
  const hu = (await DB.query('SELECT rating, wins FROM users WHERE id=$1', [h1.me.id])).rows[0];
  check(H, 'auto-confirmed match updates rating', hu.wins === 1 && hu.rating > 1000, JSON.stringify(hu));
  await shiftHours(24 * 3); await runHousekeeping();
  hr = (await DB.query('SELECT status, ca FROM matches WHERE id=$1', [gid])).rows[0];
  check(H, 'unplayed challenge expires ~3 days after its time, contact wiped', hr.status === 'cancelled' && hr.ca === null, JSON.stringify(hr));

  const B = 'Robustness';
  r = await c.call('POST', '/api/login', '{bad json'); check(B, 'broken JSON gives 4xx (not 500)', r.status >= 400 && r.status < 500, r.status);
  r = await c.call('POST', '/api/register', JSON.stringify({ nick: 'x'.repeat(30000) })); check(B, 'oversized body rejected (4xx)', r.status >= 400 && r.status < 500, r.status);
  r = await s1.get('/api/players/zzz'); check(B, 'bad player id gives a clean error (not 500)', r.status < 500, `HTTP ${r.status} «${r.data && r.data.error}»`);
  r = await s1.post('/api/challenges/zzz/accept', { contact: TG }); check(B, 'bad challenge id gives a clean error (not 500)', r.status < 500, `HTTP ${r.status} «${r.data && r.data.error}»`);
  r = await new Client('anon').get('/api/state'); check(B, 'state needs login', r.status === 401, r.status);
}

/* =====================================================================
 * PART 2 — swarm: players with personalities play for several days
 * ===================================================================== */
const PERSONAS = {
  honest:     { n: 16, respond: 0.95, cheat: 0,   reject_loss: 0,   cancel_after_reject: 0, create: 0.5, accept: 0.6, show: 0.95 },
  lazy:       { n: 8,  respond: 0.35, cheat: 0,   reject_loss: 0,   cancel_after_reject: 0, create: 0.3, accept: 0.4, show: 0.85 },
  sore_loser: { n: 6,  respond: 0.9,  cheat: 0,   reject_loss: 0.9, cancel_after_reject: 0.8, create: 0.5, accept: 0.6, show: 0.95 },
  cheater:    { n: 4,  respond: 0.9,  cheat: 1,   reject_loss: 0.9, cancel_after_reject: 0, create: 0.6, accept: 0.7, show: 0.9 },
  ghost:      { n: 4,  respond: 0.1,  cheat: 0,   reject_loss: 0,   cancel_after_reject: 0, create: 0.2, accept: 0.8, show: 0.2 },
  spammer:    { n: 2,  respond: 0.5,  cheat: 0,   reject_loss: 0,   cancel_after_reject: 0, create: 1,   accept: 0.2, show: 0.5, spam: true }
};
async function swarm(){
  const players = [];
  for (const [kind, cfg] of Object.entries(PERSONAS)) for (let i = 0; i < cfg.n; i++){
    const c = await newPlayer(kind.slice(0, 5), pick(CITIES)); c.kind = kind; c.cfg = cfg; c.skill = 900 + rnd() * 400; players.push(c);
  }
  const byId = new Map(players.map(p => [p.me.id, p]));
  const truth = new Map();   // matchId -> { sa, sb, played }
  const errors500 = [];
  const stats = { created: 0, accepted: 0, reports: 0, confirms: 0, rejects: 0, corrections: 0, cancels: 0, cancelAfterReject: 0, noShow: 0, earlyFake: 0 };
  const api = async (p, path, body) => { const r = await p.post(path, body); if (r.status >= 500) errors500.push(`${path} → ${r.status} ${r.data && r.data.error}`); return r; };
  const trueScore = (m) => {
    if (truth.has(m.id)) return truth.get(m.id);
    const A = byId.get(m.a), B = byId.get(m.b); const pa = 1 / (1 + Math.pow(10, (B.skill - A.skill) / 400));
    const need = Math.floor(m.bo / 2) + 1; let a = 0, b = 0; while (a < need && b < need) chance(pa) ? a++ : b++;
    const played = chance(A.cfg.show) && chance(B.cfg.show);
    const t = { sa: a, sb: b, played }; truth.set(m.id, t); return t;
  };

  for (let day = 1; day <= DAYS; day++){
    for (const p of players.sort(() => rnd() - 0.5)){
      const s = (await p.state()).data; if (!s) continue;
      const me = p.me.id;
      // 1. create challenges
      const n = p.cfg.spam ? 3 : (chance(p.cfg.create) ? 1 : 0);
      for (let i = 0; i < n; i++){
        const sameCity = players.filter(o => o !== p && o.me.city === p.me.city);
        const who = chance(0.3) && sameCity.length ? pick(sameCity).me.id : null;
        const r = await api(p, '/api/challenges', { who, when: later(2 + rnd() * 30), bo: pick([3, 5]), place: pick(['Зал Олимпийский', 'Парк Бабура, столы', 'Спорткомплекс Юнусабад', 'ТТ-клуб Чиланзар']), contact: chance(0.5) ? TG : PH });
        if (r.status === 200) stats.created++;
      }
      // 2. accept open challenges in my city / invites to me
      for (const m of s.matches){
        if (m.status === 'invite' && m.b === me && chance(p.cfg.accept)) { const r = await api(p, `/api/challenges/${m.id}/accept`, { contact: TG }); if (r.status === 200) stats.accepted++; }
        else if (m.status === 'open' && m.a !== me && byId.get(m.a) && byId.get(m.a).me.city === p.me.city && chance(p.cfg.accept * 0.4)) { const r = await api(p, `/api/challenges/${m.id}/accept`, { contact: PH }); if (r.status === 200) stats.accepted++; }
      }
      // 3. my booked matches: report (after playing) — cheaters report a win right away
      for (const m of s.matches.filter(m => m.status === 'booked' && (m.a === me || m.b === me))){
        const t = trueScore(m), iAmA = m.a === me, past = m.when < Date.now();
        if (p.cfg.cheat && chance(0.8)) { const need = Math.floor(m.bo / 2) + 1; const r = await api(p, `/api/challenges/${m.id}/score`, { mine: need, theirs: 0 }); if (r.status === 200) { stats.reports++; if (!past) stats.earlyFake++; } continue; }
        if (!past) continue;
        if (!t.played) { if (chance(0.3)) { const r = await api(p, `/api/challenges/${m.id}/cancel`); if (r.status === 200) { stats.cancels++; stats.noShow++; } } continue; }
        if (chance(p.cfg.respond)) { const r = await api(p, `/api/challenges/${m.id}/score`, { mine: iAmA ? t.sa : t.sb, theirs: iAmA ? t.sb : t.sa }); if (r.status === 200) stats.reports++; }
      }
      // 4. scores waiting for me
      for (const m of s.matches.filter(m => m.status === 'check' && m.by !== me && (m.a === me || m.b === me))){
        if (!chance(p.cfg.respond)) continue;
        const t = trueScore(m), iAmA = m.a === me;
        const myWin = iAmA ? m.sa > m.sb : m.sb > m.sa;
        const correct = t.played && t.sa === m.sa && t.sb === m.sb;
        if (!myWin && chance(p.cfg.reject_loss)) {
          const r = await api(p, `/api/challenges/${m.id}/reject`); if (r.status === 200) stats.rejects++;
          if (chance(p.cfg.cancel_after_reject)) { const c2 = await api(p, `/api/challenges/${m.id}/cancel`); if (c2.status === 200) { stats.cancels++; stats.cancelAfterReject++; } }
        } else if (correct || p.cfg.cheat) { const r = await api(p, `/api/challenges/${m.id}/confirm`); if (r.status === 200) stats.confirms++; }
        else if (t.played) { const r = await api(p, `/api/challenges/${m.id}/score`, { mine: iAmA ? t.sa : t.sb, theirs: iAmA ? t.sb : t.sa }); if (r.status === 200) stats.corrections++; }
        else { const r = await api(p, `/api/challenges/${m.id}/reject`); if (r.status === 200) stats.rejects++; }
      }
      // privacy probe during the run
      for (const m of s.matches) if (m.a !== me && m.b !== me && (m.ca !== undefined || m.cb !== undefined)) errors500.push(`LEAK: ${p.me.name} sees contact of match ${m.id}`);
    }
    await shiftHours(24); await runHousekeeping();
    process.stdout.write(`  day ${day} done\n`);
  }

  /* ---- invariants & outcomes ---- */
  const A = 'Swarm';
  const done = (await DB.query(`SELECT * FROM matches WHERE status='done' AND (a = ANY($1) OR b = ANY($1))`, [[...byId.keys()]])).rows;
  const users = (await DB.query(`SELECT id, rating, wins, losses FROM users WHERE id = ANY($1)`, [[...byId.keys()]])).rows;
  let recordOk = true, ratingOk = true;
  for (const u of users){
    const mine = done.filter(m => m.a === u.id || m.b === u.id);
    const w = mine.filter(m => m.winner === u.id).length, l = mine.length - w;
    if (w !== u.wins || l !== u.losses) recordOk = false;
    const expect = 1000 + mine.reduce((s, m) => s + (m.winner === u.id ? m.delta : -(m.delta_l ?? m.delta)), 0);
    if (expect !== u.rating) ratingOk = false;
  }
  check(A, 'every player\'s W/L equals their finished matches', recordOk, 'mismatch');
  check(A, 'every rating = 1000 + sum of match deltas', ratingOk, 'mismatch');
  const contactsLeft = (await DB.query(`SELECT count(*)::int n FROM matches WHERE status IN ('done','cancelled') AND (ca IS NOT NULL OR cb IS NOT NULL)`)).rows[0].n;
  check(A, 'no contacts kept on finished/cancelled matches', contactsLeft === 0, `${contactsLeft} rows`);
  const leaks = errors500.filter(e => e.startsWith('LEAK')); const fives = errors500.filter(e => !e.startsWith('LEAK'));
  check(A, 'no contact leaks to other players during the run', leaks.length === 0, leaks.slice(0, 3).join('; '));
  check(A, 'no server errors (500) during normal play', fives.length === 0, `${fives.length}: ` + [...new Set(fives)].slice(0, 3).join('; '));

  // how often the official result is wrong, by persona of the winner
  let wrong = 0, wrongByCheat = 0, notPlayedButCounted = 0;
  for (const m of done){
    const t = truth.get(m.id); if (!t) continue;
    if (!t.played) { notPlayedButCounted++; wrong++; if (byId.get(m.winner).kind === 'cheater') wrongByCheat++; continue; }
    const realWinner = t.sa > t.sb ? m.a : m.b;
    if (realWinner !== m.winner) { wrong++; if (byId.get(m.winner).kind === 'cheater') wrongByCheat++; }
  }
  const board = {};
  for (const p of players){ const u = users.find(x => x.id === p.me.id); (board[p.kind] ||= []).push(u.rating); }
  const avg = a => Math.round(a.reduce((s, x) => s + x, 0) / a.length);
  const ranking = Object.fromEntries(Object.entries(board).map(([k, v]) => [k, avg(v)]));
  const cancelled = (await DB.query(`SELECT count(*)::int n FROM matches WHERE status='cancelled' AND (a = ANY($1))`, [[...byId.keys()]])).rows[0].n;
  return { stats, finished: done.length, cancelled, wrong, wrongByCheat, notPlayedButCounted, ranking, players: players.length };
}

(async () => {
  console.log(`podacha.fit persona test → ${BASE}\n`);
  await targeted();
  console.log('\n--- swarm simulation ---');
  const sim = await swarm();
  console.log(JSON.stringify(sim, null, 2));
  require('fs').writeFileSync(process.env.OUT || 'persona-results.json', JSON.stringify({ results, sim }, null, 2));
  const f = results.filter(r => r.status === 'FAIL').length, fi = results.filter(r => r.status === 'FINDING').length;
  console.log(`\n${results.length} checks: ${results.length - f - fi} pass, ${f} fail, ${fi} findings`);
  await DB.end(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
