// ============================================================================
//  utils.js — маленькие помощники: даты, время, красивый текст.
//  Этот файл менять не нужно.
// ============================================================================

const config = require('./config');

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

// --- Сейчас, но сдвинуто в ташкентское время -------------------------------
// Хитрость: мы двигаем время на +5 часов и дальше читаем его "как UTC".
// Так не нужны сложные библиотеки часовых поясов.
function tzNow() {
  return new Date(Date.now() + config.TZ_OFFSET_HOURS * MS_HOUR);
}

// Дата -> строка "2026-08-04"
function dateToStr(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Сегодняшняя дата по Ташкенту, строкой
function todayStr() {
  return dateToStr(tzNow());
}

// Текущее время по Ташкенту, строкой "14:35"
function nowTimeStr() {
  const d = tzNow();
  return (
    String(d.getUTCHours()).padStart(2, '0') +
    ':' +
    String(d.getUTCMinutes()).padStart(2, '0')
  );
}

// "2026-08-04" + 3 дня -> "2026-08-07"
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dateToStr(dt);
}

// Сколько дней между двумя датами-строками
function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / MS_DAY);
}

// Точный момент начала окна в "мировом" времени (для сравнения с now)
function slotTimestamp(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - config.TZ_OFFSET_HOURS * MS_HOUR;
}

// Окно уже прошло?
function isPastSlot(dateStr, timeStr) {
  return slotTimestamp(dateStr, timeStr) <= Date.now();
}

// День недели: 0 = вс, 1 = пн ... 6 = сб
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isDayOff(dateStr) {
  return config.DAYS_OFF.includes(weekdayOf(dateStr));
}

// --- Названия дней и месяцев ------------------------------------------------
const WD_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const WD_FULL = [
  'воскресенье', 'понедельник', 'вторник', 'среда',
  'четверг', 'пятница', 'суббота',
];
const MONTH_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const MONTH_SHORT = [
  'янв', 'фев', 'мар', 'апр', 'мая', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

// "2026-08-04" -> "4 авг, вт"  (для кнопок — коротко)
function formatDateShort(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTH_SHORT[m - 1]}, ${WD_SHORT[weekdayOf(dateStr)]}`;
}

// "2026-08-04" -> "4 августа, вторник"  (для текста — подробно)
function formatDateFull(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTH_GEN[m - 1]}, ${WD_FULL[weekdayOf(dateStr)]}`;
}

// Приписка "сегодня" / "завтра"
function dayLabel(dateStr) {
  const diff = daysBetween(todayStr(), dateStr);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  return '';
}

// --- Сетка часов ------------------------------------------------------------
// Возвращает ['09:00','11:00','13:00','15:00','17:00'] при шаге 2 часа.
function allSlotTimes() {
  const out = [];
  for (
    let h = config.WORK_START_HOUR;
    h + config.SLOT_STEP_HOURS <= config.WORK_END_HOUR;
    h += config.SLOT_STEP_HOURS
  ) {
    out.push(String(h).padStart(2, '0') + ':00');
  }
  return out;
}

// Внутри кнопок Telegram мы разделяем части двоеточием, поэтому само время
// пишем без двоеточия: "11:00" -> "1100" и обратно.
function encTime(t) {
  return String(t).replace(':', '');
}
function decTime(x) {
  const s = String(x).padStart(4, '0');
  return s.slice(0, 2) + ':' + s.slice(2);
}

// --- Безопасность и чистка ввода -------------------------------------------

// Экранирование текста перед вставкой в HTML-сообщение Telegram.
// Без этого имя вида "<b>Аня" сломает сообщение.
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Метка источника: только латиница, цифры, дефис, подчёркивание. Максимум 32.
function sanitizeSource(raw) {
  if (!raw) return '';
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

// Приводим телефон к аккуратному виду и проверяем, что это вообще телефон.
function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  const digits = s.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  if (!s.startsWith('+')) {
    // 9 цифр — это местный номер без кода страны, добавляем +998
    if (digits.length === 9) return '+998' + digits;
    return '+' + digits;
  }
  return '+' + digits;
}

// Имя клиента из Telegram
function fullName(from) {
  if (!from) return 'Без имени';
  const n = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return n || from.username || 'Без имени';
}

function pluralRu(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  MS_HOUR,
  MS_DAY,
  tzNow,
  dateToStr,
  todayStr,
  nowTimeStr,
  addDays,
  daysBetween,
  slotTimestamp,
  isPastSlot,
  weekdayOf,
  isDayOff,
  formatDateShort,
  formatDateFull,
  dayLabel,
  allSlotTimes,
  encTime,
  decTime,
  escapeHtml,
  sanitizeSource,
  normalizePhone,
  fullName,
  pluralRu,
  sleep,
};
