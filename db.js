// ============================================================================
//  db.js — "база данных". На самом деле это один обычный файл db.json.
//
//  Главное правило: файл лежит в папке DATA_DIR.
//  На Railway это должен быть /data (подключённый Volume),
//  иначе при каждом обновлении бота все записи сотрутся.
// ============================================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'db.json');
const TMP = path.join(DATA_DIR, 'db.json.tmp');

// Пустая структура — с неё начинаем, если файла ещё нет.
function emptyData() {
  return {
    version: 1,
    lastId: 0,
    // slots['m1']['2026-08-04']['09:00'] = 'open' | 'closed' | 'booked'
    slots: {},
    // clients['123456789'] = { ... }
    clients: {},
    // bookings = [ { ... }, { ... } ]
    bookings: [],
    meta: {},
  };
}

let data = emptyData();

// Сюда index.js подставит функцию, которая шлёт тревогу мне в Telegram,
// если файл вдруг не сохранился.
let saveErrorHandler = null;
function onSaveError(fn) {
  saveErrorHandler = fn;
}

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    if (fs.existsSync(FILE)) {
      const raw = fs.readFileSync(FILE, 'utf8');
      const parsed = JSON.parse(raw);
      data = Object.assign(emptyData(), parsed);
      // подстраховка: если какого-то раздела нет — создаём пустой
      data.slots = data.slots || {};
      data.clients = data.clients || {};
      data.bookings = data.bookings || [];
      data.meta = data.meta || {};
    } else {
      data = emptyData();
      save();
    }
  } catch (e) {
    // Файл повреждён — не затираем его молча, а откладываем в сторону.
    console.error('[db] не удалось прочитать базу:', e.message);
    try {
      if (fs.existsSync(FILE)) {
        const backup = FILE + '.broken.' + Date.now();
        fs.copyFileSync(FILE, backup);
        console.error('[db] повреждённый файл сохранён как', backup);
      }
    } catch (_) {
      /* ничего не поделать */
    }
    data = emptyData();
  }
  return data;
}

// Атомарная запись: сначала во временный файл, потом переименование.
// Так файл db.json либо старый целый, либо новый целый — но никогда не рваный.
function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TMP, JSON.stringify(data), 'utf8');
    fs.renameSync(TMP, FILE);
    return true;
  } catch (e) {
    console.error('[db] ОШИБКА СОХРАНЕНИЯ:', e.message);
    if (saveErrorHandler) {
      try {
        saveErrorHandler(e);
      } catch (_) {
        /* не даём упасть из-за обработчика */
      }
    }
    return false;
  }
}

function nextId() {
  data.lastId = (data.lastId || 0) + 1;
  return data.lastId;
}

module.exports = {
  DATA_DIR,
  FILE,
  load,
  save,
  nextId,
  onSaveError,
  get data() {
    return data;
  },
};
