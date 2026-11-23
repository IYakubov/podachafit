/* Second Telegram bot for table tennis clubs and table-rental places.
   An owner fills a short form in the bot; the request goes to the admin's chat;
   the admin approves it with /approve <id> and the club appears under «Где» in the app.
   Env: CLUBS_BOT_TOKEN (from @BotFather), CLUBS_ADMIN_CODE (secret for "/admin <code>"). */
const crypto = require('crypto');

module.exports = function clubs({ app, q, wrap, APP_URL, SECRET, RG }) {
  const TOKEN = process.env.CLUBS_BOT_TOKEN || '';
  const ADMIN_CODE = process.env.CLUBS_ADMIN_CODE || '';
  const HOOK = crypto.createHash('sha256').update('clubs:' + SECRET).digest('hex').slice(0, 32);
  let NAME = '';
  const h = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  async function call(method, body) {
    if (!TOKEN) return null;
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j && j.ok === false) console.error('Clubs bot:', method, 'to', body && body.chat_id, 'refused:', j.description);
      return j;
    } catch (e) { console.error('clubs bot:', method, e.message); return null; }
  }
  const kb = rows => ({ keyboard: rows.map(r => r.map(t => typeof t === 'string' ? { text: t } : t)), resize_keyboard: true, one_time_keyboard: true });
  const NOKB = { remove_keyboard: true };
  const send = (chat, html, markup) => call('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup });

  const splitLandmark = t => {
    const m = String(t || '').match(/^(.*?)[\s,;.(-]*(?:ориентир|orientir|mo[‘'`ʻ’]?ljal)[\s:,.\-–—)]*(.+)$/i);
    if (!m) return null;
    const address = m[1].replace(/[\s,;.(-]+$/, '').trim(), landmark = m[2].replace(/[\s)]+$/, '').trim();
    return address.length >= 3 && landmark ? { address, landmark } : null;
  };
  async function migrate() {
    await q(`
      CREATE TABLE IF NOT EXISTS clubs (
        id serial PRIMARY KEY,
        name text NOT NULL,
        city text NOT NULL,
        address text NOT NULL,
        info text,
        contact text,
        tg_user text,
        tg_chat bigint,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','removed')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS club_chats (
        chat bigint PRIMARY KEY,
        step int NOT NULL DEFAULT 0,
        data jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text);
      ALTER TABLE clubs ADD COLUMN IF NOT EXISTS region text;
      ALTER TABLE clubs ADD COLUMN IF NOT EXISTS hours text;
      ALTER TABLE clubs ADD COLUMN IF NOT EXISTS landmark text;
      ALTER TABLE clubs ADD COLUMN IF NOT EXISTS tables text;
      ALTER TABLE clubs ADD COLUMN IF NOT EXISTS price text;
      ALTER TABLE clubs ADD COLUMN IF NOT EXISTS logo text;
      UPDATE clubs SET region='Ташкентская область' WHERE region='Ташкент';
    `);
    // clubs from the old one-field form: «Богиравон 4 Ориентир Малика бозор» → address + landmark
    for (const c of (await q(`SELECT id, address FROM clubs WHERE landmark IS NULL`)).rows) {
      const sp = splitLandmark(c.address);
      if (sp) { await q('UPDATE clubs SET address=$2, landmark=$3 WHERE id=$1', [c.id, sp.address, sp.landmark]); console.log(`Clubs bot: #${c.id} split into address «${sp.address}» + landmark «${sp.landmark}»`); }
    }
    // one-time cleanup: remove the old test / mistaken requests #1–#5 (Понгклаб, Илхам клуб, Baliqbazar, Ayran PONG, Ermak tennis)
    const done = (await q(`SELECT 1 FROM settings WHERE key='cleanup_2026_11_23'`)).rows.length;
    if (!done) {
      const r = await q(`DELETE FROM clubs WHERE id BETWEEN 1 AND 5 AND status <> 'active' RETURNING id, name`);
      await q(`INSERT INTO settings (key, value) VALUES ('cleanup_2026_11_23', '1') ON CONFLICT (key) DO NOTHING`);
      console.log('Clubs bot: removed old requests: ' + (r.rows.map(c => `#${c.id} ${c.name}`).join(', ') || 'none'));
    }
  }

  async function setup() {
    if (!TOKEN) { console.log('Clubs bot: CLUBS_BOT_TOKEN not set, disabled'); return; }
    const me = await call('getMe', {});
    if (!me || !me.ok) { console.error('Clubs bot: token rejected'); return; }
    NAME = me.result.username;
    try {
      const ad = await adminChat();
      const r = (await q(`SELECT id, name, status, tg_chat, created_at FROM clubs ORDER BY id DESC LIMIT 8`)).rows;
      console.log('Clubs bot: admin chat ' + (ad ? 'set (' + ad + ')' : 'NOT set — send "/admin <code>" to the clubs bot'));
      console.log('Clubs bot: latest requests: ' + (r.map(c => `#${c.id} ${c.name} [${c.status}] from ${c.tg_chat} ${new Date(c.created_at).toISOString().slice(0, 16)}`).join(' | ') || 'none'));
    } catch (e) { console.error('Clubs bot: status check failed:', e.message); }
    if (/^https:/.test(APP_URL)) {
      const r = await call('setWebhook', { url: `${APP_URL}/tgc/${HOOK}`, secret_token: HOOK, allowed_updates: ['message'], drop_pending_updates: true });
      console.log('Clubs bot: @' + NAME + (r && r.ok ? ' ready' : ' webhook failed: ' + (r && r.description)));
    }
    await call('setMyName', { name: 'Подача FIT · Клубы' });
    await call('setMyCommands', { commands: [{ command: 'start', description: 'Добавить клуб в Подача FIT' }] });
    await call('setMyShortDescription', { short_description: 'Добавьте клуб или столы в аренду в Подача FIT 🏓 Стоимость размещения в списке — 500 000 сум в месяц' });
    await call('setMyDescription', { description: '🏓 Ваш клуб — в списке мест для игры в Подача FIT. Игроки вашего города выберут его в один тап.\n\nСтоимость размещения клуба в списке — 500 000 сум в месяц.\n\nНажмите «Start» и ответьте на 8 коротких вопросов.' });
  }

  const adminChat = async () => ((await q(`SELECT value FROM settings WHERE key='clubs_admin_chat'`)).rows[0] || {}).value || null;
  const setStep = (chat, step, data) => q(`INSERT INTO club_chats (chat, step, data, updated_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (chat) DO UPDATE SET step=$2, data=$3, updated_at=now()`, [chat, step, JSON.stringify(data || {})]);
  const getStep = async chat => (await q('SELECT step, data FROM club_chats WHERE chat=$1', [chat])).rows[0] || { step: 0, data: {} };
  const pairs = list => { const rows = []; for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2)); return rows; };
  const regionKb = () => kb(pairs(RG.regionNames));
  const townKb = region => kb(pairs(RG.citiesOf(region)).concat([['⬅️ Другой регион']]));
  const summary = d => [
    `<b>${h(d.name)}</b>`,
    `📍 Адрес: ${h(d.city)}${d.region && d.region !== d.city ? ' (' + h(d.region) + ')' : ''}, ${h(d.address)}`,
    d.landmark && `🧭 Ориентир: ${h(d.landmark)}`,
    d.tables && `🏓 Столов: ${h(d.tables)}`,
    d.price && `💰 Цена: ${h(d.price)}`,
    d.info && `ℹ️ ${h(d.info)}`,
    d.hours && `🕒 Часы: ${h(d.hours)}`,
    d.logo && '🖼 Логотип: есть',
    d.contact && `📞 ${h(d.contact)}`,
  ].filter(Boolean).join('\n');
  // admin card: with the logo as a photo when there is one
  const sendCard = (chat, c, text) => c.logo
    ? call('sendPhoto', { chat_id: chat, photo: c.logo, caption: text.slice(0, 1000), parse_mode: 'HTML' }).then(r => r && r.ok ? r : send(chat, text))
    : send(chat, text);
  const sum = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  // a club's logo: the smallest photo size that is still sharp in the app (≥256px), else the biggest
  const photoId = msg => {
    if (msg.photo && msg.photo.length) { const ok = msg.photo.filter(p => p.width >= 256); return (ok[0] || msg.photo[msg.photo.length - 1]).file_id; }
    if (msg.document && /^image\//.test(msg.document.mime_type || '')) return msg.document.file_id;
    return null;
  };
  const Q = {
    address: '<b>3/8.</b> Адрес? Улица и дом.\n<i>ул. Амира Темура, 15</i>',
    landmark: '<b>4/8.</b> Ориентир? Как найти вход.\n<i>напротив метро «Минор», 2 этаж</i>',
    tables: '<b>5/8.</b> Сколько столов?',
    price: '<b>6/8.</b> Цена за час одного стола?\n<i>40 000</i>',
    hours: '<b>7/8.</b> Часы работы?\n<i>Пн–Сб 10:00–22:00, Вс 12:00–20:00</i>',
    logo: '<b>8/8.</b> Логотип клуба? Пришлите его картинкой — игроки увидят его в списке.',
    contact: '<b>8/8.</b> Ваш телефон или @username? Его видим только мы.',
  };
  const SKIP = kb([['Пропустить']]);
  const TABLES_KB = kb([['1', '2', '3', '4'], ['5', '6', '8', '10+'], ['Пропустить']]);
  const HOURS_KB = kb([['Ежедневно 09:00–22:00'], ['Круглосуточно']]);
  const CONTACT_KB = kb([[{ text: '📱 Отправить мой номер', request_contact: true }]]);
  const clip = (t, n) => String(t || '').trim().slice(0, n);

  let WELCOME_ID = null;
  async function sendWelcomePhoto(chat, caption) {
    if (!TOKEN) return null;
    const base = { chat_id: chat, caption, parse_mode: 'HTML', reply_markup: NOKB };
    if (WELCOME_ID) { const r = await call('sendPhoto', Object.assign({ photo: WELCOME_ID }, base)); if (r && r.ok) return r; WELCOME_ID = null; }
    try {
      const fd = new FormData();
      for (const k in base) fd.append(k, typeof base[k] === 'object' ? JSON.stringify(base[k]) : String(base[k]));
      fd.append('photo', new Blob([require('fs').readFileSync(require('path').join(__dirname, 'public', 'clubs-welcome.jpg'))], { type: 'image/jpeg' }), 'welcome.jpg');
      const r = await (await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: 'POST', body: fd })).json();
      if (r && r.ok && r.result && r.result.photo) WELCOME_ID = r.result.photo[r.result.photo.length - 1].file_id;
      return r;
    } catch (e) { return { ok: false, description: e.message }; }
  }
  async function start(chat) {
    await setStep(chat, 1, {});
    const text = '🏓 Добавим ваш клуб в <b>Подача FIT</b> — игроки выберут его в один тап.\nСтоимость размещения клуба в списке — <b>500 000 сум в месяц</b>.\n\n<b>1/8.</b> Название клуба или зала?';
    // the welcome picture with the text as its caption: uploaded once from disk, then reused by its Telegram file_id
    const r = await sendWelcomePhoto(chat, text);
    if (!r || !r.ok) { console.error('Clubs bot: welcome photo failed:', r && r.description); return send(chat, text, NOKB); }
  }

  const FIELDS = { название: 'name', адрес: 'address', ориентир: 'landmark', столы: 'tables', цена: 'price', часы: 'hours', инфо: 'info' };
  const EDIT_HELP = 'Изменить: <code>/edit ID поле текст</code>\nПоля: название, адрес, ориентир, столы, цена, часы, инфо («-» — очистить)\nЛоготип: картинка с подписью <code>/logo ID</code>';
  async function admin(chat, text, from, photo) {
    const [cmd, arg] = text.split(/\s+/, 2);
    if (cmd === '/requests') {
      const r = (await q(`SELECT * FROM clubs WHERE status='pending' ORDER BY id LIMIT 20`)).rows;
      return send(chat, r.length ? r.map(c => `#${c.id}\n${summary(c)}${c.tg_user ? '\n✈️ @' + h(c.tg_user) : ''}`).join('\n\n') + '\n\n/approve ID · /reject ID' : 'Новых заявок нет.');
    }
    if (cmd === '/clubs') {
      const r = (await q(`SELECT * FROM clubs WHERE status='active' ORDER BY city, name LIMIT 100`)).rows;
      return send(chat, r.length ? r.map(c => `#${c.id} <b>${h(c.name)}</b> — ${h(c.city)}, ${h(c.address)}${c.logo ? ' 🖼' : ''}`).join('\n') + '\n\n/club ID — карточка и правка\n/remove ID — убрать из приложения' : 'В приложении пока нет клубов.');
    }
    const id = parseInt(arg, 10);
    if (cmd === '/club') {
      const c = id && (await q('SELECT * FROM clubs WHERE id=$1', [id])).rows[0];
      return c ? sendCard(chat, c, `#${c.id} · ${c.status}\n\n${summary(c)}\n\n${EDIT_HELP}`) : send(chat, 'Пример: /club 6');
    }
    if (cmd === '/edit') {
      // /edit 6 ориентир напротив метро «Минор»   ("-" clears the field)
      const m = text.match(/^\/edit\s+(\d+)\s+(\S+)\s+([\s\S]+)$/);
      const col = m && FIELDS[m[2].toLowerCase()];
      if (!m || !col) return send(chat, EDIT_HELP);
      const v = m[3].trim() === '-' ? null : m[3].trim().slice(0, 120);
      if (v === null && ['name', 'address'].includes(col)) return send(chat, 'Название и адрес нельзя оставить пустыми.');
      const c = (await q(`UPDATE clubs SET ${col}=$2 WHERE id=$1 RETURNING *`, [+m[1], v])).rows[0];
      return c ? send(chat, `✏️ #${c.id} обновлён\n\n${summary(c)}`) : send(chat, `Клуб #${m[1]} не найден.`);
    }
    if (cmd === '/logo') {
      // photo with caption «/logo 6» sets the logo; «/logo 6 -» removes it
      const pid = photo, clear = /\s-\s*$/.test(text);
      if (!id || (!pid && !clear)) return send(chat, 'Пришлите картинку с подписью <code>/logo 6</code>, или <code>/logo 6 -</code> чтобы убрать логотип.');
      const c = (await q('UPDATE clubs SET logo=$2 WHERE id=$1 RETURNING *', [id, clear ? null : pid])).rows[0];
      return c ? sendCard(chat, c, `🖼 #${c.id} «${h(c.name)}»: логотип ${clear ? 'убран' : 'обновлён'}`) : send(chat, `Клуб #${id} не найден.`);
    }
    if (['/approve', '/reject', '/remove'].includes(cmd)) {
      if (!id) return send(chat, `Укажите номер заявки: ${cmd} 12`);
      const to = { '/approve': 'active', '/reject': 'rejected', '/remove': 'removed' }[cmd];
      const c = (await q(`UPDATE clubs SET status=$2 WHERE id=$1 RETURNING *`, [id, to])).rows[0];
      if (!c) return send(chat, `Заявка #${id} не найдена.`);
      if (to === 'active' && c.tg_chat) await send(c.tg_chat, `🎉 Ваш клуб <b>${h(c.name)}</b> добавлен в Подача FIT!\nТеперь игроки города ${h(c.city)} видят его, когда выбирают, где играть.`);
      return send(chat, `#${id} «${h(c.name)}»: ${{ active: '✅ добавлен в приложение', rejected: '❌ отклонён', removed: '🗑 убран из приложения' }[to]}`);
    }
    return null;
  }

  app.post('/tgc/:hook', wrap(async (req, res) => {
    if (req.params.hook !== HOOK || req.get('X-Telegram-Bot-Api-Secret-Token') !== HOOK) return res.sendStatus(404);
    res.json({ ok: true });
    const msg = req.body && req.body.message;
    if (!msg || !msg.chat || msg.chat.type !== 'private') return;
    const chat = msg.chat.id, text = typeof msg.text === 'string' ? msg.text.trim() : typeof msg.caption === 'string' ? msg.caption.trim() : '';
    // admin: "/admin <code>" once, then /requests /approve /reject /clubs /remove
    if (ADMIN_CODE && /^\/admin\s+/.test(text)) {
      if (text.split(/\s+/)[1] !== ADMIN_CODE) return send(chat, 'Неверный код.');
      await q(`INSERT INTO settings (key, value) VALUES ('clubs_admin_chat', $1) ON CONFLICT (key) DO UPDATE SET value=$1`, [String(chat)]);
      await send(chat, '✅ Этот чат получает заявки клубов.\n\n/requests — новые заявки\n/approve ID — добавить в приложение\n/reject ID — отклонить\n/clubs — клубы в приложении\n/club ID — карточка клуба\n/edit ID поле текст — исправить\n/logo ID — подпись к картинке-логотипу\n/remove ID — убрать');
      const waiting = +(await q(`SELECT count(*) FROM clubs WHERE status='pending'`)).rows[0].count;
      if (waiting) await admin(chat, '/requests');
      return;
    }
    if (String(chat) === String(await adminChat()) && /^\/(requests|approve|reject|clubs|remove|club|edit|logo)\b/.test(text)) return admin(chat, text, msg.from, photoId(msg));
    if (/^\/start/.test(text) || text === '✏️ Заполнить заново') return start(chat);

    const st = await getStep(chat), d = st.data || {};
    if (!st.step) return start(chat);
    if (st.step === 1) {
      if (!text) return send(chat, 'Напишите название клуба текстом.');
      d.name = clip(text, 60); await setStep(chat, 2, d);
      return send(chat, '<b>2/8.</b> Регион?', regionKb());
    }
    if (st.step === 2) {
      if (!RG.regionNames.includes(text)) return send(chat, 'Выберите регион кнопкой ниже.', regionKb());
      d.region = text;
      if (RG.citiesOf(text).length === 1) { d.city = RG.citiesOf(text)[0]; await setStep(chat, 3, d); return send(chat, Q.address, NOKB); }
      await setStep(chat, 22, d);
      return send(chat, 'Город или район? Выберите кнопкой или напишите название.', townKb(text));
    }
    if (st.step === 22) {
      if (text === '⬅️ Другой регион') { await setStep(chat, 2, d); return send(chat, '<b>2/8.</b> Регион?', regionKb()); }
      const town = text.replace(/\s+/g, ' ');
      if (!RG.citiesOf(d.region).includes(town) && !RG.TOWN_RE.test(town)) return send(chat, 'Выберите город кнопкой или напишите название буквами.', townKb(d.region));
      d.city = town; await setStep(chat, 3, d);
      return send(chat, Q.address, NOKB);
    }
    if (st.step === 3) {
      if (text.length < 4) return send(chat, 'Напишите адрес чуть подробнее: улица и дом.');
      d.address = clip(text, 120); await setStep(chat, 8, d);
      return send(chat, Q.landmark, SKIP);
    }
    if (st.step === 8) {
      d.landmark = text === 'Пропустить' ? '' : clip(text, 120); await setStep(chat, 4, d);
      return send(chat, Q.tables, TABLES_KB);
    }
    if (st.step === 4) {
      const m = text.match(/^\s*(\d{1,3})\s*(\+)?/);
      if (text !== 'Пропустить' && !m) return send(chat, 'Напишите число столов цифрой, например: 6', TABLES_KB);
      d.tables = m ? m[1] + (m[2] || '') : ''; await setStep(chat, 9, d);
      return send(chat, Q.price, SKIP);
    }
    if (st.step === 9) {
      // «40000» / «40 000» → «40 000 сум/час»; anything else is kept as written
      const n = text.replace(/[\s.,]/g, '');
      d.price = text === 'Пропустить' ? '' : /^\d{3,7}$/.test(n) ? sum(n) + ' сум/час' : clip(text, 60);
      await setStep(chat, 7, d);
      return send(chat, Q.hours, HOURS_KB);
    }
    if (st.step === 7) {
      if (text.length < 3) return send(chat, 'Напишите часы работы, например: <i>Пн–Сб 10:00–22:00</i>', HOURS_KB);
      d.hours = clip(text, 80); await setStep(chat, 5, d);
      return send(chat, Q.contact, CONTACT_KB);
    }
    if (st.step === 10) {
      const id = photoId(msg);
      if (!id && text !== 'Пропустить') return send(chat, 'Пришлите логотип картинкой или нажмите «Пропустить».', SKIP);
      d.logo = id || ''; await setStep(chat, 5, d);
      return send(chat, Q.contact, CONTACT_KB);
    }
    if (st.step === 5) {
      const c = msg.contact && msg.contact.phone_number ? '+' + String(msg.contact.phone_number).replace(/^\+/, '') : clip(text, 60);
      if (!c) return send(chat, 'Отправьте номер кнопкой или напишите контакт текстом.');
      d.contact = c; await setStep(chat, 6, d);
      return send(chat, 'Проверьте:\n\n' + summary(d) + '\n\nСтоимость размещения в списке — 500 000 сум в месяц.', kb([['✅ Отправить заявку'], ['✏️ Заполнить заново']]));
    }
    if (st.step === 6) {
      if (text !== '✅ Отправить заявку') return send(chat, 'Нажмите «✅ Отправить заявку» или «✏️ Заполнить заново».', kb([['✅ Отправить заявку'], ['✏️ Заполнить заново']]));
      const open = +(await q(`SELECT count(*) FROM clubs WHERE tg_chat=$1 AND status='pending'`, [chat])).rows[0].count;
      const user = msg.from && msg.from.username ? msg.from.username : null;
      if (open >= 10) {
        // not saved: this account already has 10 waiting requests — tell the admin instead of dropping it silently
        console.log(`Clubs bot: request «${d.name}» from ${chat} not saved — ${open} requests already waiting`);
        const ad0 = await adminChat();
        if (ad0) await send(ad0, `⚠️ Заявка не сохранена: у ${user ? '@' + h(user) : 'чата ' + chat} уже ${open} ожидающих заявки.\n\n${summary(d)}\n\n/requests — посмотреть, /reject ID — убрать старые`);
        await setStep(chat, 0, {}); return send(chat, 'Ваша заявка уже у нас. Мы свяжемся с вами, чтобы всё обсудить.', NOKB);
      }
      const c = (await q(`INSERT INTO clubs (name, city, region, address, landmark, tables, price, info, hours, logo, contact, tg_user, tg_chat)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [d.name, d.city, d.region || RG.REGION_OF[d.city] || null, d.address, d.landmark || null, d.tables || null, d.price || null,
         d.info || null, d.hours || null, d.logo || null, d.contact, user, chat])).rows[0];
      console.log(`Clubs bot: new request #${c.id} «${c.name}» from ${chat}`);
      await setStep(chat, 0, {});
      await send(chat, 'Спасибо! Заявка отправлена 🙌\nМы свяжемся с вами, чтобы всё обсудить.', NOKB);
      const ad = await adminChat();
      if (ad) await sendCard(ad, c, `🆕 Заявка клуба #${c.id}\n\n${summary(c)}${user ? '\n✈️ @' + h(user) : ''}\n\n/approve ${c.id} — добавить в приложение\n/reject ${c.id} — отклонить`);
      else console.log(`Clubs bot: new request #${c.id} (no admin chat yet — send "/admin <code>" to the clubs bot)`);
      return;
    }
  }));

  const activeClubs = async () => (await q(`SELECT id, name, city, COALESCE(region, '') AS region, address, landmark, tables, price, hours, info,
      CASE WHEN logo IS NULL THEN NULL ELSE left(md5(logo), 8) END AS lv FROM clubs WHERE status='active' ORDER BY name LIMIT 300`)).rows
    .map(({ lv, ...c }) => Object.assign(c, { region: c.region || RG.REGION_OF[c.city] || '', logo: lv ? `/club-logo/${c.id}?v=${lv}` : null }));

  // club logos live in Telegram; the app gets them through here (the bot token never reaches the browser)
  const LOGOS = new Map();
  app.get('/club-logo/:id', wrap(async (req, res) => {
    const c = (await q(`SELECT logo FROM clubs WHERE id=$1 AND status='active'`, [parseInt(req.params.id, 10) || 0])).rows[0];
    if (!c || !c.logo) return res.sendStatus(404);
    let img = LOGOS.get(c.logo);
    if (!img) {
      const f = await call('getFile', { file_id: c.logo });
      if (!f || !f.ok) return res.sendStatus(404);
      const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`);
      if (!r.ok) return res.sendStatus(404);
      img = { type: r.headers.get('content-type') || 'image/jpeg', buf: Buffer.from(await r.arrayBuffer()) };
      if (img.buf.length > 2e6) return res.sendStatus(413);
      if (LOGOS.size > 300) LOGOS.clear();
      LOGOS.set(c.logo, img);
    }
    res.set({ 'Content-Type': /^image\//.test(img.type) ? img.type : 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }).send(img.buf);
  }));
  return { migrate, setup, activeClubs, botName: () => NAME };
};
