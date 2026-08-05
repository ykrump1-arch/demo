// ============================================================================
//  seed.js — наполняет демо-бота вымышленной историей.
//
//  Зачем: на пустом боте нечего показывать. Статистика по нулям,
//  список клиентов пустой, выгрузка в Excel пустая.
//  Этот файл придумывает месяц жизни салона, чтобы все экраны были живыми.
//
//  В боевом боте не используется: включается только при DEMO: true.
// ============================================================================

const config = require('./config');
const U = require('./utils');

// Простой генератор псевдослучайных чисел с фиксированным зерном.
// Нужен, чтобы демо каждый раз выглядело одинаково.
let seedValue = 20260805;
function rnd() {
  seedValue = (seedValue * 1103515245 + 12345) % 2147483648;
  return seedValue / 2147483648;
}
function pick(arr) {
  return arr[Math.floor(rnd() * arr.length)];
}
function int(min, max) {
  return min + Math.floor(rnd() * (max - min + 1));
}

const SOURCES = [
  'instagram', 'instagram', 'instagram', 'instagram',
  'stories', 'stories', 'stories',
  'bio', 'bio',
  'miniapp', 'miniapp',
  'flyer',
  '', '',
];

const DESIGNS = [
  '', '', '', 'Вариант A', 'Вариант B', 'Вариант C', '',
];

function phone(i) {
  return '+9989' + String(10000000 + i * 137891).slice(0, 8);
}

// Заполняем расписание: все рабочие часы открыты.
function openSchedule(data, ensureDay) {
  for (const m of config.MASTERS) {
    for (let i = 0; i < config.HORIZON_DAYS; i++) {
      const ds = U.addDays(U.todayStr(), i);
      if (U.isDayOff(ds)) continue;
      const day = ensureDay(m.id, ds);
      for (const t of U.allSlotTimes()) {
        if (day[t] === 'closed' && !U.isPastSlot(ds, t)) day[t] = 'open';
      }
    }
  }
}

function seed(db, ensureDay) {
  const data = db.data;
  seedValue = 20260805;

  openSchedule(data, ensureDay);

  const today = U.todayStr();
  const times = U.allSlotTimes();
  const CLIENTS = 16;

  // --- клиенты -------------------------------------------------------------
  for (let i = 1; i <= CLIENTS; i++) {
    const id = 900000000 + i;
    data.clients[String(id)] = {
      id,
      name: 'Клиент ' + i,
      username: 'client' + i,
      phone: phone(i),
      firstSeen: Date.now() - int(3, 40) * U.MS_DAY,
      source: SOURCES[i % SOURCES.length],
      bookings: 0,
      blocked: false,
      demo: true, // пометка: это выдуманный человек, ему ничего не отправляем
    };
  }

  const clientIds = Object.keys(data.clients);

  function addBooking(clientKey, date, time, masterId, status) {
    const c = data.clients[clientKey];
    const b = {
      id: db.nextId(),
      masterId,
      date,
      time,
      userId: c.id,
      name: c.name,
      username: c.username,
      phone: c.phone,
      source: c.source,
      design: pick(DESIGNS),
      createdAt: U.slotTimestamp(date, time) - int(1, 6) * U.MS_DAY,
      status,
      reminderSent: true,
      rebookSent: true,
      demo: true,
    };
    data.bookings.push(b);
    if (status === 'active') c.bookings = (c.bookings || 0) + 1;
    return b;
  }

  // --- прошедшие визиты за последний месяц ---------------------------------
  // 11 клиентов из 16 дошли до записи — получается живая конверсия.
  const buyers = clientIds.slice(0, 11);

  for (const key of buyers) {
    const visits = int(1, 3);
    for (let v = 0; v < visits; v++) {
      const daysAgo = int(1, 30);
      const date = U.addDays(today, -daysAgo);
      addBooking(key, date, pick(times), pick(config.MASTERS).id, 'active');
    }
  }

  // --- отмены (чтобы в статистике был процент отмен) ------------------------
  for (let i = 0; i < 4; i++) {
    const key = pick(buyers);
    const date = U.addDays(today, -int(2, 25));
    const b = addBooking(key, date, pick(times), pick(config.MASTERS).id, 'cancelled');
    b.cancelledAt = b.createdAt + U.MS_DAY;
    const c = data.clients[key];
    if (c.bookings > 0) c.bookings--;
  }

  // --- предстоящие записи --------------------------------------------------
  // Занимаем реальные окна, чтобы в расписании были видны 🔒
  let placed = 0;
  for (let dayShift = 0; dayShift < 6 && placed < 7; dayShift++) {
    const date = U.addDays(today, dayShift);
    if (U.isDayOff(date)) continue;
    for (const t of times) {
      if (placed >= 7) break;
      if (U.isPastSlot(date, t)) continue;
      if (rnd() < 0.62) continue;
      const m = pick(config.MASTERS);
      const day = ensureDay(m.id, date);
      if (day[t] !== 'open') continue;
      day[t] = 'booked';
      addBooking(pick(buyers), date, t, m.id, 'active');
      placed++;
    }
  }

  data.meta.demoSeededAt = Date.now();
  db.save();

  return {
    clients: Object.keys(data.clients).length,
    bookings: data.bookings.length,
  };
}

// Заполняем только если база пустая — чтобы не затирать настоящие показы.
function ensureSeeded(db, ensureDay) {
  if (!config.DEMO) return null;
  if (db.data.bookings.length > 0) return null;
  return seed(db, ensureDay);
}

module.exports = { seed, ensureSeeded };
