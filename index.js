// ============================================================
//  NUURA — бот записи + API для сайта
//  Всё управление кнопками, команды не нужны.
// ============================================================
const { Bot, InlineKeyboard, Keyboard, InputFile } = require('grammy');
const express = require('express');
const cors = require('cors');

const store = require('./data');
const T = require('./slots');

const db = store.load();

// ---------- переменные окружения ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const API_KEY = process.env.API_KEY || 'change-me';
const SITE_ORIGIN = process.env.SITE_ORIGIN || '*';
const SITE_URL = process.env.SITE_URL || '';
const BOT_USERNAME = process.env.BOT_USERNAME || 'nuuranail_bot';
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('Нет BOT_TOKEN в переменных окружения');
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const isAdmin = id => ADMIN_IDS.includes(String(id));
const money = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function serviceName(id) {
  const s = db.services.find(x => x.id === id);
  return s ? s.name : id;
}
function masterName(id) {
  const m = db.masters.find(x => x.id === id);
  return m ? m.name : id;
}

// ============================================================
//  КЛАВИАТУРЫ ВНИЗУ ЭКРАНА
// ============================================================
const BTN = {
  book: '📅 Записаться',
  mine: '🗓 Мои записи',
  contacts: '📍 Контакты',
  // админ
  sched: '📅 Расписание',
  books: '📋 Записи',
  clients: '👥 Клиенты',
  stats: '📊 Статистика',
  export: '⬇️ Выгрузка',
  settings: '⚙️ Настройки',
};

function clientKb() {
  return new Keyboard()
    .text(BTN.book).row()
    .text(BTN.mine).text(BTN.contacts)
    .resized().persistent();
}

function adminKb() {
  return new Keyboard()
    .text(BTN.sched).text(BTN.books).row()
    .text(BTN.clients).text(BTN.stats).row()
    .text(BTN.export).text(BTN.settings)
    .resized().persistent();
}

const kbFor = id => (isAdmin(id) ? adminKb() : clientKb());

// ============================================================
//  API ДЛЯ САЙТА
// ============================================================
const app = express();
app.use(express.json());
app.use(cors({ origin: SITE_ORIGIN === '*' ? true : SITE_ORIGIN.split(',').map(s => s.trim()) }));

function auth(req, res, next) {
  if (req.get('X-API-Key') !== API_KEY) return res.status(401).json({ error: 'Неверный ключ' });
  next();
}

app.get('/', (req, res) => res.send('NUURA bot is running'));

app.get('/api/config', auth, (req, res) => {
  res.json({
    salon: db.salon,
    services: db.services,
    masters: db.masters,
    dates: T.dateRange(db.salon.horizonDays).map(d => ({
      date: d,
      label: T.shortDate(d),
      dow: ['вс','пн','вт','ср','чт','пт','сб'][T.dowOf(d)],
    })),
    botUsername: BOT_USERNAME,
  });
});

app.get('/api/slots', auth, (req, res) => {
  const { master, date, service } = req.query;
  if (!master || !date) return res.status(400).json({ error: 'Нужны master и date' });
  res.json({ slots: T.freeSlots(db, master, date, service) });
});

app.post('/api/book', auth, (req, res) => {
  const { service, master, date, time, name, phone } = req.body || {};
  if (!service || !master || !date || !time || !name || !phone) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  if (!db.services.find(s => s.id === service)) return res.status(400).json({ error: 'Нет такой услуги' });
  if (!db.masters.find(m => m.id === master)) return res.status(400).json({ error: 'Нет такого мастера' });
  if (!T.freeSlots(db, master, date, service).includes(time)) {
    return res.status(409).json({ error: 'Это время уже заняли. Выберите другое.' });
  }

  const booking = createBooking({
    service, master, date, time,
    name, phone,
    source: req.body.source || 'site',
  });

  res.json({
    ok: true,
    bookingId: booking.id,
    remindUrl: `https://t.me/${BOT_USERNAME}?start=${booking.id}`,
    summary: {
      service: serviceName(service), master: masterName(master),
      date: T.prettyDate(date), time,
    },
  });
});

app.listen(PORT, () => console.log('API слушает порт', PORT));

// ============================================================
//  СОЗДАНИЕ ЗАПИСИ (общее для сайта и бота)
// ============================================================
function createBooking({ service, master, date, time, name, phone, source, chatId }) {
  const booking = {
    id: 'B' + (db.seq++),
    service, master, date, time,
    name: String(name).slice(0, 60),
    phone: String(phone).slice(0, 30),
    status: 'active',
    chatId: chatId || null,
    remindedAt: null,
    source: source || 'bot',
    createdAt: new Date().toISOString(),
  };
  db.bookings.push(booking);
  store.save();

  notifyAdmins(
    `🔔 <b>Новая запись</b>\n\n` +
    `Гость: <b>${esc(booking.name)}</b>\n` +
    `Телефон: ${esc(booking.phone)}\n` +
    `Услуга: ${esc(serviceName(service))}\n` +
    `Мастер: ${esc(masterName(master))}\n` +
    `Когда: <b>${T.prettyDate(date)}, ${time}</b>\n` +
    `Источник: ${esc(booking.source)}`
  );
  return booking;
}

async function notifyAdmins(text) {
  for (const id of ADMIN_IDS) {
    try { await bot.api.sendMessage(id, text, { parse_mode: 'HTML' }); }
    catch (e) { console.error('Не отправилось админу', id, e.message); }
  }
}

// ============================================================
//  ЭКРАНЫ АДМИНКИ (общие для кнопок внизу и инлайна)
// ============================================================
function viewBooks() {
  const today = T.nowTashkent().date;
  const list = db.bookings
    .filter(b => b.status === 'active' && b.date >= today)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .slice(0, 15);

  if (!list.length) return { text: 'Пока записей нет.', kb: new InlineKeyboard() };

  let text = '<b>Ближайшие записи</b>\n\n';
  const kb = new InlineKeyboard();
  for (const b of list) {
    text += `${T.shortDate(b.date)} ${b.time} · <b>${esc(b.name)}</b>\n` +
            `<i>${esc(masterName(b.master))} · ${esc(serviceName(b.service))} · ${esc(b.phone)}</i>\n\n`;
    kb.text(`✖ ${T.shortDate(b.date)} ${b.time} ${b.name}`.slice(0, 38), `a_cancel_${b.id}`).row();
  }
  return { text, kb };
}

function viewMasters() {
  const kb = new InlineKeyboard();
  db.masters.forEach(m => kb.text(m.name, `a_sm_${m.id}`).row());
  return { text: 'Выберите мастера:', kb };
}

function viewClients() {
  const map = new Map();
  db.bookings.forEach(b => {
    if (!map.has(b.phone)) map.set(b.phone, { name: b.name, phone: b.phone, count: 0, last: '' });
    const c = map.get(b.phone);
    c.count++;
    if (b.date > c.last) c.last = b.date;
  });
  const list = [...map.values()].sort((a, b) => b.count - a.count).slice(0, 30);
  let text = `<b>Клиенты · ${map.size}</b>\n\n`;
  if (!list.length) text += 'Пока пусто.';
  list.forEach(c => {
    text += `${esc(c.name)} — ${esc(c.phone)}\n<i>визитов: ${c.count}, последний ${T.shortDate(c.last)}</i>\n\n`;
  });
  return { text, kb: new InlineKeyboard() };
}

function viewStats() {
  const all = db.bookings;
  const cnt = s => all.filter(b => b.status === s).length;

  let text = `<b>Статистика</b>\n\n`;
  text += `Всего записей: <b>${all.length}</b>\n`;
  text += `Активных: ${cnt('active')}\nОтмен: ${cnt('cancelled')}\nНеявок: ${cnt('noshow')}\n\n`;

  text += `<b>По мастерам</b>\n`;
  db.masters.forEach(m => {
    text += `${esc(m.name)}: ${all.filter(b => b.master === m.id).length}\n`;
  });

  text += `\n<b>Откуда пришли</b>\n`;
  const src = {};
  all.forEach(b => { src[b.source || 'site'] = (src[b.source || 'site'] || 0) + 1; });
  Object.entries(src).forEach(([k, v]) => { text += `${esc(k)}: ${v}\n`; });

  text += `\nПодключили напоминание: ${all.filter(b => b.chatId).length} из ${all.length}`;
  return { text, kb: new InlineKeyboard() };
}

function viewSettings() {
  let text = `<b>Настройки</b>\n\n`;
  text += `Часы работы: ${db.salon.hours.start}–${db.salon.hours.end}\n`;
  text += `Шаг записи: ${db.salon.stepMin} мин\nГоризонт: ${db.salon.horizonDays} дней\n\n`;
  text += `<b>Услуги</b>\n`;
  db.services.forEach(s => { text += `${esc(s.name)} — ${s.duration} мин, ${money(s.price)} сум\n`; });
  text += `\n<b>Мастера</b>\n`;
  db.masters.forEach(m => { text += `${esc(m.name)} — ${m.services.map(serviceName).join(', ')}\n`; });
  text += `\n<i>Чтобы изменить — напишите разработчику.</i>`;
  return { text, kb: new InlineKeyboard() };
}

async function exportCsv(ctx) {
  const head = 'Дата;Время;Имя;Телефон;Услуга;Мастер;Статус;Источник\n';
  const rows = db.bookings.map(b =>
    [b.date, b.time, b.name, b.phone, serviceName(b.service),
     masterName(b.master), b.status, b.source || 'site'].join(';')
  ).join('\n');
  const buf = Buffer.from('﻿' + head + rows, 'utf8');
  await ctx.replyWithDocument(new InputFile(buf, `nuura-zapisi-${T.nowTashkent().date}.csv`));
}

// ============================================================
//  ЭКРАНЫ КЛИЕНТА
// ============================================================
function viewMine(chatId) {
  const today = T.nowTashkent().date;
  const list = db.bookings
    .filter(b => b.chatId === chatId && b.status === 'active' && b.date >= today)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  if (!list.length) {
    return { text: 'У вас пока нет активных записей.', kb: new InlineKeyboard() };
  }
  let text = '<b>Ваши записи</b>\n\n';
  const kb = new InlineKeyboard();
  list.forEach(b => {
    text += `${T.prettyDate(b.date)}, <b>${b.time}</b>\n` +
            `${esc(serviceName(b.service))} · ${esc(masterName(b.master))}\n\n`;
    kb.text(`Отменить ${T.shortDate(b.date)} ${b.time}`, `cl_no_${b.id}`).row();
  });
  return { text, kb };
}

function viewContacts() {
  let text = `<b>${esc(db.salon.name)}</b>\n${esc(db.salon.city)}\n\n`;
  text += `Часы работы: ${db.salon.hours.start}–${db.salon.hours.end}\n\n`;
  text += `<b>Услуги</b>\n`;
  db.services.forEach(s => { text += `${esc(s.name)} — ${money(s.price)} сум\n`; });
  return { text, kb: new InlineKeyboard() };
}

// ============================================================
//  ЗАПИСЬ ВНУТРИ БОТА (пошагово, кнопками)
// ============================================================
const draft = new Map();   // chatId -> { service, master, date, time, name, phone, step }

function startBooking(ctx) {
  draft.set(ctx.chat.id, { step: 'service' });
  const kb = new InlineKeyboard();
  db.services.forEach(s => kb.text(`${s.name} · ${money(s.price)}`, `bk_s_${s.id}`).row());
  return ctx.reply('Что вас интересует?', { reply_markup: kb });
}

bot.callbackQuery(/^bk_s_(.+)$/, async ctx => {
  const d = draft.get(ctx.chat.id) || {};
  d.service = ctx.match[1]; d.step = 'master';
  draft.set(ctx.chat.id, d);
  await ctx.answerCallbackQuery();

  const list = db.masters.filter(m => m.services.includes(d.service));
  const kb = new InlineKeyboard();
  list.forEach(m => kb.text(m.name, `bk_m_${m.id}`).row());
  kb.text('← Назад', 'bk_back_service');
  await ctx.editMessageText(`${serviceName(d.service)}\n\nВыберите мастера:`, { reply_markup: kb });
});

bot.callbackQuery('bk_back_service', async ctx => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard();
  db.services.forEach(s => kb.text(`${s.name} · ${money(s.price)}`, `bk_s_${s.id}`).row());
  await ctx.editMessageText('Что вас интересует?', { reply_markup: kb });
});

bot.callbackQuery(/^bk_m_(.+)$/, async ctx => {
  const d = draft.get(ctx.chat.id) || {};
  d.master = ctx.match[1]; d.step = 'date';
  draft.set(ctx.chat.id, d);
  await ctx.answerCallbackQuery();
  await showDates(ctx, d);
});

async function showDates(ctx, d) {
  const kb = new InlineKeyboard();
  let shown = 0;
  for (const date of T.dateRange(db.salon.horizonDays)) {
    const free = T.freeSlots(db, d.master, date, d.service).length;
    if (!free) continue;
    kb.text(`${T.shortDate(date)} · ${free}`, `bk_d_${date}`);
    shown++;
    if (shown % 2 === 0) kb.row();
  }
  kb.row().text('← Назад', `bk_s_${d.service}`);
  await ctx.editMessageText(
    `${serviceName(d.service)} · ${masterName(d.master)}\n\nВыберите день (цифра — сколько свободных окон):`,
    { reply_markup: kb }
  );
}

bot.callbackQuery(/^bk_d_(.+)$/, async ctx => {
  const d = draft.get(ctx.chat.id) || {};
  d.date = ctx.match[1]; d.step = 'time';
  draft.set(ctx.chat.id, d);
  await ctx.answerCallbackQuery();

  const slots = T.freeSlots(db, d.master, d.date, d.service);
  const kb = new InlineKeyboard();
  slots.forEach((t, i) => {
    kb.text(t, `bk_t_${t}`);
    if (i % 4 === 3) kb.row();
  });
  kb.row().text('← Назад', `bk_m_${d.master}`);
  await ctx.editMessageText(
    `${masterName(d.master)} · ${T.prettyDate(d.date)}\n\nВыберите время:`,
    { reply_markup: kb }
  );
});

bot.callbackQuery(/^bk_t_(.+)$/, async ctx => {
  const d = draft.get(ctx.chat.id) || {};
  d.time = ctx.match[1]; d.step = 'name';
  draft.set(ctx.chat.id, d);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `${serviceName(d.service)}\n${masterName(d.master)} · ${T.prettyDate(d.date)}, ${d.time}\n\n` +
    `Как вас зовут? Напишите имя сообщением.`
  );
});

bot.callbackQuery(/^bk_confirm$/, async ctx => {
  const d = draft.get(ctx.chat.id);
  if (!d || !d.phone) return ctx.answerCallbackQuery('Что-то пошло не так, начните заново');

  if (!T.freeSlots(db, d.master, d.date, d.service).includes(d.time)) {
    draft.delete(ctx.chat.id);
    await ctx.answerCallbackQuery();
    return ctx.editMessageText('Это время только что заняли. Начните запись заново.');
  }

  const b = createBooking({
    service: d.service, master: d.master, date: d.date, time: d.time,
    name: d.name, phone: d.phone, source: 'bot', chatId: ctx.chat.id,
  });
  draft.delete(ctx.chat.id);
  await ctx.answerCallbackQuery('Записали!');
  await ctx.editMessageText(
    `✅ <b>Записали вас</b>\n\n` +
    `${esc(serviceName(b.service))}\nМастер: ${esc(masterName(b.master))}\n` +
    `${T.prettyDate(b.date)}, <b>${b.time}</b>\n\n` +
    `Напомню за два часа до визита.`,
    { parse_mode: 'HTML' }
  );
});

bot.callbackQuery('bk_cancel', async ctx => {
  draft.delete(ctx.chat.id);
  await ctx.answerCallbackQuery('Отменено');
  await ctx.editMessageText('Запись отменена. Можете начать заново кнопкой внизу.');
});

// ============================================================
//  /start — вход
// ============================================================
bot.command('start', async ctx => {
  const payload = (ctx.match || '').trim();

  // пришёл по ссылке с сайта — подключаем напоминание
  if (payload && payload.startsWith('B')) {
    const b = db.bookings.find(x => x.id === payload);
    if (!b) return ctx.reply('Не нашёл такую запись. Возможно, она уже отменена.', { reply_markup: clientKb() });
    b.chatId = ctx.chat.id;
    store.save();
    return ctx.reply(
      `Готово! Напомню за 2 часа до визита.\n\n` +
      `${serviceName(b.service)}\nМастер: ${masterName(b.master)}\n${T.prettyDate(b.date)}, ${b.time}`,
      { reply_markup: clientKb() }
    );
  }

  if (isAdmin(ctx.from.id)) {
    return ctx.reply(`Панель управления · ${db.salon.name}\n\nВыбирайте кнопками внизу.`,
      { reply_markup: adminKb() });
  }

  return ctx.reply(
    `Здравствуйте! Это запись в студию ${db.salon.name}.\n\n` +
    `Нажмите «Записаться» — это меньше минуты.`,
    { reply_markup: clientKb() }
  );
});

// ============================================================
//  ОБРАБОТКА НАЖАТИЙ НА КНОПКИ ВНИЗУ + ввод имени/телефона
// ============================================================
bot.on('message:contact', async ctx => {
  const d = draft.get(ctx.chat.id);
  if (!d || d.step !== 'phone') return;
  d.phone = ctx.message.contact.phone_number;
  d.step = 'confirm';
  draft.set(ctx.chat.id, d);
  await askConfirm(ctx, d);
});

async function askConfirm(ctx, d) {
  const kb = new InlineKeyboard()
    .text('✅ Подтвердить', 'bk_confirm').row()
    .text('Отменить', 'bk_cancel');
  await ctx.reply(
    `<b>Проверьте, всё ли верно</b>\n\n` +
    `Услуга: ${esc(serviceName(d.service))}\n` +
    `Мастер: ${esc(masterName(d.master))}\n` +
    `Когда: <b>${T.prettyDate(d.date)}, ${d.time}</b>\n` +
    `Имя: ${esc(d.name)}\nТелефон: ${esc(d.phone)}`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

bot.on('message:text', async ctx => {
  const txt = ctx.message.text.trim();
  const admin = isAdmin(ctx.from.id);

  // --- сначала: идёт ли сейчас ввод имени/телефона ---
  const d = draft.get(ctx.chat.id);
  if (d && d.step === 'name' && !Object.values(BTN).includes(txt)) {
    d.name = txt; d.step = 'phone';
    draft.set(ctx.chat.id, d);
    const kb = new Keyboard().requestContact('📱 Отправить мой номер').resized().oneTime();
    return ctx.reply(
      `Приятно познакомиться, ${esc(txt)}!\n\nТеперь номер телефона — нажмите кнопку или напишите вручную.`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  }
  if (d && d.step === 'phone' && !Object.values(BTN).includes(txt)) {
    d.phone = txt; d.step = 'confirm';
    draft.set(ctx.chat.id, d);
    await ctx.reply('Принято', { reply_markup: kbFor(ctx.from.id) });
    return askConfirm(ctx, d);
  }

  // --- кнопки клиента ---
  if (txt === BTN.book) return startBooking(ctx);

  if (txt === BTN.mine) {
    const v = viewMine(ctx.chat.id);
    return ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.kb });
  }
  if (txt === BTN.contacts) {
    const v = viewContacts();
    return ctx.reply(v.text, { parse_mode: 'HTML' });
  }

  // --- кнопки админа ---
  if (admin) {
    if (txt === BTN.books)    { const v = viewBooks();    return ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.kb }); }
    if (txt === BTN.sched)    { const v = viewMasters();  return ctx.reply(v.text, { reply_markup: v.kb }); }
    if (txt === BTN.clients)  { const v = viewClients();  return ctx.reply(v.text, { parse_mode: 'HTML' }); }
    if (txt === BTN.stats)    { const v = viewStats();    return ctx.reply(v.text, { parse_mode: 'HTML' }); }
    if (txt === BTN.settings) { const v = viewSettings(); return ctx.reply(v.text, { parse_mode: 'HTML' }); }
    if (txt === BTN.export)   return exportCsv(ctx);
  }

  // --- всё остальное ---
  return ctx.reply('Выбирайте кнопками внизу 👇', { reply_markup: kbFor(ctx.from.id) });
});

// ============================================================
//  АДМИН: расписание
// ============================================================
bot.callbackQuery(/^a_sm_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  const mid = ctx.match[1];
  const kb = new InlineKeyboard();
  T.dateRange(10).forEach((d, i) => {
    kb.text(T.shortDate(d), `a_sd_${mid}_${d}`);
    if (i % 3 === 2) kb.row();
  });
  await ctx.editMessageText(`${masterName(mid)} — выберите день:`, { reply_markup: kb });
});

bot.callbackQuery(/^a_sd_([^_]+)_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  await showDay(ctx, ctx.match[1], ctx.match[2]);
});

async function showDay(ctx, mid, date) {
  const slots = T.daySlots(db, mid, date);
  const kb = new InlineKeyboard();
  slots.forEach((s, i) => {
    const mark = s.state === 'booked' ? '🔴' : s.state === 'closed' ? '⚪️' : '🟢';
    kb.text(`${mark} ${s.time}`, s.state === 'booked' ? 'a_noop' : `a_tg_${mid}_${date}_${s.time}`);
    if (i % 4 === 3) kb.row();
  });
  kb.row().text('← К мастерам', 'a_sched_back');
  const text = `<b>${masterName(mid)} · ${T.prettyDate(date)}</b>\n\n` +
               `🟢 свободно · ⚪️ закрыто · 🔴 занято\n` +
               `Нажмите на время, чтобы открыть или закрыть окно.`;
  try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }); } catch (e) {}
}

bot.callbackQuery('a_sched_back', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  const v = viewMasters();
  await ctx.editMessageText(v.text, { reply_markup: v.kb });
});

bot.callbackQuery('a_noop', ctx => ctx.answerCallbackQuery('Это время занято записью'));

bot.callbackQuery(/^a_tg_([^_]+)_([^_]+)_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  const [, mid, date, time] = ctx.match;
  db.closed[mid] = db.closed[mid] || {};
  db.closed[mid][date] = db.closed[mid][date] || [];
  const arr = db.closed[mid][date];
  const i = arr.indexOf(time);
  if (i >= 0) arr.splice(i, 1); else arr.push(time);
  store.save();
  await ctx.answerCallbackQuery(i >= 0 ? 'Открыто' : 'Закрыто');
  await showDay(ctx, mid, date);
});

// АДМИН: отмена записи
bot.callbackQuery(/^a_cancel_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  const b = db.bookings.find(x => x.id === ctx.match[1]);
  if (!b) return ctx.answerCallbackQuery('Не найдено');
  b.status = 'cancelled';
  store.save();
  await ctx.answerCallbackQuery('Отменено');
  if (b.chatId) {
    try {
      await bot.api.sendMessage(b.chatId,
        `К сожалению, запись на ${T.prettyDate(b.date)} в ${b.time} отменена. Напишите нам, чтобы перенести.`);
    } catch (e) {}
  }
  const v = viewBooks();
  await ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.kb });
});

// ============================================================
//  КЛИЕНТ: подтверждение и отмена из напоминания
// ============================================================
bot.callbackQuery(/^cl_(ok|no)_(.+)$/, async ctx => {
  const [, action, id] = ctx.match;
  const b = db.bookings.find(x => x.id === id);
  if (!b) return ctx.answerCallbackQuery('Запись не найдена');

  if (action === 'ok') {
    b.confirmed = true;
    store.save();
    await ctx.answerCallbackQuery('Спасибо, ждём вас!');
    await ctx.editMessageText('Спасибо, ждём вас! 🙌');
    notifyAdmins(`✅ ${esc(b.name)} подтвердил визит — ${T.prettyDate(b.date)}, ${b.time}`);
  } else {
    b.status = 'cancelled';
    store.save();
    await ctx.answerCallbackQuery('Запись отменена');
    await ctx.editMessageText('Запись отменена. Будем рады видеть вас в другой раз.');
    notifyAdmins(
      `❌ <b>Отмена</b>\n${esc(b.name)} — ${esc(serviceName(b.service))}\n` +
      `${T.prettyDate(b.date)}, ${b.time}\nОкно снова свободно.`
    );
  }
});

// ============================================================
//  НАПОМИНАНИЯ ЗА 2 ЧАСА
// ============================================================
setInterval(async () => {
  const now = T.nowTashkent();
  for (const b of db.bookings) {
    if (b.status !== 'active' || !b.chatId || b.remindedAt) continue;
    if (b.date !== now.date) continue;

    const diff = T.toMin(b.time) - now.min;
    if (diff <= 120 && diff > 0) {
      try {
        await bot.api.sendMessage(b.chatId,
          `Напоминаем о визите сегодня в <b>${b.time}</b>\n\n` +
          `${esc(serviceName(b.service))}\nМастер: ${esc(masterName(b.master))}\n\nВсё в силе?`,
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
              .text('Приду', `cl_ok_${b.id}`)
              .text('Не смогу', `cl_no_${b.id}`),
          });
        b.remindedAt = new Date().toISOString();
        store.save();
      } catch (e) { console.error('Напоминание не ушло:', e.message); }
    }
  }
}, 60000);

// ============================================================
bot.catch(err => console.error('Ошибка бота:', err));

bot.api.setMyCommands([{ command: 'start', description: 'Начать' }]).catch(() => {});
bot.start();
console.log('Бот запущен');
