/* Second Telegram bot for table tennis clubs and table-rental places.
   An owner fills a short form in the bot; the request goes to the admin's chat;
   the admin approves it with /approve <id> and the club appears under «Где» in the app.
   Env: CLUBS_BOT_TOKEN (from @BotFather), CLUBS_ADMIN_CODE (secret for "/admin <code>"). */
const crypto = require('crypto');

module.exports = function clubs({ app, q, wrap, APP_URL, SECRET, CITIES }) {
  const TOKEN = process.env.CLUBS_BOT_TOKEN || '';
  const ADMIN_CODE = process.env.CLUBS_ADMIN_CODE || '';
  const HOOK = crypto.createHash('sha256').update('clubs:' + SECRET).digest('hex').slice(0, 32);
  let NAME = '';
  const h = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  async function call(method, body) {
    if (!TOKEN) return null;
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return await r.json();
    } catch (e) { console.error('clubs bot:', method, e.message); return null; }
  }
  const kb = rows => ({ keyboard: rows.map(r => r.map(t => typeof t === 'string' ? { text: t } : t)), resize_keyboard: true, one_time_keyboard: true });
  const NOKB = { remove_keyboard: true };
  const send = (chat, html, markup) => call('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup });

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
    `);
  }

  async function setup() {
    if (!TOKEN) { console.log('Clubs bot: CLUBS_BOT_TOKEN not set, disabled'); return; }
    const me = await call('getMe', {});
    if (!me || !me.ok) { console.error('Clubs bot: token rejected'); return; }
    NAME = me.result.username;
    if (/^https:/.test(APP_URL)) {
      const r = await call('setWebhook', { url: `${APP_URL}/tgc/${HOOK}`, secret_token: HOOK, allowed_updates: ['message'], drop_pending_updates: true });
      console.log('Clubs bot: @' + NAME + (r && r.ok ? ' ready' : ' webhook failed: ' + (r && r.description)));
    }
    await call('setMyCommands', { commands: [{ command: 'start', description: 'Добавить клуб в Подача FIT' }] });
    await call('setMyShortDescription', { short_description: 'Добавьте свой клуб настольного тенниса или столы в аренду в Подача FIT 🏓 Игроки найдут вас в один тап' });
    await call('setMyDescription', { description: '🏓 Подача FIT — приложение, где игроки в настольный теннис находят соперников и бросают вызовы.\n\nКогда игрок создаёт вызов, он выбирает, где играть. Добавьте свой клуб или зал со столами в аренду — и игроки вашего города выберут вас в один тап.\n\nНажмите «Start» и ответьте на 5 коротких вопросов. Мы свяжемся с вами.' });
  }

  const adminChat = async () => ((await q(`SELECT value FROM settings WHERE key='clubs_admin_chat'`)).rows[0] || {}).value || null;
  const setStep = (chat, step, data) => q(`INSERT INTO club_chats (chat, step, data, updated_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (chat) DO UPDATE SET step=$2, data=$3, updated_at=now()`, [chat, step, JSON.stringify(data || {})]);
  const getStep = async chat => (await q('SELECT step, data FROM club_chats WHERE chat=$1', [chat])).rows[0] || { step: 0, data: {} };
  const cityKb = () => { const rows = []; for (let i = 0; i < CITIES.length; i += 2) rows.push(CITIES.slice(i, i + 2)); return kb(rows); };
  const summary = d => `<b>${h(d.name)}</b>\n📍 ${h(d.city)}, ${h(d.address)}\n🏓 ${h(d.info || '—')}\n📞 ${h(d.contact)}`;
  const clip = (t, n) => String(t || '').trim().slice(0, n);

  async function start(chat) {
    await setStep(chat, 1, {});
    return send(chat, 'Здравствуйте! Это бот <b>Подача FIT</b> для клубов 🏓\n\nКогда игрок бросает вызов в Подаче, он выбирает, где играть. Добавим ваш клуб в список — и игроки вашего города выберут вас в один тап.\n\nОтветьте на 5 коротких вопросов.\n\n<b>1/5.</b> Как называется клуб или зал?', NOKB);
  }

  async function admin(chat, text, from) {
    const [cmd, arg] = text.split(/\s+/, 2);
    if (cmd === '/requests') {
      const r = (await q(`SELECT * FROM clubs WHERE status='pending' ORDER BY id LIMIT 20`)).rows;
      return send(chat, r.length ? r.map(c => `#${c.id}\n${summary(c)}${c.tg_user ? '\n✈️ @' + h(c.tg_user) : ''}`).join('\n\n') + '\n\n/approve ID · /reject ID' : 'Новых заявок нет.');
    }
    if (cmd === '/clubs') {
      const r = (await q(`SELECT * FROM clubs WHERE status='active' ORDER BY city, name LIMIT 100`)).rows;
      return send(chat, r.length ? r.map(c => `#${c.id} <b>${h(c.name)}</b> — ${h(c.city)}, ${h(c.address)}`).join('\n') + '\n\n/remove ID — убрать из приложения' : 'В приложении пока нет клубов.');
    }
    const id = parseInt(arg, 10);
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
    const chat = msg.chat.id, text = typeof msg.text === 'string' ? msg.text.trim() : '';
    // admin: "/admin <code>" once, then /requests /approve /reject /clubs /remove
    if (ADMIN_CODE && /^\/admin\s+/.test(text)) {
      if (text.split(/\s+/)[1] !== ADMIN_CODE) return send(chat, 'Неверный код.');
      await q(`INSERT INTO settings (key, value) VALUES ('clubs_admin_chat', $1) ON CONFLICT (key) DO UPDATE SET value=$1`, [String(chat)]);
      return send(chat, '✅ Этот чат получает заявки клубов.\n\n/requests — новые заявки\n/approve ID — добавить в приложение\n/reject ID — отклонить\n/clubs — клубы в приложении\n/remove ID — убрать');
    }
    if (String(chat) === String(await adminChat()) && /^\/(requests|approve|reject|clubs|remove)\b/.test(text)) return admin(chat, text, msg.from);
    if (/^\/start/.test(text) || text === '✏️ Заполнить заново') return start(chat);

    const st = await getStep(chat), d = st.data || {};
    if (!st.step) return start(chat);
    if (st.step === 1) {
      if (!text) return send(chat, 'Напишите название клуба текстом.');
      d.name = clip(text, 60); await setStep(chat, 2, d);
      return send(chat, '<b>2/5.</b> В каком городе?', cityKb());
    }
    if (st.step === 2) {
      if (!CITIES.includes(text)) return send(chat, 'Выберите город кнопкой ниже.', cityKb());
      d.city = text; await setStep(chat, 3, d);
      return send(chat, '<b>3/5.</b> Адрес или ориентир — как игрокам вас найти?\nНапример: <i>ул. Амира Темура, 15, 2 этаж</i>', NOKB);
    }
    if (st.step === 3) {
      if (text.length < 4) return send(chat, 'Напишите адрес чуть подробнее.');
      d.address = clip(text, 120); await setStep(chat, 4, d);
      return send(chat, '<b>4/5.</b> Сколько столов и сколько стоит час игры?\nНапример: <i>6 столов, 40 000 сум/час</i>', kb([['Пропустить']]));
    }
    if (st.step === 4) {
      d.info = text === 'Пропустить' ? '' : clip(text, 120); await setStep(chat, 5, d);
      return send(chat, '<b>5/5.</b> Как с вами связаться? Отправьте номер кнопкой ниже или напишите телефон / @username.',
        kb([[{ text: '📱 Отправить мой номер', request_contact: true }]]));
    }
    if (st.step === 5) {
      const c = msg.contact && msg.contact.phone_number ? '+' + String(msg.contact.phone_number).replace(/^\+/, '') : clip(text, 60);
      if (!c) return send(chat, 'Отправьте номер кнопкой или напишите контакт текстом.');
      d.contact = c; await setStep(chat, 6, d);
      return send(chat, 'Проверьте заявку:\n\n' + summary(d), kb([['✅ Отправить заявку'], ['✏️ Заполнить заново']]));
    }
    if (st.step === 6) {
      if (text !== '✅ Отправить заявку') return send(chat, 'Нажмите «✅ Отправить заявку» или «✏️ Заполнить заново».', kb([['✅ Отправить заявку'], ['✏️ Заполнить заново']]));
      const open = +(await q(`SELECT count(*) FROM clubs WHERE tg_chat=$1 AND status='pending'`, [chat])).rows[0].count;
      if (open >= 3) { await setStep(chat, 0, {}); return send(chat, 'У вас уже есть заявки на рассмотрении. Мы скоро свяжемся с вами.', NOKB); }
      const user = msg.from && msg.from.username ? msg.from.username : null;
      const c = (await q(`INSERT INTO clubs (name, city, address, info, contact, tg_user, tg_chat) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [d.name, d.city, d.address, d.info || null, d.contact, user, chat])).rows[0];
      await setStep(chat, 0, {});
      await send(chat, 'Спасибо! Заявка отправлена 🙌\nМы свяжемся с вами в ближайшее время. Новую заявку можно отправить командой /start.', NOKB);
      const ad = await adminChat();
      if (ad) await send(ad, `🆕 Заявка клуба #${c.id}\n\n${summary(c)}${user ? '\n✈️ @' + h(user) : ''}\n\n/approve ${c.id} — добавить в приложение\n/reject ${c.id} — отклонить`);
      else console.log(`Clubs bot: new request #${c.id} (no admin chat yet — send "/admin <code>" to the clubs bot)`);
      return;
    }
  }));

  const activeClubs = async () => (await q(`SELECT id, name, city, address FROM clubs WHERE status='active' ORDER BY name LIMIT 300`)).rows;
  return { migrate, setup, activeClubs, botName: () => NAME };
};
