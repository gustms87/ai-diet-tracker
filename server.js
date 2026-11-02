const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');
const { KOREAN_FOOD_DB, estimateFromTextFallback } = require('./food-db');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// ============================================================================
// 데이터베이스 연결 (libSQL)
//  - 클라우드: TURSO_DATABASE_URL + TURSO_AUTH_TOKEN 환경변수가 있으면 Turso 클라우드 DB 사용
//    (무료 클라우드 서버는 재배포 시 디스크가 초기화되므로 데이터는 반드시 외부 DB에 저장)
//  - 로컬/라즈베리파이: 환경변수가 없으면 data/diet.db 파일(SQLite)에 저장
// ============================================================================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USING_TURSO = Boolean(process.env.TURSO_DATABASE_URL);

let dbUrl = process.env.TURSO_DATABASE_URL;
if (!USING_TURSO) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  dbUrl = 'file:' + path.join(DATA_DIR, 'diet.db').replace(/\\/g, '/');
}

const db = createClient({
  url: dbUrl,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined
});

function rowsToObjects(result) {
  return result.rows.map(row => {
    const obj = {};
    result.columns.forEach((col, i) => {
      const v = row[i];
      obj[col] = typeof v === 'bigint' ? Number(v) : v;
    });
    return obj;
  });
}

function cleanArgs(args) {
  return (args || []).map(a => (a === undefined ? null : a));
}

async function dbAll(sql, args = []) {
  return rowsToObjects(await db.execute({ sql, args: cleanArgs(args) }));
}

async function dbGet(sql, args = []) {
  const rows = await dbAll(sql, args);
  return rows[0];
}

async function dbRun(sql, args = []) {
  const r = await db.execute({ sql, args: cleanArgs(args) });
  return {
    lastInsertRowid: r.lastInsertRowid !== undefined ? Number(r.lastInsertRowid) : null,
    rowsAffected: r.rowsAffected
  };
}

// 테이블 생성
async function initSchema() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS meals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      meal_type TEXT NOT NULL,
      food_name TEXT NOT NULL,
      amount TEXT DEFAULT '1인분',
      calories REAL DEFAULT 0,
      carbs REAL DEFAULT 0,
      protein REAL DEFAULT 0,
      fat REAL DEFAULT 0,
      sugar REAL DEFAULT 0,
      source_type TEXT DEFAULT 'text',
      image_data TEXT DEFAULT NULL,
      ai_note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date)`,
    `CREATE INDEX IF NOT EXISTS idx_meals_date_type ON meals(date, meal_type)`,
    `CREATE TABLE IF NOT EXISTS daily_logs (
      date TEXT PRIMARY KEY,
      weight REAL DEFAULT NULL,
      water_ml INTEGER DEFAULT 0,
      memo TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`
  ], 'write');

  // 기본 설정값 초기화
  await db.batch(
    Object.entries(DEFAULT_SETTINGS)
      .filter(([k]) => k !== 'gemini_api_key')
      .map(([k, v]) => ({
        sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
        args: [k, v]
      })),
    'write'
  );
}

const DEFAULT_SETTINGS = {
  target_calories: '2000',
  target_carbs: '250',
  target_protein: '100',
  target_fat: '65',
  target_sugar: '50',
  target_water: '2000',
  target_weight: '65.0',
  gemini_api_key: '',
  gemini_model: 'gemini-2.5-flash'
};

async function getAllSettings() {
  const rows = await dbAll('SELECT key, value FROM settings');
  const map = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    map[r.key] = r.value;
  }
  // 화면에서 입력한 키가 없으면 서버 환경변수(GEMINI_API_KEY) 사용
  if (!map.gemini_api_key && process.env.GEMINI_API_KEY) {
    map.gemini_api_key = process.env.GEMINI_API_KEY;
  }
  return map;
}

async function setSetting(key, value) {
  await dbRun(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value ?? '')]
  );
}

function todayStr() {
  // 서버 시간대(TZ 환경변수, 예: Asia/Seoul) 기준 오늘 날짜
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 미들웨어 설정 (이미지 Base64 전송을 위해 25MB 허용)
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 헬스체크 (클라우드 상태 확인 / 슬립 방지 핑용, 인증 불필요)
app.get('/healthz', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ============================================================================
// 비밀번호 로그인 (클라우드에 공개되므로 APP_PASSWORD 환경변수가 있으면 잠금)
// ============================================================================
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('diet-secret:' + APP_PASSWORD).digest('hex');
const AUTH_COOKIE = 'diet_auth';
const AUTH_TOKEN = crypto.createHmac('sha256', SESSION_SECRET).update('auth:' + APP_PASSWORD).digest('hex');

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

function isAuthenticated(req) {
  if (!APP_PASSWORD) return true;
  const token = parseCookies(req)[AUTH_COOKIE] || '';
  if (token.length !== AUTH_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN));
}

// 무차별 대입 방지: IP당 15분에 10회까지 로그인 시도 허용
const loginAttempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, since: now };
  if (now - rec.since > 15 * 60 * 1000) {
    rec.count = 0;
    rec.since = now;
  }
  rec.count += 1;
  loginAttempts.set(ip, rec);
  return rec.count > 10;
}

app.get('/api/auth/status', (req, res) => {
  res.json({ required: Boolean(APP_PASSWORD), authenticated: isAuthenticated(req) });
});

app.post('/api/auth/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  if (tooManyAttempts(req.ip)) {
    return res.status(429).json({ error: '로그인 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.' });
  }
  const input = String(req.body?.password || '');
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  loginAttempts.delete(req.ip);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

// 이후 모든 /api 요청은 로그인 필요
app.use('/api', (req, res, next) => {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: '로그인이 필요합니다.', requiresLogin: true });
});

// ============================================================================
// 실시간 동기화 (SSE - Server-Sent Events)
// ============================================================================
const sseClients = new Set();

function broadcastSync(eventType = 'sync', payload = {}) {
  const message = JSON.stringify({
    type: eventType,
    timestamp: new Date().toISOString(),
    connectedClients: sseClients.size,
    ...payload
  });
  for (const client of sseClients) {
    try {
      client.write(`data: ${message}\n\n`);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  sseClients.add(res);
  // 접속 즉시 현재 연결된 기기 수 브로드캐스트
  broadcastSync('clients', {});

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch (_) {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    broadcastSync('clients', {});
  });
});

// ============================================================================
// 서버 접속 주소 안내 API (모바일 연동용)
// ============================================================================
function getLocalNetworkUrls(port) {
  const interfaces = os.networkInterfaces();
  const urls = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        urls.push(`http://${iface.address}:${port}`);
      }
    }
  }
  return urls;
}

app.get('/api/server-info', async (req, res) => {
  const settings = await getAllSettings();
  const isCloud = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
  res.json({
    hostname: os.hostname(),
    platform: `${os.platform()} (${os.arch()})`,
    nodeVersion: process.version,
    isCloud,
    publicUrl: process.env.RENDER_EXTERNAL_URL || null,
    database: USING_TURSO ? 'Turso 클라우드 DB' : '로컬 SQLite 파일',
    localUrls: isCloud ? [] : getLocalNetworkUrls(PORT),
    connectedClients: sseClients.size,
    hasGeminiKey: Boolean(settings.gemini_api_key && settings.gemini_api_key.trim().length > 5)
  });
});

// ============================================================================
// 설정 API
// ============================================================================
app.get('/api/settings', async (req, res) => {
  const s = await getAllSettings();
  const rawKey = (s.gemini_api_key || '').trim();
  res.json({
    target_calories: Number(s.target_calories) || 2000,
    target_carbs: Number(s.target_carbs) || 250,
    target_protein: Number(s.target_protein) || 100,
    target_fat: Number(s.target_fat) || 65,
    target_sugar: Number(s.target_sugar) || 50,
    target_water: Number(s.target_water) || 2000,
    target_weight: Number(s.target_weight) || 65,
    gemini_model: s.gemini_model || 'gemini-2.5-flash',
    has_gemini_key: rawKey.length > 5,
    gemini_key_preview: rawKey.length > 8 ? `${rawKey.slice(0, 4)}••••${rawKey.slice(-4)}` : ''
  });
});

app.post('/api/settings', async (req, res) => {
  const body = req.body || {};
  const allowedKeys = [
    'target_calories',
    'target_carbs',
    'target_protein',
    'target_fat',
    'target_sugar',
    'target_water',
    'target_weight',
    'gemini_model'
  ];
  for (const key of allowedKeys) {
    if (body[key] !== undefined) {
      await setSetting(key, body[key]);
    }
  }
  if (typeof body.gemini_api_key === 'string') {
    const trimmed = body.gemini_api_key.trim();
    if (trimmed === '__CLEAR__') {
      await setSetting('gemini_api_key', '');
    } else if (trimmed.length > 0) {
      await setSetting('gemini_api_key', trimmed);
    }
  }
  broadcastSync('settings_updated');
  res.json({ ok: true });
});

// ============================================================================
// 일별 조회 API (/api/day?date=YYYY-MM-DD)
// ============================================================================
app.get('/api/day', async (req, res) => {
  const date = req.query.date || todayStr();
  const meals = await dbAll('SELECT * FROM meals WHERE date = ? ORDER BY id ASC', [date]);

  const dailyLog = (await dbGet('SELECT * FROM daily_logs WHERE date = ?', [date])) ||
    { date, weight: null, water_ml: 0, memo: '' };

  // 가장 최근 기록된 체중 조회 (오늘 체중 미입력 시 참고 표시용)
  const latestWeightRow = await dbGet(
    'SELECT date, weight FROM daily_logs WHERE weight IS NOT NULL AND date <= ? ORDER BY date DESC LIMIT 1',
    [date]
  );

  const totals = {
    calories: 0,
    carbs: 0,
    protein: 0,
    fat: 0,
    sugar: 0,
    byMealType: {
      breakfast: { calories: 0, carbs: 0, protein: 0, fat: 0, sugar: 0, count: 0 },
      lunch: { calories: 0, carbs: 0, protein: 0, fat: 0, sugar: 0, count: 0 },
      dinner: { calories: 0, carbs: 0, protein: 0, fat: 0, sugar: 0, count: 0 },
      snack: { calories: 0, carbs: 0, protein: 0, fat: 0, sugar: 0, count: 0 }
    }
  };

  for (const m of meals) {
    const cal = Number(m.calories) || 0;
    const c = Number(m.carbs) || 0;
    const p = Number(m.protein) || 0;
    const f = Number(m.fat) || 0;
    const s = Number(m.sugar) || 0;

    totals.calories += cal;
    totals.carbs += c;
    totals.protein += p;
    totals.fat += f;
    totals.sugar += s;

    const slot = totals.byMealType[m.meal_type] || totals.byMealType.snack;
    slot.calories += cal;
    slot.carbs += c;
    slot.protein += p;
    slot.fat += f;
    slot.sugar += s;
    slot.count += 1;
  }

  totals.calories = Math.round(totals.calories);
  totals.carbs = Math.round(totals.carbs * 10) / 10;
  totals.protein = Math.round(totals.protein * 10) / 10;
  totals.fat = Math.round(totals.fat * 10) / 10;
  totals.sugar = Math.round(totals.sugar * 10) / 10;

  res.json({
    date,
    meals,
    dailyLog,
    latestWeight: latestWeightRow || null,
    totals
  });
});

// ============================================================================
// 월별 조회 API (/api/month?year=2026&month=11)
// ============================================================================
function emptyDay(date) {
  return {
    date,
    calories: 0,
    carbs: 0,
    protein: 0,
    fat: 0,
    sugar: 0,
    meals: { breakfast: 0, lunch: 0, dinner: 0, snack: 0 },
    weight: null,
    water_ml: 0,
    memo: ''
  };
}

app.get('/api/month', async (req, res) => {
  const now = new Date();
  const year = String(req.query.year || now.getFullYear());
  const month = String(req.query.month || (now.getMonth() + 1)).padStart(2, '0');
  const prefix = `${year}-${month}-%`;

  const mealRows = await dbAll(`
    SELECT
      date,
      meal_type,
      COUNT(*) as item_count,
      ROUND(SUM(calories)) as calories,
      ROUND(SUM(carbs), 1) as carbs,
      ROUND(SUM(protein), 1) as protein,
      ROUND(SUM(fat), 1) as fat,
      ROUND(SUM(sugar), 1) as sugar
    FROM meals
    WHERE date LIKE ?
    GROUP BY date, meal_type
    ORDER BY date ASC
  `, [prefix]);

  const logRows = await dbAll(`
    SELECT date, weight, water_ml, memo
    FROM daily_logs
    WHERE date LIKE ?
    ORDER BY date ASC
  `, [prefix]);

  const daysMap = {};

  for (const r of mealRows) {
    if (!daysMap[r.date]) daysMap[r.date] = emptyDay(r.date);
    const d = daysMap[r.date];
    d.calories += Number(r.calories) || 0;
    d.carbs = Math.round((d.carbs + (Number(r.carbs) || 0)) * 10) / 10;
    d.protein = Math.round((d.protein + (Number(r.protein) || 0)) * 10) / 10;
    d.fat = Math.round((d.fat + (Number(r.fat) || 0)) * 10) / 10;
    d.sugar = Math.round((d.sugar + (Number(r.sugar) || 0)) * 10) / 10;
    if (d.meals[r.meal_type] !== undefined) {
      d.meals[r.meal_type] = Math.round(Number(r.calories) || 0);
    }
  }

  for (const l of logRows) {
    if (!daysMap[l.date]) daysMap[l.date] = emptyDay(l.date);
    daysMap[l.date].weight = l.weight;
    daysMap[l.date].water_ml = l.water_ml || 0;
    daysMap[l.date].memo = l.memo || '';
  }

  const settings = await getAllSettings();
  const targetCal = Number(settings.target_calories) || 2000;

  const activeMealDays = Object.values(daysMap).filter(d => d.calories > 0);
  const totalCal = activeMealDays.reduce((acc, d) => acc + d.calories, 0);
  const avgCalories = activeMealDays.length > 0 ? Math.round(totalCal / activeMealDays.length) : 0;
  // 목표 칼로리의 80% ~ 110% 이내 달성 일수
  const goalMetDays = activeMealDays.filter(
    d => d.calories >= targetCal * 0.8 && d.calories <= targetCal * 1.1
  ).length;

  const weightDays = Object.values(daysMap)
    .filter(d => d.weight !== null && d.weight > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json({
    year: Number(year),
    month: Number(month),
    days: daysMap,
    summary: {
      loggedDays: activeMealDays.length,
      avgCalories,
      totalCalories: Math.round(totalCal),
      goalMetDays,
      startWeight: weightDays.length > 0 ? weightDays[0].weight : null,
      endWeight: weightDays.length > 0 ? weightDays[weightDays.length - 1].weight : null
    }
  });
});

// ============================================================================
// 년도별 조회 API (/api/year?year=2026)
// ============================================================================
app.get('/api/year', async (req, res) => {
  const year = String(req.query.year || new Date().getFullYear());
  const prefix = `${year}-%`;
  const settings = await getAllSettings();
  const targetCal = Number(settings.target_calories) || 2000;

  // 일별 합계를 먼저 구한 뒤 월별로 집계
  const dailyTotals = await dbAll(`
    SELECT
      date,
      substr(date, 1, 7) as ym,
      SUM(calories) as calories,
      SUM(carbs) as carbs,
      SUM(protein) as protein,
      SUM(fat) as fat,
      SUM(sugar) as sugar,
      COUNT(*) as item_count
    FROM meals
    WHERE date LIKE ?
    GROUP BY date
    ORDER BY date ASC
  `, [prefix]);

  const dailyLogs = await dbAll(`
    SELECT date, substr(date, 1, 7) as ym, weight, water_ml
    FROM daily_logs
    WHERE date LIKE ?
    ORDER BY date ASC
  `, [prefix]);

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, '0')}`;
    const mDays = dailyTotals.filter(d => d.ym === ym && d.calories > 0);
    const mLogs = dailyLogs.filter(l => l.ym === ym);

    const loggedDays = mDays.length;
    const sumCal = mDays.reduce((a, b) => a + (Number(b.calories) || 0), 0);
    const sumCarbs = mDays.reduce((a, b) => a + (Number(b.carbs) || 0), 0);
    const sumProtein = mDays.reduce((a, b) => a + (Number(b.protein) || 0), 0);
    const sumFat = mDays.reduce((a, b) => a + (Number(b.fat) || 0), 0);
    const goalMetDays = mDays.filter(
      d => d.calories >= targetCal * 0.8 && d.calories <= targetCal * 1.1
    ).length;

    const weights = mLogs.filter(l => l.weight !== null && l.weight > 0).map(l => Number(l.weight));
    const avgWeight = weights.length > 0
      ? Math.round((weights.reduce((a, b) => a + b, 0) / weights.length) * 10) / 10
      : null;

    const waters = mLogs.filter(l => l.water_ml > 0).map(l => Number(l.water_ml));
    const avgWater = waters.length > 0
      ? Math.round(waters.reduce((a, b) => a + b, 0) / waters.length)
      : 0;

    months.push({
      month: m,
      ym,
      loggedDays,
      totalCalories: Math.round(sumCal),
      avgCalories: loggedDays > 0 ? Math.round(sumCal / loggedDays) : 0,
      avgCarbs: loggedDays > 0 ? Math.round(sumCarbs / loggedDays) : 0,
      avgProtein: loggedDays > 0 ? Math.round(sumProtein / loggedDays) : 0,
      avgFat: loggedDays > 0 ? Math.round(sumFat / loggedDays) : 0,
      goalMetDays,
      avgWeight,
      avgWater
    });
  }

  const totalLoggedDays = dailyTotals.filter(d => d.calories > 0).length;
  const yearTotalCalories = dailyTotals.reduce((a, b) => a + (Number(b.calories) || 0), 0);

  res.json({
    year: Number(year),
    months,
    yearSummary: {
      totalLoggedDays,
      yearTotalCalories: Math.round(yearTotalCalories),
      yearAvgCalories: totalLoggedDays > 0 ? Math.round(yearTotalCalories / totalLoggedDays) : 0
    }
  });
});

// ============================================================================
// 식단 추가 / 수정 / 삭제 API
// ============================================================================
const INSERT_MEAL_SQL = `
  INSERT INTO meals (
    date, meal_type, food_name, amount,
    calories, carbs, protein, fat, sugar,
    source_type, image_data, ai_note
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

app.post('/api/meals', async (req, res) => {
  const { date, meal_type, items, source_type, image_data } = req.body || {};
  const list = Array.isArray(items) ? items : [req.body];

  const statements = [];
  const affectedDates = new Set();

  for (const item of list) {
    const itemDate = item.date || date || todayStr();
    const itemMealType = item.meal_type || meal_type || 'lunch';
    const foodName = String(item.food_name || '').trim();
    if (!foodName) continue;

    affectedDates.add(itemDate);
    statements.push({
      sql: INSERT_MEAL_SQL,
      args: cleanArgs([
        itemDate,
        itemMealType,
        foodName,
        String(item.amount || '1인분'),
        Math.max(0, Number(item.calories) || 0),
        Math.max(0, Number(item.carbs) || 0),
        Math.max(0, Number(item.protein) || 0),
        Math.max(0, Number(item.fat) || 0),
        Math.max(0, Number(item.sugar) || 0),
        item.source_type || source_type || 'text',
        item.image_data !== undefined ? item.image_data : (image_data || null),
        String(item.ai_note || '')
      ])
    });
  }

  const results = statements.length > 0 ? await db.batch(statements, 'write') : [];
  const insertedIds = results.map(r => Number(r.lastInsertRowid));

  broadcastSync('meals_updated', { dates: Array.from(affectedDates) });
  res.json({ ok: true, insertedIds });
});

app.put('/api/meals/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await dbGet('SELECT * FROM meals WHERE id = ?', [id]);
  if (!existing) {
    return res.status(404).json({ error: '식단 항목을 찾을 수 없습니다.' });
  }

  const b = req.body || {};
  const updatedDate = b.date || existing.date;
  const updatedMealType = b.meal_type || existing.meal_type;
  const updatedName = String(b.food_name ?? existing.food_name).trim();
  const updatedAmount = String(b.amount ?? existing.amount).trim();
  const updatedCal = Math.max(0, Number(b.calories ?? existing.calories) || 0);
  const updatedCarbs = Math.max(0, Number(b.carbs ?? existing.carbs) || 0);
  const updatedProtein = Math.max(0, Number(b.protein ?? existing.protein) || 0);
  const updatedFat = Math.max(0, Number(b.fat ?? existing.fat) || 0);
  const updatedSugar = Math.max(0, Number(b.sugar ?? existing.sugar) || 0);

  await dbRun(`
    UPDATE meals
    SET date = ?, meal_type = ?, food_name = ?, amount = ?,
        calories = ?, carbs = ?, protein = ?, fat = ?, sugar = ?
    WHERE id = ?
  `, [
    updatedDate,
    updatedMealType,
    updatedName,
    updatedAmount,
    updatedCal,
    updatedCarbs,
    updatedProtein,
    updatedFat,
    updatedSugar,
    id
  ]);

  broadcastSync('meals_updated', { dates: [existing.date, updatedDate] });
  res.json({ ok: true });
});

app.delete('/api/meals/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await dbGet('SELECT date FROM meals WHERE id = ?', [id]);
  await dbRun('DELETE FROM meals WHERE id = ?', [id]);
  if (existing) {
    broadcastSync('meals_updated', { dates: [existing.date] });
  }
  res.json({ ok: true });
});

// ============================================================================
// 체중 / 음수량(물) / 일일 메모 저장 API
// ============================================================================
app.post('/api/daily-log', async (req, res) => {
  const { date, weight, water_ml, water_delta, memo } = req.body || {};
  if (!date) {
    return res.status(400).json({ error: '날짜(date)가 필요합니다.' });
  }

  const current = (await dbGet('SELECT * FROM daily_logs WHERE date = ?', [date])) || {
    date,
    weight: null,
    water_ml: 0,
    memo: ''
  };

  let nextWeight = current.weight;
  if (weight !== undefined) {
    nextWeight = weight === '' || weight === null ? null : Number(weight);
  }

  let nextWater = current.water_ml || 0;
  if (water_ml !== undefined) {
    nextWater = Math.max(0, Number(water_ml) || 0);
  } else if (water_delta !== undefined) {
    nextWater = Math.max(0, nextWater + (Number(water_delta) || 0));
  }

  const nextMemo = memo !== undefined ? String(memo) : (current.memo || '');

  await dbRun(`
    INSERT INTO daily_logs (date, weight, water_ml, memo, updated_at)
    VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(date) DO UPDATE SET
      weight = excluded.weight,
      water_ml = excluded.water_ml,
      memo = excluded.memo,
      updated_at = datetime('now', 'localtime')
  `, [date, nextWeight, nextWater, nextMemo]);

  broadcastSync('daily_log_updated', { dates: [date] });
  res.json({
    ok: true,
    dailyLog: { date, weight: nextWeight, water_ml: nextWater, memo: nextMemo }
  });
});

// ============================================================================
// 음식 자동완성 및 최근 먹은 식단 추천 API
// ============================================================================
app.get('/api/foods/suggest', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();

  // 최근 내가 기록했던 음식 (중복 제거)
  const recentRows = await dbAll(`
    SELECT food_name, amount, ROUND(AVG(calories)) as calories,
           ROUND(AVG(carbs), 1) as carbs, ROUND(AVG(protein), 1) as protein,
           ROUND(AVG(fat), 1) as fat, ROUND(AVG(sugar), 1) as sugar,
           COUNT(*) as freq
    FROM meals
    GROUP BY food_name
    ORDER BY MAX(id) DESC
    LIMIT 30
  `);

  const suggestions = [];
  const seen = new Set();

  for (const r of recentRows) {
    if (!q || r.food_name.toLowerCase().includes(q)) {
      seen.add(r.food_name);
      suggestions.push({
        food_name: r.food_name,
        amount: r.amount,
        calories: r.calories,
        carbs: r.carbs,
        protein: r.protein,
        fat: r.fat,
        sugar: r.sugar,
        source: 'recent',
        freq: r.freq
      });
    }
  }

  for (const item of KOREAN_FOOD_DB) {
    const matched = !q ||
      item.name.toLowerCase().includes(q) ||
      item.keywords.some(k => k.toLowerCase().includes(q));
    if (matched && !seen.has(item.name)) {
      seen.add(item.name);
      suggestions.push({
        food_name: item.name,
        amount: item.unit,
        calories: item.calories,
        carbs: item.carbs,
        protein: item.protein,
        fat: item.fat,
        sugar: item.sugar,
        source: 'db'
      });
    }
    if (suggestions.length >= 25) break;
  }

  res.json({ suggestions });
});

// ============================================================================
// Google Gemini AI 분석 API (텍스트 / 음식 사진 / 식단표 캡처)
// ============================================================================
async function callGeminiAPI({ apiKey, preferredModel, parts, systemInstruction }) {
  const modelsToTry = Array.from(new Set([
    preferredModel || 'gemini-2.5-flash',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash'
  ]));

  let lastError = null;
  for (const modelName of modelsToTry) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: [
        {
          role: 'user',
          parts
        }
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json'
      }
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await response.json();
      if (!response.ok) {
        lastError = new Error(data?.error?.message || `Gemini API 오류 (${response.status})`);
        // API 키 자체 오류인 경우 즉시 중단
        if (response.status === 400 && /API_KEY_INVALID|API key not valid/i.test(lastError.message)) {
          throw new Error('입력하신 Gemini API 키가 유효하지 않습니다. 설정에서 키를 확인해 주세요.');
        }
        continue;
      }

      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      return {
        parsed: JSON.parse(cleaned),
        modelUsed: modelName
      };
    } catch (err) {
      lastError = err;
      if (err.message.includes('유효하지 않습니다')) throw err;
    }
  }

  throw lastError || new Error('Gemini AI 응답을 가져오지 못했습니다.');
}

app.post('/api/ai/analyze', async (req, res) => {
  try {
    const {
      mode = 'text', // 'text' | 'photo' | 'menu_table'
      text = '',
      imageBase64 = '',
      mimeType = 'image/jpeg',
      targetDate = todayStr(),
      targetMealType = 'lunch'
    } = req.body || {};

    const settings = await getAllSettings();
    const apiKey = (settings.gemini_api_key || '').trim();

    // 1. Gemini API 키가 있는 경우 -> 정밀 AI 멀티모달 분석 수행
    if (apiKey.length > 5) {
      const parts = [];

      if (imageBase64) {
        const cleanBase64 = imageBase64.replace(/^data:[^;]+;base64,/, '');
        parts.push({
          inlineData: {
            mimeType: mimeType || 'image/jpeg',
            data: cleanBase64
          }
        });
      }

      let systemPrompt = '';
      if (mode === 'menu_table') {
        systemPrompt = `당신은 한국 전문 영양사 및 식단표 OCR 분석 AI입니다.
사용자가 업로드한 '식단표(구내식당/학교/회사/병원 주간·월간·일간 식단표 캡처 이미지)'와 추가 메모를 분석하세요.
기준 날짜(targetDate): ${targetDate}, 기본 식사 구분(targetMealType): ${targetMealType}.

반드시 다음 JSON 스키마 형식으로만 응답하세요:
{
  "summary": "식단표 분석 한줄 요약 및 영양 코멘트",
  "is_multi_slot": true 또는 false (여러 날짜나 아침/점심/저녁 여러 끼니가 표에 있으면 true),
  "slots": [
    {
      "label": "표시용 제목 (예: '11월 2일(월) 중식' 또는 '중식 코너 A')",
      "date": "YYYY-MM-DD (날짜를 알 수 있으면 targetDate 기준 계산, 모르면 '${targetDate}')",
      "meal_type": "breakfast | lunch | dinner | snack 중 하나 (조식=breakfast, 중식/점심=lunch, 석식/저녁=dinner, 간식=snack)",
      "total_calories": 720,
      "items": [
        {
          "food_name": "음식명 (예: 현미밥, 제육볶음, 시금치된장국)",
          "amount": "1인분 기준 분량 (예: 1공기, 1인분, 1접시)",
          "calories": 300,
          "carbs": 65,
          "protein": 6,
          "fat": 1,
          "sugar": 0,
          "ai_note": "간단 설명"
        }
      ]
    }
  ],
  "items": [
    // 사용자가 현재 선택한 끼니에 바로 넣을 수 있도록 대표(또는 첫 번째/요청된) 끼니의 음식 목록
  ]
}`;
        parts.push({
          text: text
            ? `업로드된 식단표 이미지를 분석해 주세요. 사용자 추가 요청/메모: "${text}"`
            : `업로드된 식단표 이미지를 읽고 날짜별/끼니별 메뉴와 각 메뉴의 칼로리(kcal), 탄수화물(g), 단백질(g), 지방(g), 당류(g)를 계산해 주세요.`
        });
      } else {
        systemPrompt = `당신은 한국 음식과 외식/가정식/다이어트식에 정통한 전문 AI 영양사입니다.
사용자가 입력한 텍스트 또는 음식 사진을 분석하여 각 음식별 분량과 영양성분(칼로리 kcal, 탄수화물 g, 단백질 g, 지방 g, 당류 g)을 정확하게 추정하세요.

반드시 다음 JSON 스키마 형식으로만 응답하세요:
{
  "summary": "식사 구성에 대한 친절하고 실용적인 영양사 한줄 코멘트 (예: 단백질이 풍부한 식단입니다. 나트륨 배출을 위해 물을 충분히 드세요.)",
  "items": [
    {
      "food_name": "한국어 음식명",
      "amount": "추정 섭취량 (예: 1인분(250g), 반공기, 1잔 등)",
      "calories": 350,
      "carbs": 45,
      "protein": 20,
      "fat": 10,
      "sugar": 4,
      "ai_note": "판단 근거 또는 영양 특징"
    }
  ]
}`;
        if (mode === 'photo') {
          parts.push({
            text: text
              ? `이 음식 사진을 분석해 각 음식의 칼로리와 영양성분을 계산해 주세요. 사용자 메모: "${text}"`
              : `이 음식 사진에 보이는 모든 음식/반찬/음료를 식별하고 1인분 섭취 기준 칼로리와 탄수화물, 단백질, 지방, 당류를 계산해 주세요.`
          });
        } else {
          parts.push({
            text: `다음 먹은 음식 목록의 칼로리와 영양성분을 분석해 주세요: "${text}"`
          });
        }
      }

      const { parsed, modelUsed } = await callGeminiAPI({
        apiKey,
        preferredModel: settings.gemini_model,
        parts,
        systemInstruction: systemPrompt
      });

      // slots만 있고 items가 비어있다면 첫 번째 slot의 items를 기본 채움
      let flatItems = Array.isArray(parsed.items) ? parsed.items : [];
      if (flatItems.length === 0 && Array.isArray(parsed.slots) && parsed.slots.length > 0) {
        flatItems = parsed.slots[0].items || [];
      }

      return res.json({
        engine: `Google Gemini (${modelUsed})`,
        mode,
        summary: parsed.summary || 'AI 영양성분 분석이 완료되었습니다.',
        is_multi_slot: Boolean(parsed.is_multi_slot && Array.isArray(parsed.slots) && parsed.slots.length > 0),
        slots: Array.isArray(parsed.slots) ? parsed.slots : [],
        items: flatItems
      });
    }

    // 2. Gemini API 키가 아직 설정되지 않은 경우 -> 내장 한국 음식 DB 폴백 처리
    if (text && text.trim().length > 0) {
      const fallbackItems = estimateFromTextFallback(text);
      return res.json({
        engine: '내장 한국음식 영양DB (오프라인 스마트 추정)',
        mode,
        summary: '내장 영양 데이터베이스로 계산되었습니다. 우측 상단 [설정]에서 무료 Google Gemini API 키를 등록하면 음식 사진·식단표 캡처 이미지 자동 인식까지 사용할 수 있습니다!',
        is_multi_slot: false,
        slots: [],
        items: fallbackItems
      });
    }

    // 이미지 업로드인데 API 키도 없고 텍스트 설명도 없는 경우
    return res.status(400).json({
      requiresApiKey: true,
      error: '음식 사진 및 식단표 캡처 이미지를 AI로 인식하려면 무료 Google Gemini API 키 설정이 필요합니다. 우측 상단 [⚙️ 설정] 버튼에서 API 키를 등록하거나, 아래 입력창에 음식 이름을 함께 적어주세요.'
    });
  } catch (err) {
    console.error('[AI Analyze Error]:', err);
    res.status(500).json({
      error: err.message || 'AI 칼로리 분석 중 오류가 발생했습니다.'
    });
  }
});

// ============================================================================
// 데이터 백업(내보내기) 및 복원(가져오기) API (클라우드/라즈베리파이 이전용)
// ============================================================================
app.get('/api/backup/export', async (req, res) => {
  const meals = await dbAll('SELECT * FROM meals ORDER BY date ASC, id ASC');
  const dailyLogs = await dbAll('SELECT * FROM daily_logs ORDER BY date ASC');
  const settings = await getAllSettings();
  delete settings.gemini_api_key; // 보안상 API 키는 백업 파일에서 제외

  res.json({
    version: '1.0',
    exportedAt: new Date().toISOString(),
    settings,
    meals,
    dailyLogs
  });
});

app.post('/api/backup/import', async (req, res) => {
  const { meals = [], dailyLogs = [], settings = {} } = req.body || {};

  const statements = [];
  for (const [k, v] of Object.entries(settings)) {
    if (k !== 'gemini_api_key') {
      statements.push({
        sql: `INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [k, String(v ?? '')]
      });
    }
  }

  for (const m of meals) {
    statements.push({
      sql: INSERT_MEAL_SQL,
      args: cleanArgs([
        m.date,
        m.meal_type || 'lunch',
        m.food_name,
        m.amount || '1인분',
        Number(m.calories) || 0,
        Number(m.carbs) || 0,
        Number(m.protein) || 0,
        Number(m.fat) || 0,
        Number(m.sugar) || 0,
        m.source_type || 'manual',
        m.image_data || null,
        m.ai_note || ''
      ])
    });
  }

  for (const l of dailyLogs) {
    statements.push({
      sql: `
        INSERT INTO daily_logs (date, weight, water_ml, memo)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          weight = COALESCE(excluded.weight, daily_logs.weight),
          water_ml = MAX(excluded.water_ml, daily_logs.water_ml),
          memo = CASE WHEN excluded.memo != '' THEN excluded.memo ELSE daily_logs.memo END
      `,
      args: cleanArgs([l.date, l.weight ?? null, l.water_ml || 0, l.memo || ''])
    });
  }

  try {
    // batch는 하나의 트랜잭션으로 실행되어 실패 시 전체 롤백됩니다.
    if (statements.length > 0) await db.batch(statements, 'write');
    broadcastSync('full_reload');
    res.json({ ok: true, importedMeals: meals.length, importedLogs: dailyLogs.length });
  } catch (err) {
    res.status(500).json({ error: '데이터 복원 중 오류: ' + err.message });
  }
});

// 존재하지 않는 API
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API를 찾을 수 없습니다.' });
});

// SPA 라우팅 폴백
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 공통 에러 처리 (DB 연결 오류 등)
app.use((err, req, res, next) => {
  console.error('[Server Error]:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '서버 오류: ' + (err.message || '알 수 없는 오류') });
});

initSchema()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      const localUrls = getLocalNetworkUrls(PORT);
      console.log(`============================================================`);
      console.log(`🥗 AI 스마트 식단관리표 서버가 시작되었습니다!`);
      console.log(`   - PC 접속 주소     : http://localhost:${PORT}`);
      if (localUrls.length > 0 && !process.env.RENDER) {
        console.log(`   - 모바일 접속 주소 : ${localUrls.join(' , ')}`);
      }
      console.log(`   - 데이터베이스     : ${USING_TURSO ? 'Turso 클라우드 DB' : dbUrl}`);
      console.log(`   - 비밀번호 잠금    : ${APP_PASSWORD ? '사용' : '미사용 (APP_PASSWORD 미설정)'}`);
      console.log(`============================================================`);
    });
  })
  .catch(err => {
    console.error('데이터베이스 초기화 실패:', err);
    process.exit(1);
  });
