// ============================================================================
//  index.js — главный файл бота записи для студии "the name uz"
//
//  Что здесь происходит по порядку:
//    1. Настройки и запуск
//    2. Тревоги о поломках (только мне, не владельцу студии)
//    3. Работа с расписанием и записями
//    4. Экраны для клиента
//    5. Экраны для админа
//    6. Рассылка
//    7. Автоматика (напоминания, горизонт записи)
//    8. Ловля ошибок и старт
// ============================================================================

const {
  Bot,
  InlineKeyboard,
  Keyboard,
  InputFile,
  GrammyError,
  HttpError,
} = require('grammy');

const config = require('./config');
const U = require('./utils');
const db = require('./db');
const seed = require('./seed');

// ---------------------------------------------------------------------------
//  1. НАСТРОЙКИ И ЗАПУСК
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ Не задана переменная BOT_TOKEN. Бот не может запуститься.');
  process.exit(1);
}

function parseIds(str) {
  return String(str || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
}

const ADMIN_IDS = parseIds(process.env.ADMIN_IDS);
// Адрес мини-аппа (страница на Cloudflare Pages). Не задан — кнопки просто нет.
const MINIAPP_URL = (process.env.MINIAPP_URL || '').trim();
const TECH_IDS = parseIds(process.env.TECH_IDS);

const bot = new Bot(BOT_TOKEN);

db.load();
const d = () => db.data; // короткая запись: d().bookings и т.д.

const esc = U.escapeHtml;

// Настоящий владелец бота — может менять и рассылать.
const isRealAdmin = (id) => ADMIN_IDS.includes(Number(id));

// Кто видит админку. В демо-режиме — все, но только для просмотра.
const isAdmin = (id) => isRealAdmin(id) || !!config.OPEN_ADMIN;

// Гостю показываем только вымышленные данные, чтобы телефоны реальных людей,
// заглянувших в демо, не увидел посторонний.
function visibleBookings(userId) {
  const all = d().bookings;
  return isRealAdmin(userId) ? all : all.filter((b) => b.demo);
}
function visibleClients(userId) {
  const all = Object.values(d().clients);
  return isRealAdmin(userId) ? all : all.filter((c) => c.demo);
}

// Временное состояние диалога (в памяти). Пропадает при перезапуске — это ок,
// клиент просто начнёт запись заново.
const state = new Map();

// Дизайн, выбранный в мини-аппе. Живёт час, потом забывается.
const wantedDesign = new Map();
function setDesign(userId, name) {
  if (name) wantedDesign.set(String(userId), { name, ts: Date.now() });
}
function takeDesign(userId) {
  const v = wantedDesign.get(String(userId));
  wantedDesign.delete(String(userId));
  if (!v || Date.now() - v.ts > 60 * 60 * 1000) return '';
  return v.name;
}
const getState = (id) => state.get(String(id)) || null;
const setState = (id, v) => state.set(String(id), v);
const clearState = (id) => state.delete(String(id));

// Отложенное сохранение: мелочи копим и пишем раз в 3 секунды,
// важное (записи, отмены) сохраняем сразу.
let dirty = false;
const touch = () => {
  dirty = true;
};
setInterval(() => {
  if (dirty) {
    dirty = false;
    db.save();
  }
}, 3000);

// ---------------------------------------------------------------------------
//  2. ТРЕВОГИ О ПОЛОМКАХ
// ---------------------------------------------------------------------------

const alertTimes = new Map(); // чтобы одна и та же ошибка не пришла 100 раз

async function techAlert(title, detail, who) {
  const key = title + '|' + String(detail).slice(0, 120);
  const last = alertTimes.get(key) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return; // не чаще раза в 10 минут
  alertTimes.set(key, Date.now());

  const targets = TECH_IDS.length ? TECH_IDS : ADMIN_IDS;
  if (!targets.length) return;

  let msg = `🛠 <b>${esc(title)}</b>\n\n<code>${esc(
    String(detail).slice(0, 1500)
  )}</code>`;
  if (who) msg += `\n\n<b>Кто и что делал:</b>\n${esc(who)}`;

  for (const id of targets) {
    try {
      await bot.api.sendMessage(id, msg, { parse_mode: 'HTML' });
    } catch (_) {
      /* если и это не отправилось — молчим, иначе бесконечный цикл */
    }
  }
}

db.onSaveError((e) => {
  techAlert('База не сохранилась на диск', e.message);
});

function whoInfo(ctx) {
  if (!ctx || !ctx.from) return '';
  const what =
    (ctx.callbackQuery && 'кнопка: ' + ctx.callbackQuery.data) ||
    (ctx.message && ctx.message.text && 'текст: ' + ctx.message.text) ||
    'другое действие';
  return `${U.fullName(ctx.from)} (id ${ctx.from.id})\n${what}`;
}

// ---------------------------------------------------------------------------
//  3. РАСПИСАНИЕ, КЛИЕНТЫ, ЗАПИСИ
// ---------------------------------------------------------------------------

const masterById = (id) => config.MASTERS.find((m) => m.id === id) || null;
const masterName = (id) => (masterById(id) ? masterById(id).name : '—');

function ensureDay(mid, date) {
  const data = d();
  if (!data.slots[mid]) data.slots[mid] = {};
  if (!data.slots[mid][date]) data.slots[mid][date] = {};
  const day = data.slots[mid][date];
  for (const t of U.allSlotTimes()) {
    if (!day[t]) day[t] = 'closed';
  }
  return day;
}

function horizonDates() {
  const today = U.todayStr();
  const out = [];
  for (let i = 0; i < config.HORIZON_DAYS; i++) {
    const ds = U.addDays(today, i);
    if (!U.isDayOff(ds)) out.push(ds);
  }
  return out;
}

// Свободные окна мастера на конкретный день (только будущие)
function freeTimes(mid, date) {
  const data = d();
  const day = (data.slots[mid] || {})[date];
  if (!day) return [];
  return U.allSlotTimes().filter(
    (t) => day[t] === 'open' && !U.isPastSlot(date, t)
  );
}

function daysWithFree(mid) {
  return horizonDates().filter((ds) => freeTimes(mid, ds).length > 0);
}

// --- Направления -----------------------------------------------------------
// Собираются автоматически из поля specialty у мастеров в config.js.
// Порядок — как мастера записаны в списке.
function groupList() {
  const out = [];
  for (const m of config.MASTERS) {
    if (!out.includes(m.specialty)) out.push(m.specialty);
  }
  return out;
}

function groupIcon(name) {
  return (config.GROUP_ICONS && config.GROUP_ICONS[name]) || '•';
}

function mastersInGroup(gi) {
  const g = groupList()[gi];
  return config.MASTERS.filter((m) => m.specialty === g);
}

function groupIndexOfMaster(mid) {
  const m = masterById(mid);
  return m ? groupList().indexOf(m.specialty) : -1;
}

function groupHasFree(gi) {
  return mastersInGroup(gi).some((m) => daysWithFree(m.id).length > 0);
}

function mastersWithFree() {
  return config.MASTERS.filter((m) => daysWithFree(m.id).length > 0);
}

function touchClient(from) {
  const data = d();
  const key = String(from.id);
  let c = data.clients[key];
  let changed = false;

  if (!c) {
    c = {
      id: from.id,
      name: U.fullName(from),
      username: from.username || '',
      phone: '',
      firstSeen: Date.now(),
      source: '',
      bookings: 0,
      blocked: false,
    };
    data.clients[key] = c;
    changed = true;
  }
  const nm = U.fullName(from);
  if (c.name !== nm) {
    c.name = nm;
    changed = true;
  }
  if (from.username && c.username !== from.username) {
    c.username = from.username;
    changed = true;
  }
  // человек написал боту — значит, он его не заблокировал
  if (c.blocked) {
    c.blocked = false;
    changed = true;
  }
  if (changed) touch();
  return c;
}

// Создание записи. Возвращает null, если окно уже заняли.
function createBooking(from, mid, date, time, phone) {
  const day = ensureDay(mid, date);
  if (day[time] !== 'open' || U.isPastSlot(date, time)) return null;

  day[time] = 'booked';

  const c = touchClient(from);
  const isFirst = (c.bookings || 0) === 0;
  c.bookings = (c.bookings || 0) + 1;
  c.phone = phone;

  const b = {
    id: db.nextId(),
    masterId: mid,
    date,
    time,
    userId: from.id,
    name: U.fullName(from),
    username: from.username || '',
    phone,
    source: c.source || '',
    design: takeDesign(from.id),
    createdAt: Date.now(),
    status: 'active',
    reminderSent: false,
    rebookSent: false,
  };
  d().bookings.push(b);
  db.save(); // важное — сохраняем немедленно
  return { booking: b, isFirst };
}

function cancelBooking(b) {
  b.status = 'cancelled';
  b.cancelledAt = Date.now();
  const c = d().clients[String(b.userId)];
  if (c && c.bookings > 0) c.bookings--; // отменённый визит не считаем
  const day = (d().slots[b.masterId] || {})[b.date];
  if (day && day[b.time] === 'booked') {
    day[b.time] = U.isPastSlot(b.date, b.time) ? 'closed' : 'open';
  }
  db.save();
}

function activeFutureBookings(userId) {
  return d()
    .bookings.filter(
      (b) =>
        b.userId === Number(userId) &&
        b.status === 'active' &&
        U.slotTimestamp(b.date, b.time) > Date.now()
    )
    .sort(
      (a, z) =>
        U.slotTimestamp(a.date, a.time) - U.slotTimestamp(z.date, z.time)
    );
}

// ---------------------------------------------------------------------------
//  Отправка сообщений с защитой (помечаем тех, кто заблокировал бота)
// ---------------------------------------------------------------------------

function failReason(e) {
  if (e instanceof GrammyError) {
    const t = (e.description || '').toLowerCase();
    if (t.includes('blocked')) return 'заблокировал бота';
    if (t.includes('deactivated')) return 'аккаунт удалён';
    if (t.includes('chat not found')) return 'чат не найден';
    if (e.error_code === 429) return 'лимит Telegram';
    return e.description || 'ошибка Telegram';
  }
  if (e instanceof HttpError) return 'нет связи с Telegram';
  return (e && e.message) || 'неизвестная ошибка';
}

function markBlocked(userId, reason) {
  const c = d().clients[String(userId)];
  if (!c) return;
  if (reason === 'заблокировал бота' || reason === 'аккаунт удалён') {
    c.blocked = true;
    touch();
  }
}

async function safeSend(chatId, text, extra) {
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
    return { ok: true };
  } catch (e) {
    const reason = failReason(e);
    markBlocked(chatId, reason);
    return { ok: false, reason };
  }
}

async function notifyAdmins(text) {
  for (const id of ADMIN_IDS) await safeSend(id, text);
}

// Показать текст: если пришли с кнопки — правим то же сообщение, иначе новое
async function show(ctx, text, kb) {
  const opts = { parse_mode: 'HTML' };
  if (kb) opts.reply_markup = kb;
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(text, opts);
      return;
    } catch (e) {
      const t = (e && e.description) || '';
      if (t.includes('message is not modified')) return;
    }
  }
  await ctx.reply(text, opts);
}

// ---------------------------------------------------------------------------
//  4. ЭКРАНЫ ДЛЯ КЛИЕНТА
// ---------------------------------------------------------------------------

// Постоянное меню внизу экрана. Оно не исчезает и всегда под рукой.
function kbMain(userId) {
  const kb = new Keyboard()
    .text('📝 Записаться')
    .text('📋 Мои записи')
    .row();
  if (MINIAPP_URL) kb.webApp('💅 Дизайны', MINIAPP_URL).text('ℹ️ Помощь');
  else kb.text('ℹ️ Помощь');
  if (isAdmin(userId)) kb.row().text('⚙️ Админка');
  return kb.resized().persistent();
}

// Экран 1 — направления. Если направление всего одно, шаг пропускается.
async function screenMasters(ctx, greeting) {
  if (!mastersWithFree().length) {
    await show(
      ctx,
      '😔 Сейчас свободных окон нет.\n\n' +
        'Расписание обновляется постоянно — загляните чуть позже или напишите администратору.'
    );
    return;
  }

  const groups = groupList();
  const available = groups.map((g, i) => i).filter((i) => groupHasFree(i));

  if (available.length === 1) return screenGroupMasters(ctx, available[0]);

  const kb = new InlineKeyboard();
  for (const i of available) {
    const free = mastersInGroup(i).filter((m) => daysWithFree(m.id).length > 0);
    kb.text(
      `${groupIcon(groups[i])} ${groups[i]} · ${free.length} ` +
        U.pluralRu(free.length, 'мастер', 'мастера', 'мастеров'),
      `bk:g:${i}`
    ).row();
  }

  await show(ctx, greeting || 'Что вас интересует?', kb);
}

// Экран 2 — мастера выбранного направления.
async function screenGroupMasters(ctx, gi) {
  const groups = groupList();
  const name = groups[gi];
  if (!name) return screenMasters(ctx);

  const free = mastersInGroup(gi).filter((m) => daysWithFree(m.id).length > 0);
  if (!free.length) {
    const kb = new InlineKeyboard().text('⬅️ К направлениям', 'bk:masters');
    return show(
      ctx,
      `${groupIcon(name)} <b>${esc(name)}</b>\n\n` +
        'Свободных окон по этому направлению сейчас нет.',
      kb
    );
  }

  const kb = new InlineKeyboard();
  for (const m of free) kb.text(m.name, `bk:m:${m.id}`).row();
  if (groups.length > 1) kb.text('⬅️ К направлениям', 'bk:masters');

  await show(
    ctx,
    `${groupIcon(name)} <b>${esc(name)}</b>\n\nВыберите мастера:`,
    kb
  );
}

async function screenDays(ctx, mid) {
  const m = masterById(mid);
  if (!m) return screenMasters(ctx);

  const days = daysWithFree(mid);
  if (!days.length) {
    const kb = new InlineKeyboard().text(
      '⬅️ К мастерам',
      `bk:g:${groupIndexOfMaster(mid)}`
    );
    await show(
      ctx,
      `<b>${esc(m.name)}</b> · ${esc(m.specialty)}\n\n` +
        'У этого мастера пока нет свободных окон. Выберите другого мастера.',
      kb
    );
    return;
  }

  const kb = new InlineKeyboard();
  days.forEach((ds, i) => {
    const lbl = U.dayLabel(ds);
    const cnt = freeTimes(mid, ds).length;
    const text = `${U.formatDateShort(ds)}${lbl ? ' (' + lbl + ')' : ''} · ${cnt}`;
    kb.text(text, `bk:d:${mid}:${ds}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text('⬅️ К мастерам', `bk:g:${groupIndexOfMaster(mid)}`);

  await show(
    ctx,
    `<b>${esc(m.name)}</b> · ${esc(m.specialty)}\n\n` +
      'Выберите день. Цифра — сколько свободных окон:',
    kb
  );
}

async function screenTimes(ctx, mid, date) {
  const m = masterById(mid);
  if (!m) return screenMasters(ctx);

  const times = freeTimes(mid, date);
  if (!times.length) {
    await ctx.answerCallbackQuery({
      text: 'Этот день только что заняли',
      show_alert: true,
    });
    return screenDays(ctx, mid);
  }

  const kb = new InlineKeyboard();
  times.forEach((t, i) => {
    kb.text(t, `bk:t:${mid}:${date}:${U.encTime(t)}`);
    if (i % 3 === 2) kb.row();
  });
  kb.row().text('⬅️ К дням', `bk:m:${mid}`);

  await show(
    ctx,
    `<b>${esc(m.name)}</b> · ${esc(m.specialty)}\n` +
      `📅 ${U.formatDateFull(date)}\n\n` +
      'Выберите время:',
    kb
  );
}

async function screenAskPhone(ctx, mid, date, time) {
  setState(ctx.from.id, { step: 'phone', mid, date, time });

  await show(
    ctx,
    `<b>${esc(masterName(mid))}</b>\n` +
      `📅 ${U.formatDateFull(date)}\n` +
      `🕒 ${time}\n\n` +
      'Остался последний шаг — номер телефона.'
  );

  const kb = new Keyboard()
    .requestContact('📱 Поделиться номером')
    .row()
    .text('⬅️ Отмена')
    .resized();

  await ctx.reply(
    'Нажмите кнопку ниже или просто напишите номер (например +998 90 123 45 67):',
    { reply_markup: kb }
  );
}

async function screenConfirm(ctx, st) {
  const kb = new InlineKeyboard()
    .text('✅ Подтвердить запись', 'bk:ok')
    .row()
    .text('⬅️ Выбрать другое время', `bk:d:${st.mid}:${st.date}`)
    .row()
    .text('❌ Отменить', 'bk:cancel');

  await ctx.reply(
    'Проверьте, всё ли верно:\n\n' +
      `👩 Мастер: <b>${esc(masterName(st.mid))}</b>\n` +
      `📅 Дата: <b>${U.formatDateFull(st.date)}</b>\n` +
      `🕒 Время: <b>${st.time}</b>\n` +
      `📞 Телефон: <b>${esc(st.phone)}</b>`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

// ---------------------------------------------------------------------------
//  Команды клиента
// ---------------------------------------------------------------------------

bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) touchClient(ctx.from);
  await next();
});

bot.command('start', async (ctx) => {
  clearState(ctx.from.id);

  // метка источника берётся ТОЛЬКО отсюда: t.me/thenameuz_bot?start=instagram
  const src = U.sanitizeSource(ctx.match);
  if (src) {
    const c = touchClient(ctx.from);
    if (!c.source) {
      c.source = src;
      touch();
    }
  }

  await ctx.reply(config.TEXTS.welcome, {
    parse_mode: 'HTML',
    reply_markup: kbMain(ctx.from.id),
  });
  await screenMasters(ctx);
});

bot.command('book', async (ctx) => {
  clearState(ctx.from.id);
  await screenMasters(ctx);
});

async function screenMy(ctx) {
  const list = activeFutureBookings(ctx.from.id);
  if (!list.length) {
    const kb = new InlineKeyboard().text('📝 Записаться', 'bk:masters');
    await ctx.reply('У вас пока нет активных записей.', { reply_markup: kb });
    return;
  }
  let text = '<b>Ваши записи:</b>\n\n';
  const kb = new InlineKeyboard();
  for (const b of list) {
    text +=
      `👩 ${esc(masterName(b.masterId))}\n` +
      `📅 ${U.formatDateFull(b.date)} в ${b.time}\n\n`;
    kb.text(
      `❌ Отменить · ${masterName(b.masterId)}, ${U.formatDateShort(b.date)} ${b.time}`,
      `my:c:${b.id}`
    ).row();
  }
  await ctx.reply(text.trim(), { parse_mode: 'HTML', reply_markup: kb });
}
bot.command('my', screenMy);

async function screenHelp(ctx) {
  let t =
    `<b>${esc(config.STUDIO_NAME)}</b>\n\n` +
    'Проще всего пользоваться кнопками внизу экрана.\n\n' +
    (MINIAPP_URL ? config.TEXTS.miniapp + '\n\n' : '') +
    'Или командами:\n' +
    '/book — записаться\n' +
    '/my — мои записи и отмена\n' +
    '/help — эта справка\n' +
    '/id — узнать свой Telegram ID\n\n' +
    `🕘 Работаем с ${config.WORK_START_HOUR}:00 до ${config.WORK_END_HOUR}:00\n\n` +
    config.TEXTS.helpExtra;

  if (isAdmin(ctx.from.id)) {
    t +=
      '\n\n<b>Для администратора:</b>\n' +
      '/admin — меню\n/slots — расписание\n/bookings — записи\n' +
      '/clients — клиенты\n/stats — статистика\n/export — выгрузка CSV\n' +
      '/broadcast — рассылка\n/demo — заполнить расписание\n/reset — обнуление' +
      (config.DEMO ? '\n/demoreset — вернуть демо в исходное состояние' : '');
  }
  await ctx.reply(t, { parse_mode: 'HTML' });
}
bot.command('help', screenHelp);

bot.command('id', async (ctx) => {
  await ctx.reply(
    `Ваш Telegram ID: <code>${ctx.from.id}</code>\n\n` +
      'Скопируйте его — он нужен для настройки бота.',
    { parse_mode: 'HTML' }
  );
});

// ---------------------------------------------------------------------------
//  5. АДМИНКА
// ---------------------------------------------------------------------------

function adminOnly(ctx) {
  if (isAdmin(ctx.from && ctx.from.id)) return true;
  return false;
}

function kbAdminMenu(userId) {
  const kb = new InlineKeyboard()
    .text('🗓 Расписание', 'ad:slots')
    .text('📋 Записи', 'ad:bookings')
    .row()
    .text('👥 Клиенты', 'ad:clients')
    .text('📊 Статистика', 'ad:stats')
    .row()
    .text('📤 Выгрузка CSV', 'ad:export')
    .text('📣 Рассылка', 'ad:broadcast');
  if (isRealAdmin(userId)) kb.row().text('🧪 Демо-заполнение', 'ad:demo');
  return kb;
}

async function screenAdmin(ctx) {
  const guest = config.OPEN_ADMIN && !isRealAdmin(ctx.from.id);
  await show(
    ctx,
    '<b>Панель администратора</b>\n\n' +
      (guest
        ? 'Так салон ведёт запись изнутри. Данные вымышленные, ' +
          'смотрите и трогайте что угодно.\n\n'
        : '') +
      'Выберите раздел:',
    kbAdminMenu(ctx.from.id)
  );
}

bot.command('admin', async (ctx) => {
  if (!adminOnly(ctx)) return;
  await screenAdmin(ctx);
});

// --- Редактор расписания ----------------------------------------------------

async function screenSlotMasters(ctx) {
  const kb = new InlineKeyboard();
  for (const m of config.MASTERS) {
    let free = 0;
    for (const ds of horizonDates()) free += freeTimes(m.id, ds).length;
    kb.text(`${m.name} · свободно ${free}`, `sl:m:${m.id}`).row();
  }
  kb.text('⬅️ В меню', 'ad:menu');
  await show(ctx, '<b>Расписание</b>\n\nВыберите мастера:', kb);
}

async function screenSlotDays(ctx, mid) {
  const kb = new InlineKeyboard();
  const dates = horizonDates();
  dates.forEach((ds, i) => {
    const day = ensureDay(mid, ds);
    let open = 0;
    let booked = 0;
    for (const t of U.allSlotTimes()) {
      if (day[t] === 'open') open++;
      if (day[t] === 'booked') booked++;
    }
    kb.text(
      `${U.formatDateShort(ds)} ✅${open} 🔒${booked}`,
      `sl:d:${mid}:${ds}`
    );
    if (i % 2 === 1) kb.row();
  });
  kb.row().text('⬅️ К мастерам', 'ad:slots');
  await show(
    ctx,
    `<b>${esc(masterName(mid))}</b>\n\n` +
      'Выберите день. ✅ — открытых окон, 🔒 — занятых:',
    kb
  );
}

async function screenSlotGrid(ctx, mid, date) {
  const day = ensureDay(mid, date);
  const kb = new InlineKeyboard();
  const times = U.allSlotTimes();

  times.forEach((t, i) => {
    const st = day[t];
    const icon = st === 'booked' ? '🔒' : st === 'open' ? '✅' : '➕';
    kb.text(`${icon} ${t}`, `sl:t:${mid}:${date}:${U.encTime(t)}`);
    if (i % 3 === 2) kb.row();
  });

  kb.row()
    .text('🟢 Открыть весь день', `sl:all:${mid}:${date}`)
    .row()
    .text('🧹 Очистить день', `sl:clr:${mid}:${date}`)
    .row()
    .text('⬅️ К дням', `sl:m:${mid}`)
    .text('⬅️ К мастерам', 'ad:slots');

  await show(
    ctx,
    `<b>${esc(masterName(mid))}</b>\n📅 ${U.formatDateFull(date)}\n\n` +
      'Нажмите на время, чтобы открыть или закрыть его.\n\n' +
      '✅ открыто · ➕ закрыто · 🔒 занято',
    kb
  );
}

bot.command('slots', async (ctx) => {
  if (!adminOnly(ctx)) return;
  await screenSlotMasters(ctx);
});

// --- Предстоящие записи -----------------------------------------------------

async function screenBookings(ctx) {
  const list = visibleBookings(ctx.from.id)
    .filter(
      (b) =>
        b.status === 'active' &&
        U.slotTimestamp(b.date, b.time) > Date.now()
    )
    .sort(
      (a, z) =>
        U.slotTimestamp(a.date, a.time) - U.slotTimestamp(z.date, z.time)
    );

  if (!list.length) {
    const kb = new InlineKeyboard().text('⬅️ В меню', 'ad:menu');
    await show(ctx, '<b>Предстоящие записи</b>\n\nПока пусто.', kb);
    return;
  }

  let text = '<b>Предстоящие записи</b>\n';
  let currentDate = '';
  for (const b of list.slice(0, 60)) {
    if (b.date !== currentDate) {
      currentDate = b.date;
      text += `\n<b>📅 ${U.formatDateFull(b.date)}</b>\n`;
    }
    const uname = b.username ? ` @${esc(b.username)}` : '';
    text +=
      `${b.time} — ${esc(masterName(b.masterId))} · ` +
      `${esc(b.name)}${uname} · ${esc(b.phone)}\n`;
  }
  if (list.length > 60) text += `\n…и ещё ${list.length - 60}. Полный список — /export`;

  const kb = new InlineKeyboard().text('⬅️ В меню', 'ad:menu');
  await show(ctx, text, kb);
}

bot.command('bookings', async (ctx) => {
  if (!adminOnly(ctx)) return;
  await screenBookings(ctx);
});

// --- Клиенты ----------------------------------------------------------------

async function screenClients(ctx) {
  const all = visibleClients(ctx.from.id).sort(
    (a, z) => (z.bookings || 0) - (a.bookings || 0)
  );
  const booked = all.filter((c) => (c.bookings || 0) > 0);

  if (!booked.length) {
    const kb = new InlineKeyboard().text('⬅️ В меню', 'ad:menu');
    await show(ctx, '<b>Клиенты</b>\n\nПока никто не записывался.', kb);
    return;
  }

  let text = `<b>Клиенты</b> (записывались: ${booked.length})\n\n`;
  for (const c of booked.slice(0, 40)) {
    const uname = c.username ? ` @${esc(c.username)}` : '';
    const blocked = c.blocked ? ' 🚫' : '';
    text +=
      `• ${esc(c.name)}${uname}${blocked}\n` +
      `  ${esc(c.phone || 'телефон не указан')} · ` +
      `${c.bookings} ${U.pluralRu(c.bookings, 'визит', 'визита', 'визитов')}\n`;
  }
  if (booked.length > 40)
    text += `\n…и ещё ${booked.length - 40}. Полный список — /export`;

  const kb = new InlineKeyboard().text('⬅️ В меню', 'ad:menu');
  await show(ctx, text, kb);
}

bot.command('clients', async (ctx) => {
  if (!adminOnly(ctx)) return;
  await screenClients(ctx);
});

// --- Статистика -------------------------------------------------------------

function buildStats(userId) {
  const data = d();
  const now = Date.now();
  const all = visibleBookings(userId);

  const active = all.filter(
    (b) => b.status === 'active' && U.slotTimestamp(b.date, b.time) > now
  );
  const doneList = all.filter(
    (b) => b.status === 'active' && U.slotTimestamp(b.date, b.time) <= now
  );
  const cancelled = all.filter((b) => b.status === 'cancelled');

  const inLast = (days) =>
    all.filter((b) => now - b.createdAt <= days * U.MS_DAY);

  const clients = visibleClients(userId);
  const withBooking = clients.filter((c) => (c.bookings || 0) > 0);
  const repeat = clients.filter((c) => (c.bookings || 0) >= 2);

  const byMaster = {};
  for (const m of config.MASTERS) byMaster[m.id] = 0;
  for (const b of all) if (byMaster[b.masterId] != null) byMaster[b.masterId]++;

  const byTime = {};
  for (const b of all) byTime[b.time] = (byTime[b.time] || 0) + 1;

  // источники: сколько открыли бота и сколько дошли до записи
  const bySource = {};
  for (const c of clients) {
    const s = c.source || '(без метки)';
    if (!bySource[s]) bySource[s] = { opened: 0, booked: 0 };
    bySource[s].opened++;
    if ((c.bookings || 0) > 0) bySource[s].booked++;
  }

  let freeSlots = 0;
  for (const m of config.MASTERS)
    for (const ds of horizonDates()) freeSlots += freeTimes(m.id, ds).length;

  return {
    total: all.length,
    active: active.length,
    done: doneList.length,
    cancelled: cancelled.length,
    cancelRate: all.length ? Math.round((cancelled.length / all.length) * 100) : 0,
    d7: inLast(7).length,
    d30: inLast(30).length,
    clients: clients.length,
    withBooking: withBooking.length,
    conversion: clients.length
      ? Math.round((withBooking.length / clients.length) * 100)
      : 0,
    repeat: repeat.length,
    byMaster,
    byTime,
    bySource,
    freeSlots,
  };
}

function statsText(userId) {
  const s = buildStats(userId);
  let t = '<b>📊 Статистика</b>\n\n';

  t += '<b>Записи</b>\n';
  t += `Всего: ${s.total}\n`;
  t += `Предстоящих: ${s.active}\n`;
  t += `Состоявшихся: ${s.done}\n`;
  t += `Отмен: ${s.cancelled} (${s.cancelRate}%)\n`;
  t += `За 7 дней: ${s.d7} · за 30 дней: ${s.d30}\n\n`;

  t += '<b>Клиенты</b>\n';
  t += `Открыли бота: ${s.clients}\n`;
  t += `Дошли до записи: ${s.withBooking} (конверсия ${s.conversion}%)\n`;
  t += `Записывались 2+ раза: ${s.repeat}\n\n`;

  t += '<b>По мастерам</b>\n';
  for (const m of config.MASTERS) t += `${esc(m.name)}: ${s.byMaster[m.id] || 0}\n`;
  t += '\n';

  const times = Object.entries(s.byTime).sort((a, z) => z[1] - a[1]).slice(0, 5);
  if (times.length) {
    t += '<b>Популярное время</b>\n';
    for (const [tm, n] of times) t += `${tm} — ${n}\n`;
    t += '\n';
  }

  const srcs = Object.entries(s.bySource).sort((a, z) => z[1].opened - a[1].opened);
  if (srcs.length) {
    t += '<b>Откуда пришли</b>\n';
    for (const [key, v] of srcs) {
      const label = config.SOURCE_LABELS[key] || key;
      const pct = v.opened ? Math.round((v.booked / v.opened) * 100) : 0;
      t += `${esc(label)}: открыли ${v.opened}, записались ${v.booked} (${pct}%)\n`;
    }
    t += '\n';
  }

  t += `<b>Свободных окон впереди:</b> ${s.freeSlots}`;
  return t;
}

bot.command('stats', async (ctx) => {
  if (!adminOnly(ctx)) return;
  const kb = new InlineKeyboard().text('⬅️ В меню', 'ad:menu');
  await ctx.reply(statsText(ctx.from.id), { parse_mode: 'HTML', reply_markup: kb });
});

// --- Выгрузка CSV -----------------------------------------------------------

function csvCell(v) {
  const s = String(v == null ? '' : v).replace(/"/g, '""');
  return `"${s}"`;
}

function buildCsv(userId) {
  const rows = [
    [
      'ID', 'Дата', 'Время', 'Мастер', 'Имя', 'Юзернейм',
      'Телефон', 'Дизайн', 'Статус', 'Источник', 'Создана',
    ],
  ];
  const statusRu = { active: 'активна', cancelled: 'отменена' };
  for (const b of visibleBookings(userId)) {
    const created = new Date(b.createdAt + config.TZ_OFFSET_HOURS * U.MS_HOUR);
    rows.push([
      b.id,
      b.date,
      b.time,
      masterName(b.masterId),
      b.name,
      b.username ? '@' + b.username : '',
      b.phone,
      b.design || '',
      statusRu[b.status] || b.status,
      b.source || '',
      U.dateToStr(created) +
        ' ' +
        String(created.getUTCHours()).padStart(2, '0') +
        ':' +
        String(created.getUTCMinutes()).padStart(2, '0'),
    ]);
  }
  // \ufeff — метка, без неё Excel показывает кириллицу кракозябрами
  return '\ufeff' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
}

async function sendCsv(ctx) {
  const csv = buildCsv(ctx.from.id);
  const name = `zapisi_${U.todayStr()}.csv`;
  await ctx.replyWithDocument(new InputFile(Buffer.from(csv, 'utf8'), name), {
    caption: `Выгрузка на ${U.formatDateFull(U.todayStr())}. Открывается в Excel.`,
  });
}

bot.command('export', async (ctx) => {
  if (!adminOnly(ctx)) return;
  await sendCsv(ctx);
});

// --- Демо-заполнение --------------------------------------------------------

function fillDemo() {
  let n = 0;
  for (const m of config.MASTERS) {
    for (const ds of horizonDates()) {
      const day = ensureDay(m.id, ds);
      for (const t of U.allSlotTimes()) {
        if (day[t] === 'closed' && !U.isPastSlot(ds, t)) {
          day[t] = 'open';
          n++;
        }
      }
    }
  }
  db.save();
  return n;
}

bot.command('demo', async (ctx) => {
  if (!isRealAdmin(ctx.from.id)) return;
  const n = fillDemo();
  await ctx.reply(
    `🧪 Расписание заполнено рабочими часами.\nОткрыто новых окон: <b>${n}</b>\n\n` +
      'Это для показа бота. Когда студия даст настоящий график — ' +
      'закройте лишнее в /slots.',
    { parse_mode: 'HTML' }
  );
});

// --- Сброс базы -------------------------------------------------------------

// Вернуть демо в исходное состояние — после показа клиенту.
bot.command('demoreset', async (ctx) => {
  if (!isRealAdmin(ctx.from.id)) return;
  if (!config.DEMO) {
    await ctx.reply('Бот работает не в демо-режиме.');
    return;
  }
  const data = d();
  data.bookings = [];
  data.clients = {};
  data.slots = {};
  data.lastId = 0;
  const r = seed.seed(db, ensureDay);
  await ctx.reply(
    '🧪 Демо восстановлено.\n' +
      `Клиентов: ${r.clients}\nЗаписей: ${r.bookings}\n` +
      'Расписание открыто на две недели вперёд.'
  );
});

bot.command('reset', async (ctx) => {
  if (!isRealAdmin(ctx.from.id)) return;
  const arg = String(ctx.match || '').trim().toUpperCase();
  const data = d();

  if (arg === 'ПОДТВЕРЖДАЮ') {
    const n = data.bookings.length;
    data.bookings = [];
    data.clients = {};
    for (const mid of Object.keys(data.slots))
      for (const ds of Object.keys(data.slots[mid]))
        for (const t of Object.keys(data.slots[mid][ds]))
          if (data.slots[mid][ds][t] === 'booked') data.slots[mid][ds][t] = 'open';
    db.save();
    await ctx.reply(
      `🗑 Удалено записей: ${n}. Клиенты стёрты. Расписание сохранено.`
    );
    return;
  }

  if (arg === 'ВСЁ' || arg === 'ВСЕ') {
    data.bookings = [];
    data.clients = {};
    data.slots = {};
    data.lastId = 0;
    db.save();
    await ctx.reply('🗑 Стёрто всё: записи, клиенты и расписание.');
    return;
  }

  await ctx.reply(
    '⚠️ <b>Внимание!</b> Эта команда стирает данные без возможности вернуть.\n\n' +
      '<code>/reset ПОДТВЕРЖДАЮ</code> — удалить записи и клиентов, ' +
      'расписание оставить\n' +
      '<code>/reset ВСЁ</code> — удалить вообще всё, включая расписание\n\n' +
      'Сейчас ничего не удалено.',
    { parse_mode: 'HTML' }
  );
});

// ---------------------------------------------------------------------------
//  6. РАССЫЛКА
// ---------------------------------------------------------------------------

async function startBroadcast(ctx) {
  setState(ctx.from.id, { step: 'bc_wait' });
  await ctx.reply(
    '📣 <b>Рассылка</b>\n\n' +
      'Пришлите текст сообщения или фото с подписью.\n' +
      'Отправка начнётся только после подтверждения.\n\n' +
      'Чтобы выйти — /admin',
    { parse_mode: 'HTML' }
  );
}

bot.command('broadcast', async (ctx) => {
  if (!isRealAdmin(ctx.from.id)) return;
  await startBroadcast(ctx);
});

async function runBroadcast(ctx, payload) {
  const clients = Object.values(d().clients);
  const targets = clients.filter((c) => !c.blocked && c.id !== ctx.from.id);

  await ctx.reply(
    `Отправляю ${targets.length} ${U.pluralRu(
      targets.length,
      'человеку',
      'людям',
      'людям'
    )}…`
  );

  let ok = 0;
  const fails = [];

  for (const c of targets) {
    if (c.demo) {
      ok++; // вымышленный клиент — считаем доставку, но ничего не шлём
      continue;
    }
    try {
      if (payload.type === 'photo') {
        // фото шлём по file_id — Telegram не перезагружает его заново
        await bot.api.sendPhoto(c.id, payload.fileId, {
          caption: payload.caption || '',
          parse_mode: 'HTML',
        });
      } else {
        await bot.api.sendMessage(c.id, payload.text, { parse_mode: 'HTML' });
      }
      ok++;
    } catch (e) {
      const reason = failReason(e);
      markBlocked(c.id, reason);
      fails.push({ name: c.name, username: c.username, reason });
    }
    await U.sleep(120); // чтобы не упереться в лимит Telegram
  }

  db.save();

  let report =
    '📣 <b>Рассылка завершена</b>\n\n' +
    (config.DEMO
      ? '🧪 Демо-режим: вымышленным клиентам сообщения не отправлялись.\n\n'
      : '') +
    `✅ Доставлено: ${ok}\n` +
    `❌ Не доставлено: ${fails.length}\n`;

  if (fails.length) {
    report += '\n<b>Кому не дошло:</b>\n';
    for (const f of fails.slice(0, 40)) {
      const uname = f.username ? ` @${esc(f.username)}` : '';
      report += `• ${esc(f.name)}${uname} — ${esc(f.reason)}\n`;
    }
    if (fails.length > 40) report += `…и ещё ${fails.length - 40}\n`;
  }

  await ctx.reply(report, { parse_mode: 'HTML' });
}

// ---------------------------------------------------------------------------
//  ОБРАБОТЧИК ФОТО — ОБЯЗАТЕЛЬНО ВЫШЕ ОБРАБОТЧИКА ТЕКСТА!
//  Иначе рассылка картинкой не сработает.
// ---------------------------------------------------------------------------

bot.on('message:photo', async (ctx) => {
  const st = getState(ctx.from.id);
  if (!st || st.step !== 'bc_wait' || !adminOnly(ctx)) return;

  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id; // самое большое качество
  const caption = ctx.message.caption || '';

  setState(ctx.from.id, {
    step: 'bc_confirm',
    payload: { type: 'photo', fileId, caption },
  });

  const kb = new InlineKeyboard()
    .text('🚀 Отправить всем', 'bc:go')
    .row()
    .text('❌ Отмена', 'bc:no');

  await ctx.reply(
    'Вот так это увидят клиенты (выше). Отправляем?',
    { reply_markup: kb }
  );
});

// ---------------------------------------------------------------------------
//  ОБРАБОТЧИК КОНТАКТА (кнопка «Поделиться номером»)
// ---------------------------------------------------------------------------

async function handlePhone(ctx, rawPhone) {
  const st = getState(ctx.from.id);
  if (!st || st.step !== 'phone') return false;

  const phone = U.normalizePhone(rawPhone);
  if (!phone) {
    await ctx.reply(
      'Кажется, это не похоже на номер. Попробуйте ещё раз, ' +
        'например: +998 90 123 45 67'
    );
    return true;
  }

  st.phone = phone;
  st.step = 'confirm';
  setState(ctx.from.id, st);

  await ctx.reply('Номер получен ✅', {
    reply_markup: kbMain(ctx.from.id),
  });
  await screenConfirm(ctx, st);
  return true;
}

// Пришли данные из мини-аппа: клиент нажал «Записаться» внутри галереи.
bot.on('message:web_app_data', async (ctx) => {
  let payload = {};
  try {
    payload = JSON.parse(ctx.message.web_app_data.data || '{}');
  } catch (e) {
    payload = {};
  }

  clearState(ctx.from.id);
  setDesign(ctx.from.id, String(payload.design || '').slice(0, 60));

  // отмечаем источник, если человек пришёл в бота именно через галерею
  const c = touchClient(ctx.from);
  if (!c.source) {
    c.source = 'miniapp';
    touch();
  }

  if (payload.design) {
    await ctx.reply(
      `Отличный выбор — <b>${esc(String(payload.design).slice(0, 60))}</b>.\n` +
        'Покажем его мастеру. Осталось выбрать время.',
      { parse_mode: 'HTML' }
    );
  }
  await screenMasters(ctx);
});

bot.on('message:contact', async (ctx) => {
  await handlePhone(ctx, ctx.message.contact.phone_number);
});

// ---------------------------------------------------------------------------
//  ОБРАБОТЧИК ТЕКСТА — всегда последний
// ---------------------------------------------------------------------------

bot.on('message:text', async (ctx) => {
  const st = getState(ctx.from.id);
  const text = ctx.message.text.trim();

  // --- нажатия на кнопки постоянного меню ---
  if (text === '📝 Записаться') {
    clearState(ctx.from.id);
    return screenMasters(ctx);
  }
  if (text === '📋 Мои записи') {
    clearState(ctx.from.id);
    return screenMy(ctx);
  }
  if (text === 'ℹ️ Помощь') {
    clearState(ctx.from.id);
    return screenHelp(ctx);
  }
  if (text === '⚙️ Админка') {
    if (!adminOnly(ctx)) return;
    clearState(ctx.from.id);
    return screenAdmin(ctx);
  }

  if (text === '⬅️ Отмена') {
    clearState(ctx.from.id);
    await ctx.reply('Хорошо, отменили.', {
      reply_markup: kbMain(ctx.from.id),
    });
    await screenMasters(ctx);
    return;
  }

  if (st && st.step === 'bc_wait' && adminOnly(ctx)) {
    setState(ctx.from.id, {
      step: 'bc_confirm',
      payload: { type: 'text', text },
    });
    const kb = new InlineKeyboard()
      .text('🚀 Отправить всем', 'bc:go')
      .row()
      .text('❌ Отмена', 'bc:no');
    await ctx.reply(
      'Сообщение для рассылки:\n\n' + esc(text) + '\n\nОтправляем?',
      { parse_mode: 'HTML', reply_markup: kb }
    );
    return;
  }

  if (st && st.step === 'phone') {
    await handlePhone(ctx, text);
    return;
  }

  await ctx.reply(
    'Пользуйтесь кнопками внизу экрана 🙂',
    { reply_markup: kbMain(ctx.from.id) }
  );
});

// ---------------------------------------------------------------------------
//  ОБРАБОТЧИК КНОПОК
// ---------------------------------------------------------------------------

bot.on('callback_query:data', async (ctx) => {
  const parts = ctx.callbackQuery.data.split(':');
  const ns = parts[0];

  // ---- запись клиента ----
  if (ns === 'bk') {
    const action = parts[1];

    if (action === 'masters') {
      clearState(ctx.from.id);
      await ctx.answerCallbackQuery();
      return screenMasters(ctx);
    }
    if (action === 'g') {
      await ctx.answerCallbackQuery();
      return screenGroupMasters(ctx, Number(parts[2]));
    }
    if (action === 'm') {
      await ctx.answerCallbackQuery();
      return screenDays(ctx, parts[2]);
    }
    if (action === 'd') {
      await ctx.answerCallbackQuery();
      return screenTimes(ctx, parts[2], parts[3]);
    }
    if (action === 't') {
      const mid = parts[2];
      const date = parts[3];
      const time = U.decTime(parts[4]);
      if (freeTimes(mid, date).indexOf(time) === -1) {
        await ctx.answerCallbackQuery({
          text: 'Это время только что заняли',
          show_alert: true,
        });
        return screenTimes(ctx, mid, date);
      }
      await ctx.answerCallbackQuery();
      return screenAskPhone(ctx, mid, date, time);
    }
    if (action === 'cancel') {
      clearState(ctx.from.id);
      await ctx.answerCallbackQuery();
      return show(ctx, 'Запись отменена. Когда будете готовы — /book');
    }
    if (action === 'ok') {
      const st = getState(ctx.from.id);
      if (!st || st.step !== 'confirm') {
        await ctx.answerCallbackQuery({
          text: 'Начните запись заново: /book',
          show_alert: true,
        });
        return;
      }
      const res = createBooking(ctx.from, st.mid, st.date, st.time, st.phone);
      if (!res) {
        await ctx.answerCallbackQuery({
          text: 'Увы, это время только что заняли',
          show_alert: true,
        });
        clearState(ctx.from.id);
        return screenTimes(ctx, st.mid, st.date);
      }
      clearState(ctx.from.id);
      await ctx.answerCallbackQuery({ text: 'Записали!' });

      await show(
        ctx,
        '🎉 <b>Вы записаны!</b>\n\n' +
          `👩 ${esc(masterName(st.mid))}\n` +
          `📅 ${U.formatDateFull(st.date)}\n` +
          `🕒 ${st.time}\n\n` +
          'За 2 часа до визита пришлём напоминание.\n' +
          'Отменить или посмотреть запись — кнопка «📋 Мои записи» внизу.'
      );

      const b = res.booking;
      const uname = b.username ? ` @${esc(b.username)}` : '';
      await notifyAdmins(
        '🔔 <b>Новая запись</b>\n\n' +
          `👩 Мастер: ${esc(masterName(b.masterId))}\n` +
          `📅 ${U.formatDateFull(b.date)} в ${b.time}\n` +
          `🙋 ${esc(b.name)}${uname}\n` +
          `📞 ${esc(b.phone)}\n` +
          (b.design ? `💅 Хочет дизайн: <b>${esc(b.design)}</b>\n` : '') +
          (b.source
            ? `📍 Источник: ${esc(config.SOURCE_LABELS[b.source] || b.source)}\n`
            : '') +
          (res.isFirst ? '\n✨ <b>Первая запись</b>' : '\n🔁 Повторный клиент')
      );
      return;
    }
  }

  // ---- мои записи ----
  if (ns === 'my') {
    if (parts[1] === 'back') {
      await ctx.answerCallbackQuery();
      return show(ctx, 'Хорошо, запись осталась. Посмотреть все — /my');
    }
    const id = Number(parts[2]);
    const b = d().bookings.find((x) => x.id === id);

    if (!b || b.userId !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: 'Запись не найдена' });
      return;
    }
    if (parts[1] === 'c') {
      const kb = new InlineKeyboard()
        .text('✅ Да, отменить', `my:y:${id}`)
        .row()
        .text('⬅️ Нет, оставить', 'my:back');
      await ctx.answerCallbackQuery();
      return show(
        ctx,
        'Точно отменить запись?\n\n' +
          `👩 ${esc(masterName(b.masterId))}\n` +
          `📅 ${U.formatDateFull(b.date)} в ${b.time}`,
        kb
      );
    }
    if (parts[1] === 'y') {
      if (b.status !== 'active') {
        await ctx.answerCallbackQuery({ text: 'Уже отменена' });
        return;
      }
      cancelBooking(b);
      await ctx.answerCallbackQuery({ text: 'Отменено' });
      await show(
        ctx,
        '❌ Запись отменена. Время снова свободно.\n\n' +
          'Записаться заново — кнопка «📝 Записаться» внизу.'
      );
      const uname = b.username ? ` @${esc(b.username)}` : '';
      await notifyAdmins(
        '❌ <b>Отмена записи</b>\n\n' +
          `👩 ${esc(masterName(b.masterId))}\n` +
          `📅 ${U.formatDateFull(b.date)} в ${b.time}\n` +
          `🙋 ${esc(b.name)}${uname} · ${esc(b.phone)}`
      );
      return;
    }
  }
  // ---- админка ----
  if (ns === 'ad') {
    if (!adminOnly(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Раздел только для админов' });
      return;
    }
    await ctx.answerCallbackQuery();
    const a = parts[1];
    if (a === 'menu') return screenAdmin(ctx);
    if (a === 'slots') return screenSlotMasters(ctx);
    if (a === 'bookings') return screenBookings(ctx);
    if (a === 'clients') return screenClients(ctx);
    if (a === 'stats') {
      const kb = new InlineKeyboard().text('⬅️ В меню', 'ad:menu');
      return show(ctx, statsText(ctx.from.id), kb);
    }
    if (a === 'export') return sendCsv(ctx);
    if (a === 'broadcast') {
      if (!isRealAdmin(ctx.from.id)) {
        const kb = new InlineKeyboard().text('⬅️ В меню', 'ad:menu');
        return show(
          ctx,
          '📣 <b>Рассылка</b>\n\n' +
            'Отсюда владелец салона отправляет сообщение всем клиентам — ' +
            'текстом или фото с подписью.\n\n' +
            'После отправки приходит отчёт: кому дошло, кому нет и почему ' +
            '(заблокировал бота, удалил аккаунт, чат не найден).\n\n' +
            '🧪 В демо отправка отключена.',
          kb
        );
      }
      return startBroadcast(ctx);
    }
    if (a === 'demo') {
      if (!isRealAdmin(ctx.from.id)) return screenAdmin(ctx);
      const n = fillDemo();
      const kb = new InlineKeyboard().text('⬅️ В меню', 'ad:menu');
      return show(
        ctx,
        `🧪 Открыто новых окон: <b>${n}</b>\n\n` +
          'Это демо-заполнение для показа бота.',
        kb
      );
    }
  }

  // ---- редактор расписания ----
  if (ns === 'sl') {
    if (!adminOnly(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Раздел только для админов' });
      return;
    }
    const a = parts[1];
    if (a === 'm') {
      await ctx.answerCallbackQuery();
      return screenSlotDays(ctx, parts[2]);
    }
    if (a === 'd') {
      await ctx.answerCallbackQuery();
      return screenSlotGrid(ctx, parts[2], parts[3]);
    }
    if (a === 't') {
      if (!isRealAdmin(ctx.from.id)) {
        await ctx.answerCallbackQuery({
          text: 'В демо расписание только для просмотра',
          show_alert: true,
        });
        return;
      }
      const mid = parts[2];
      const date = parts[3];
      const time = U.decTime(parts[4]);
      const day = ensureDay(mid, date);
      if (day[time] === 'booked') {
        await ctx.answerCallbackQuery({
          text: 'Это время занято клиентом. Сначала отмените запись.',
          show_alert: true,
        });
        return;
      }
      if (U.isPastSlot(date, time)) {
        await ctx.answerCallbackQuery({
          text: 'Это время уже прошло',
          show_alert: true,
        });
        return;
      }
      day[time] = day[time] === 'open' ? 'closed' : 'open';
      touch();
      await ctx.answerCallbackQuery({
        text: day[time] === 'open' ? 'Открыто' : 'Закрыто',
      });
      return screenSlotGrid(ctx, mid, date);
    }
    if (a === 'all' || a === 'clr') {
      if (!isRealAdmin(ctx.from.id)) {
        await ctx.answerCallbackQuery({
          text: 'В демо расписание только для просмотра',
          show_alert: true,
        });
        return;
      }
      const [, , mid, date] = parts;
      const day = ensureDay(mid, date);
      for (const t of U.allSlotTimes()) {
        if (day[t] === 'booked') continue;
        if (a === 'all') {
          if (!U.isPastSlot(date, t)) day[t] = 'open';
        } else {
          day[t] = 'closed';
        }
      }
      db.save();
      await ctx.answerCallbackQuery({
        text: a === 'all' ? 'День открыт' : 'День очищен',
      });
      return screenSlotGrid(ctx, mid, date);
    }
  }

  // ---- подтверждение рассылки ----
  if (ns === 'bc') {
    if (!adminOnly(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }
    const st = getState(ctx.from.id);
    await ctx.answerCallbackQuery();
    if (parts[1] === 'no' || !st || st.step !== 'bc_confirm') {
      clearState(ctx.from.id);
      return show(ctx, 'Рассылка отменена.');
    }
    clearState(ctx.from.id);
    return runBroadcast(ctx, st.payload);
  }

  await ctx.answerCallbackQuery();
});

// ---------------------------------------------------------------------------
//  7. АВТОМАТИКА
// ---------------------------------------------------------------------------

// Горизонт записи едет сам + подчистка прошедшего
function maintenance() {
  const data = d();
  const today = U.todayStr();
  const dates = horizonDates();
  let changed = false;

  for (const m of config.MASTERS) {
    if (!data.slots[m.id]) {
      data.slots[m.id] = {};
      changed = true;
    }
    for (const ds of dates) {
      if (!data.slots[m.id][ds]) {
        ensureDay(m.id, ds); // новый день приходит пустым (все окна закрыты)
        changed = true;
      }
    }
    for (const ds of Object.keys(data.slots[m.id])) {
      if (ds < today) {
        delete data.slots[m.id][ds]; // прошедшие дни убираем
        changed = true;
        continue;
      }
      const day = data.slots[m.id][ds];
      const valid = U.allSlotTimes();
      for (const t of Object.keys(day)) {
        if (!valid.includes(t)) {
          delete day[t]; // сетка часов поменялась в config.js — убираем лишнее
          changed = true;
          continue;
        }
        if (day[t] !== 'closed' && U.isPastSlot(ds, t)) {
          day[t] = 'closed'; // прошедшее окно больше не показываем
          changed = true;
        }
      }
    }
  }
  if (changed) db.save();
}

// Напоминания и приглашения записаться снова
async function runAutomation() {
  const now = Date.now();
  let changed = false;

  for (const b of d().bookings) {
    if (b.status !== 'active') continue;
    if (b.demo) continue; // выдуманным клиентам ничего не отправляем
    const ts = U.slotTimestamp(b.date, b.time);

    // напоминание за 2 часа — строго один раз
    if (
      !b.reminderSent &&
      ts > now &&
      ts - now <= config.REMINDER_HOURS_BEFORE * U.MS_HOUR
    ) {
      b.reminderSent = true;
      changed = true;
      const r = await safeSend(
        b.userId,
        '⏰ <b>Напоминание</b>\n\n' +
          `Сегодня в <b>${b.time}</b> вас ждёт ${esc(masterName(b.masterId))}.\n\n` +
          'Если планы изменились — отмените запись в /my, ' +
          'чтобы время досталось другому.'
      );
      if (!r.ok) console.log('[reminder] не доставлено:', r.reason);
    }

    // через 2 недели после визита — позвать снова
    if (
      !b.rebookSent &&
      ts < now &&
      now - ts >= config.REBOOK_AFTER_DAYS * U.MS_DAY
    ) {
      b.rebookSent = true;
      changed = true;
      const r = await safeSend(
        b.userId,
        '✨ Прошло две недели с вашего визита.\n\n' +
          `Самое время обновить — ${esc(masterName(b.masterId))} и другие мастера ` +
          'ждут вас.\n\nЖмите «📝 Записаться» внизу экрана.'
      );
      if (!r.ok) console.log('[rebook] не доставлено:', r.reason);
    }
  }
  if (changed) db.save();
}

// каждую минуту
setInterval(() => {
  try {
    maintenance();
  } catch (e) {
    techAlert('Ошибка в обслуживании расписания', e.stack || e.message);
  }
  runAutomation().catch((e) =>
    techAlert('Ошибка в напоминаниях', e.stack || e.message)
  );
}, 60 * 1000);

// ---------------------------------------------------------------------------
//  8. ЛОВЛЯ ОШИБОК И СТАРТ
// ---------------------------------------------------------------------------

bot.catch(async (err) => {
  const ctx = err.ctx;
  const e = err.error;
  let title = 'Ошибка в боте';
  if (e instanceof GrammyError) title = 'Ошибка Telegram';
  else if (e instanceof HttpError) title = 'Нет связи с Telegram';

  console.error('[bot.catch]', e);
  await techAlert(title, (e && e.stack) || (e && e.description) || String(e), whoInfo(ctx));

  // клиент технических подробностей не видит
  try {
    if (ctx && ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: 'Что-то пошло не так, попробуйте ещё раз',
      });
    } else if (ctx && ctx.chat) {
      await ctx.reply('Что-то пошло не так, попробуйте ещё раз 🙏');
    }
  } catch (_) {
    /* уже ничем не поможешь */
  }
});

process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
  db.save();
  techAlert('Необработанная ошибка процесса', e.stack || e.message);
});

process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e);
  techAlert('Необработанная ошибка (promise)', (e && e.stack) || String(e));
});

function shutdown(signal) {
  console.log(`[${signal}] сохраняю базу и выключаюсь`);
  db.save();
  try {
    bot.stop();
  } catch (_) {
    /* ok */
  }
  setTimeout(() => process.exit(0), 500);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  maintenance();

  // Первый запуск демо — придумываем историю, чтобы экраны были не пустыми
  const seeded = seed.ensureSeeded(db, ensureDay);
  if (seeded) {
    console.log('[demo] создано клиентов:', seeded.clients,
      'записей:', seeded.bookings);
  }

  await bot.api.setMyCommands([
    { command: 'book', description: 'Записаться' },
    { command: 'my', description: 'Мои записи' },
    { command: 'help', description: 'Справка' },
    { command: 'id', description: 'Мой Telegram ID' },
  ]);

  const targets = TECH_IDS.length ? TECH_IDS : ADMIN_IDS;
  const startMsg =
    '✅ <b>Бот запущен</b>\n\n' +
    `Записей в базе: ${d().bookings.length}\n` +
    `Клиентов в базе: ${Object.keys(d().clients).length}\n` +
    `Папка данных: <code>${esc(db.DATA_DIR)}</code>`;
  for (const id of targets) {
    try {
      await bot.api.sendMessage(id, startMsg, { parse_mode: 'HTML' });
    } catch (_) {
      /* ok */
    }
  }

  console.log('Бот запущен. Админы:', ADMIN_IDS, 'Техи:', TECH_IDS);
  await bot.start();
}

main().catch((e) => {
  console.error('Не удалось запустить бота:', e);
  process.exit(1);
});
