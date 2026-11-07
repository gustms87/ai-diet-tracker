// ============================================================================
// AI 스마트 식단관리표 - 프론트엔드 애플리케이션 (app.js)
// ============================================================================

const MEAL_TYPES = [
  { key: 'breakfast', label: '아침', emoji: '🌅', desc: '하루를 여는 아침 식사' },
  { key: 'lunch', label: '점심', emoji: '☀️', desc: '든든한 점심 식사' },
  { key: 'dinner', label: '저녁', emoji: '🌙', desc: '균형 잡힌 저녁 식사' },
  { key: 'snack', label: '간식', emoji: '🍎', desc: '커피·과일·단백질 보충' }
];

const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];

// 전역 상태
const state = {
  currentView: 'daily', // 'daily' | 'monthly' | 'yearly'
  selectedDate: getLocalTodayStr(),
  selectedYear: new Date().getFullYear(),
  selectedMonth: new Date().getMonth() + 1,
  settings: {
    target_calories: 2000,
    target_carbs: 250,
    target_protein: 100,
    target_fat: 65,
    target_sugar: 50,
    target_water: 2000,
    target_weight: 65.0,
    gemini_model: 'gemini-2.5-flash',
    has_gemini_key: false,
    gemini_key_preview: ''
  },
  dayData: null,
  monthData: null,
  yearData: null,
  // 모달 상태
  modalMode: 'text', // 'text' | 'photo' | 'menu_table'
  uploadedImageBase64: '',
  uploadedThumbBase64: '',
  uploadedMimeType: 'image/jpeg',
  stagedItems: [],
  detectedSlots: []
};

function getLocalTodayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function showToast(msg) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

// ============================================================================
// 초기화 및 PWA 서비스워커 / 실시간 동기화(SSE) 연결
// ============================================================================
// 로그인 세션이 만료되면(401) 어떤 API 호출이든 로그인 화면을 띄웁니다.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await nativeFetch(...args);
  const url = String(args[0] && args[0].url ? args[0].url : args[0]);
  if (res.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
    showLoginOverlay();
  }
  return res;
};

let appStarted = false;

document.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  const [y, m] = state.selectedDate.split('-').map(Number);
  state.selectedYear = y;
  state.selectedMonth = m;

  bindEvents();
  bindLoginForm();

  try {
    const res = await nativeFetch('/api/auth/status');
    const auth = await res.json();
    if (auth.required && !auth.authenticated) {
      showLoginOverlay();
      return;
    }
  } catch (_) {}

  await startApp();
});

async function startApp() {
  if (appStarted) {
    await loadSettings();
    await refreshCurrentView();
    return;
  }
  appStarted = true;
  connectRealtimeSync();
  await loadSettings();
  await refreshCurrentView();
  loadServerInfo();
}

function showLoginOverlay() {
  document.getElementById('loginOverlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('loginPasswordInput').focus(), 50);
}

function bindLoginForm() {
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('loginPasswordInput');
    const errEl = document.getElementById('loginErrorText');
    const btn = document.getElementById('loginSubmitBtn');
    btn.disabled = true;
    errEl.textContent = '';
    try {
      const res = await nativeFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value })
      });
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = data.error || '로그인에 실패했습니다.';
        return;
      }
      input.value = '';
      document.getElementById('loginOverlay').classList.add('hidden');
      await startApp();
    } catch (err) {
      errEl.textContent = '서버에 연결할 수 없습니다. (클라우드 서버가 깨어나는 중일 수 있어요. 잠시 후 다시 시도해 주세요)';
    } finally {
      btn.disabled = false;
    }
  });
}

function connectRealtimeSync() {
  const dot = document.getElementById('syncDot');
  const text = document.getElementById('syncStatusText');

  const es = new EventSource('/api/events');
  es.onopen = () => {
    dot.classList.add('online');
    text.textContent = '실시간 동기화됨';
  };

  es.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.connectedClients) {
        text.textContent = `실시간 동기화 (${data.connectedClients}대 연결됨)`;
      }
      if (
        data.type === 'meals_updated' ||
        data.type === 'daily_log_updated' ||
        data.type === 'settings_updated' ||
        data.type === 'full_reload'
      ) {
        if (data.type === 'settings_updated' || data.type === 'full_reload') {
          loadSettings();
        }
        refreshCurrentView();
      }
    } catch (_) {}
  };

  es.onerror = () => {
    dot.classList.remove('online');
    text.textContent = '재연결 중...';
  };

  // 화면 포커스 복귀 시 최신 데이터 동기화
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshCurrentView();
    }
  });
}

// ============================================================================
// API 호출 및 데이터 로드
// ============================================================================
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    state.settings = { ...state.settings, ...data };
  } catch (_) {}
}

async function loadServerInfo() {
  try {
    const res = await fetch('/api/server-info');
    const info = await res.json();
    const box = document.getElementById('localUrlsList');
    if (info.isCloud) {
      const url = info.publicUrl || window.location.origin;
      box.innerHTML = `<div>☁️ 클라우드 주소 (어디서나 접속 가능): <a href="${url}" target="_blank">${url}</a></div>
        <div style="font-size:0.78rem;font-weight:500;color:#475569;margin-top:4px;">저장소: ${escapeHtml(info.database)}</div>`;
    } else {
      const lines = [];
      if (info.tunnelUrl) {
        lines.push(`<div style="margin-bottom:6px;">🌍 <b>LTE/외부 접속 주소:</b> <a href="${info.tunnelUrl}" target="_blank">${info.tunnelUrl}</a></div>`);
      }
      if (info.localUrls && info.localUrls.length > 0) {
        lines.push(...info.localUrls.map(u => `<div>🏠 <b>집 Wi-Fi 주소:</b> <a href="${u}" target="_blank">${u}</a></div>`));
      }
      box.innerHTML = lines.length > 0 ? lines.join('') : window.location.origin;
    }
  } catch (_) {}
}

async function refreshCurrentView() {
  if (state.currentView === 'daily') {
    await loadDailyData(state.selectedDate);
  } else if (state.currentView === 'monthly') {
    await loadMonthlyData(state.selectedYear, state.selectedMonth);
  } else if (state.currentView === 'yearly') {
    await loadYearlyData(state.selectedYear);
  }
}

function switchView(viewName) {
  state.currentView = viewName;

  document.querySelectorAll('.view-section').forEach(sec => {
    sec.classList.toggle('active', sec.id === `view-${viewName}`);
  });
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  document.querySelectorAll('.mob-nav-btn[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  refreshCurrentView();
}

// ============================================================================
// 1. 일별 식단 뷰 (Daily View) 렌더링
// ============================================================================
async function loadDailyData(dateStr) {
  state.selectedDate = dateStr;
  document.getElementById('dailyDateInput').value = dateStr;

  const dObj = new Date(dateStr + 'T00:00:00');
  const todayStr = getLocalTodayStr();
  const weekday = WEEKDAYS_KO[dObj.getDay()];
  document.getElementById('dailyWeekdayText').textContent =
    dateStr === todayStr ? `오늘 (${weekday})` : `${weekday}요일`;

  const res = await fetch(`/api/day?date=${encodeURIComponent(dateStr)}`);
  const data = await res.json();
  state.dayData = data;
  renderDailyView();
}

function renderDailyView() {
  const data = state.dayData;
  if (!data) return;

  const s = state.settings;
  const t = data.totals;

  // 목표 및 섭취 칼로리 표시
  const totalCal = Math.round(t.calories || 0);
  const targetCal = Math.max(500, Number(s.target_calories) || 2000);
  const pct = Math.min(999, Math.round((totalCal / targetCal) * 100));

  document.getElementById('dailyTotalCal').textContent = totalCal.toLocaleString();
  document.getElementById('dailyTargetCal').textContent = targetCal.toLocaleString();
  document.getElementById('calPercentText').textContent = `${pct}%`;

  // 원형 링 업데이트 (반지름 50 -> 둘레 314.16)
  const circumference = 314.16;
  const clampedRatio = Math.min(1, totalCal / targetCal);
  const offset = circumference - clampedRatio * circumference;
  const ringEl = document.getElementById('calRingCircle');
  ringEl.style.strokeDashoffset = String(offset);
  ringEl.style.stroke = totalCal > targetCal * 1.1 ? '#ef4444' : '#10b981';

  const remainBadge = document.getElementById('calRemainBadge');
  const diff = targetCal - totalCal;
  if (diff >= 0) {
    remainBadge.textContent = `목표까지 ${diff.toLocaleString()} kcal 여유`;
    remainBadge.classList.remove('over');
  } else {
    remainBadge.textContent = `목표보다 ${Math.abs(diff).toLocaleString()} kcal 초과`;
    remainBadge.classList.add('over');
  }

  // 끼니별 미니 배지
  document.getElementById('miniBreakfastCal').textContent = Math.round(t.byMealType.breakfast?.calories || 0);
  document.getElementById('miniLunchCal').textContent = Math.round(t.byMealType.lunch?.calories || 0);
  document.getElementById('miniDinnerCal').textContent = Math.round(t.byMealType.dinner?.calories || 0);
  document.getElementById('miniSnackCal').textContent = Math.round(t.byMealType.snack?.calories || 0);

  // 탄단지 & 당류 프로그레스바
  updateMacroBar('dailyCarbsVal', 'targetCarbsVal', 'carbsBar', t.carbs, s.target_carbs);
  updateMacroBar('dailyProteinVal', 'targetProteinVal', 'proteinBar', t.protein, s.target_protein);
  updateMacroBar('dailyFatVal', 'targetFatVal', 'fatBar', t.fat, s.target_fat);
  updateMacroBar('dailySugarVal', 'targetSugarVal', 'sugarBar', t.sugar, s.target_sugar);

  // 음수량 & 체중 & 메모
  const waterMl = Number(data.dailyLog?.water_ml) || 0;
  const targetWater = Number(s.target_water) || 2000;
  const cups = Math.round((waterMl / 250) * 10) / 10;
  document.getElementById('waterSubText').textContent =
    `${waterMl.toLocaleString()}ml / 목표 ${targetWater.toLocaleString()}ml (${cups}컵)`;
  document.getElementById('waterBar').style.width = `${Math.min(100, Math.round((waterMl / targetWater) * 100))}%`;

  const weightInput = document.getElementById('dailyWeightInput');
  weightInput.value = data.dailyLog?.weight ?? '';
  const weightCompareEl = document.getElementById('weightCompareText');
  if (data.dailyLog?.weight) {
    const wDiff = (Number(data.dailyLog.weight) - Number(s.target_weight)).toFixed(1);
    const sign = wDiff > 0 ? `+${wDiff}kg` : `${wDiff}kg`;
    weightCompareEl.textContent = `목표 체중(${s.target_weight}kg) 대비 ${sign}`;
  } else if (data.latestWeight) {
    weightCompareEl.textContent = `최근 기록(${data.latestWeight.date}): ${data.latestWeight.weight}kg · 목표: ${s.target_weight}kg`;
  } else {
    weightCompareEl.textContent = `목표 체중: ${s.target_weight}kg`;
  }

  document.getElementById('dailyMemoInput').value = data.dailyLog?.memo || '';

  // 아침 / 점심 / 저녁 / 간식 4대 끼니 카드 렌더링
  const container = document.getElementById('mealSlotsContainer');
  container.innerHTML = '';

  for (const slot of MEAL_TYPES) {
    const slotMeals = (data.meals || []).filter(m => m.meal_type === slot.key);
    const slotStats = t.byMealType[slot.key] || { calories: 0, carbs: 0, protein: 0, fat: 0 };

    const card = document.createElement('div');
    card.className = 'meal-slot-card';

    const itemsHtml = slotMeals.length === 0
      ? `<div class="empty-meal-placeholder" data-add-slot="${slot.key}">
           + ${slot.label}에 먹은 음식 적기 · 사진 · 식단표 캡처 추가하기
         </div>`
      : slotMeals.map(item => `
          <div class="meal-item-row">
            <div class="meal-item-left">
              ${item.image_data ? `<img src="${item.image_data}" class="meal-thumb" alt="음식 사진" />` : ''}
              <div class="meal-item-info">
                <div class="meal-item-title">
                  <span>${escapeHtml(item.food_name)}</span>
                  <span class="meal-item-amount">${escapeHtml(item.amount || '1인분')}</span>
                </div>
                <div class="meal-item-macros">
                  탄 ${item.carbs}g · 단 ${item.protein}g · 지 ${item.fat}g${item.sugar ? ` · 당 ${item.sugar}g` : ''}
                </div>
                ${item.ai_note ? `<div class="meal-item-note">💡 ${escapeHtml(item.ai_note)}</div>` : ''}
              </div>
            </div>
            <div class="meal-item-right">
              <span class="meal-item-kcal">${Math.round(item.calories)} kcal</span>
              <button class="mini-action-btn" data-edit-id="${item.id}" title="수정">✏️</button>
              <button class="mini-action-btn" data-del-id="${item.id}" title="삭제">🗑️</button>
            </div>
          </div>
        `).join('');

    card.innerHTML = `
      <div class="meal-slot-header">
        <div class="meal-slot-title-group">
          <span class="meal-emoji">${slot.emoji}</span>
          <div>
            <div class="meal-slot-name">${slot.label}</div>
            <div class="meal-slot-sub">탄 ${Math.round(slotStats.carbs)}g · 단 ${Math.round(slotStats.protein)}g · 지 ${Math.round(slotStats.fat)}g</div>
          </div>
        </div>
        <div class="meal-slot-actions">
          <span class="meal-slot-cal-badge">${Math.round(slotStats.calories).toLocaleString()} kcal</span>
          <button class="btn-accent small" data-cam-slot="${slot.key}" title="${slot.label} 바로 카메라 촬영">📷 촬영</button>
          <button class="btn-primary small" data-add-slot="${slot.key}">+ 추가</button>
        </div>
      </div>
      <div class="meal-items-body">
        ${itemsHtml}
      </div>
    `;
    container.appendChild(card);
  }

  // 끼니별 추가/카메라촬영/수정/삭제 이벤트 연결
  container.querySelectorAll('[data-add-slot]').forEach(el => {
    el.addEventListener('click', () => {
      openMealModal({ mealType: el.dataset.addSlot, mode: 'text' });
    });
  });

  container.querySelectorAll('[data-cam-slot]').forEach(el => {
    el.addEventListener('click', async () => {
      await openMealModal({ mealType: el.dataset.camSlot, mode: 'photo', autoStartCamera: true });
    });
  });

  container.querySelectorAll('[data-del-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delId;
      await fetch(`/api/meals/${id}`, { method: 'DELETE' });
      showToast('식단 항목이 삭제되었습니다.');
      await loadDailyData(state.selectedDate);
    });
  });

  container.querySelectorAll('[data-edit-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.editId);
      const item = (state.dayData.meals || []).find(m => m.id === id);
      if (item) openEditSingleMealPrompt(item);
    });
  });
}

function updateMacroBar(valId, targetId, barId, val, target) {
  const v = Math.round((Number(val) || 0) * 10) / 10;
  const t = Math.max(1, Number(target) || 100);
  document.getElementById(valId).textContent = v;
  document.getElementById(targetId).textContent = t;
  const pct = Math.min(100, Math.round((v / t) * 100));
  document.getElementById(barId).style.width = `${pct}%`;
}

async function openEditSingleMealPrompt(item) {
  const newName = prompt('음식 이름을 수정하세요:', item.food_name);
  if (newName === null) return;
  const newAmount = prompt('섭취 분량(예: 1인분, 반공기):', item.amount || '1인분');
  if (newAmount === null) return;
  const newCal = prompt('칼로리(kcal)를 입력하세요:', String(Math.round(item.calories)));
  if (newCal === null) return;

  const calRatio = (Number(newCal) || 0) / Math.max(1, Number(item.calories) || 1);
  await fetch(`/api/meals/${item.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      food_name: newName,
      amount: newAmount,
      calories: Number(newCal) || 0,
      carbs: Math.round((item.carbs * calRatio) * 10) / 10,
      protein: Math.round((item.protein * calRatio) * 10) / 10,
      fat: Math.round((item.fat * calRatio) * 10) / 10
    })
  });
  showToast('식단 정보가 수정되었습니다.');
  await loadDailyData(state.selectedDate);
}

// ============================================================================
// 2. 월별 캘린더 뷰 (Monthly View) 렌더링
// ============================================================================
async function loadMonthlyData(year, month) {
  state.selectedYear = year;
  state.selectedMonth = month;
  document.getElementById('monthlyTitleText').textContent = `${year}년 ${month}월`;

  const res = await fetch(`/api/month?year=${year}&month=${month}`);
  const data = await res.json();
  state.monthData = data;
  renderMonthlyView();
}

function renderMonthlyView() {
  const data = state.monthData;
  if (!data) return;

  const s = state.settings;
  const targetCal = Number(s.target_calories) || 2000;
  const sum = data.summary;

  document.getElementById('monthLoggedDays').textContent = `${sum.loggedDays}일`;
  document.getElementById('monthAvgCal').textContent = `${sum.avgCalories.toLocaleString()} kcal`;
  document.getElementById('monthTargetCompareSub').textContent = `목표 ${targetCal.toLocaleString()} kcal 기준`;
  document.getElementById('monthGoalMetDays').textContent = `${sum.goalMetDays}일`;

  const wDiffEl = document.getElementById('monthWeightDiff');
  const wSubEl = document.getElementById('monthWeightRangeSub');
  if (sum.startWeight && sum.endWeight) {
    const diff = (sum.endWeight - sum.startWeight).toFixed(1);
    wDiffEl.textContent = `${diff > 0 ? '+' + diff : diff} kg`;
    wSubEl.textContent = `${sum.startWeight}kg → ${sum.endWeight}kg`;
  } else {
    wDiffEl.textContent = '-';
    wSubEl.textContent = '일별 화면에서 체중을 기록해보세요';
  }

  // 달력 그리드 생성
  const grid = document.getElementById('monthlyCalendarGrid');
  grid.innerHTML = '';

  const firstDay = new Date(data.year, data.month - 1, 1).getDay();
  const lastDate = new Date(data.year, data.month, 0).getDate();
  const todayStr = getLocalTodayStr();

  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day-cell empty';
    grid.appendChild(empty);
  }

  for (let day = 1; day <= lastDate; day++) {
    const dateStr = `${data.year}-${String(data.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dInfo = data.days[dateStr];
    const cell = document.createElement('div');
    cell.className = 'cal-day-cell' + (dateStr === todayStr ? ' today' : '');

    let calPillHtml = '';
    let mealTagsHtml = '';
    let metaHtml = '';

    if (dInfo && dInfo.calories > 0) {
      let statusClass = 'good';
      if (dInfo.calories < targetCal * 0.8) statusClass = 'low';
      else if (dInfo.calories > targetCal * 1.1) statusClass = 'over';

      calPillHtml = `<div class="cal-day-kcal-pill ${statusClass}">${Math.round(dInfo.calories).toLocaleString()} kcal</div>`;

      const tags = [];
      if (dInfo.meals.breakfast > 0) tags.push('아');
      if (dInfo.meals.lunch > 0) tags.push('점');
      if (dInfo.meals.dinner > 0) tags.push('저');
      if (dInfo.meals.snack > 0) tags.push('간');
      mealTagsHtml = `<div class="cal-day-dots">${tags.map(t => `<span class="meal-mini-tag">${t}</span>`).join('')}</div>`;
    }

    if (dInfo && (dInfo.weight || dInfo.water_ml > 0)) {
      const wTxt = dInfo.weight ? `${dInfo.weight}kg` : '';
      const waterTxt = dInfo.water_ml > 0 ? `💧${(dInfo.water_ml / 1000).toFixed(1)}L` : '';
      metaHtml = `<div class="cal-day-meta"><span>${wTxt}</span><span>${waterTxt}</span></div>`;
    }

    cell.innerHTML = `
      <div class="cal-day-top">
        <span>${day}</span>
        ${dateStr === todayStr ? '<span style="font-size:0.65rem;color:#059669;">오늘</span>' : ''}
      </div>
      <div>
        ${calPillHtml}
        ${mealTagsHtml}
        ${metaHtml}
      </div>
    `;

    cell.addEventListener('click', () => {
      state.selectedDate = dateStr;
      switchView('daily');
    });

    grid.appendChild(cell);
  }
}

// ============================================================================
// 3. 년도별 통계 뷰 (Yearly View) 렌더링
// ============================================================================
async function loadYearlyData(year) {
  state.selectedYear = year;
  document.getElementById('yearlyTitleText').textContent = `${year}년 연간 식단 리포트`;

  const res = await fetch(`/api/year?year=${year}`);
  const data = await res.json();
  state.yearData = data;
  renderYearlyView();
}

function renderYearlyView() {
  const data = state.yearData;
  if (!data) return;

  document.getElementById('yearLoggedDays').textContent = `${data.yearSummary.totalLoggedDays}일`;
  document.getElementById('yearAvgCalories').textContent = `${data.yearSummary.yearAvgCalories.toLocaleString()} kcal`;
  document.getElementById('yearTotalCalories').textContent = `${data.yearSummary.yearTotalCalories.toLocaleString()} kcal`;

  const maxCal = Math.max(2500, ...data.months.map(m => m.avgCalories || 0));

  // 막대 차트
  const chartEl = document.getElementById('yearlyBarsChart');
  chartEl.innerHTML = data.months.map(m => {
    const heightPct = m.avgCalories > 0 ? Math.max(8, Math.round((m.avgCalories / maxCal) * 100)) : 3;
    return `
      <div class="year-bar-col" data-goto-month="${m.month}" title="${m.month}월 일평균 ${m.avgCalories} kcal">
        <span class="year-bar-val">${m.avgCalories > 0 ? m.avgCalories : ''}</span>
        <div class="year-bar-Stick" style="height:${heightPct}%"></div>
        <span class="year-bar-label">${m.month}월</span>
      </div>
    `;
  }).join('');

  // 12개월 카드
  const monthsGrid = document.getElementById('yearlyMonthsGrid');
  monthsGrid.innerHTML = data.months.map(m => `
    <div class="month-stat-card" data-goto-month="${m.month}">
      <div class="month-stat-head">
        <h4>${data.year}년 ${m.month}월</h4>
        <span class="cal-remain-badge">${m.loggedDays}일 기록</span>
      </div>
      <div class="month-stat-rows">
        <div class="month-stat-row">
          <span>일평균 칼로리</span>
          <strong>${m.avgCalories.toLocaleString()} kcal</strong>
        </div>
        <div class="month-stat-row">
          <span>평균 탄·단·지</span>
          <span>탄 ${m.avgCarbs}g · 단 ${m.avgProtein}g · 지 ${m.avgFat}g</span>
        </div>
        <div class="month-stat-row">
          <span>목표 달성일</span>
          <strong>${m.goalMetDays}일</strong>
        </div>
        <div class="month-stat-row">
          <span>평균 체중 / 수분</span>
          <span>${m.avgWeight ? m.avgWeight + 'kg' : '-'} / ${m.avgWater ? m.avgWater + 'ml' : '-'}</span>
        </div>
      </div>
    </div>
  `).join('');

  document.querySelectorAll('[data-goto-month]').forEach(el => {
    el.addEventListener('click', () => {
      state.selectedMonth = Number(el.dataset.gotoMonth);
      switchView('monthly');
    });
  });
}

// ============================================================================
// AI 식단 등록 모달 (텍스트 / 음식 사진 / 식단표 캡처 / 실시간 카메라)
// ============================================================================
let liveCameraStream = null;
let currentCameraFacing = 'environment'; // 'environment'(후면) | 'user'(전면)

async function openMealModal({ mealType = 'lunch', mode = 'text', autoStartCamera = false } = {}) {
  document.getElementById('modalDateInput').value = state.selectedDate;
  document.getElementById('modalMealTypeSelect').value = mealType;
  document.getElementById('aiPromptInput').value = '';
  document.getElementById('aiResultSummaryBox').classList.add('hidden');
  document.getElementById('multiSlotBox').classList.add('hidden');

  stopLiveCamera();
  clearUploadedImage();
  state.stagedItems = [];
  state.detectedSlots = [];
  renderStagedItems();

  setModalMode(mode);
  document.getElementById('mealModalBackdrop').classList.remove('hidden');
  await loadFoodSuggestions('');

  if (autoStartCamera) {
    startLiveCamera();
  }
}

function closeMealModal() {
  stopLiveCamera();
  document.getElementById('mealModalBackdrop').classList.add('hidden');
}

function setModalMode(mode) {
  state.modalMode = mode;
  document.querySelectorAll('.mode-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const imgZone = document.getElementById('imageUploadZone');
  const promptLabel = document.getElementById('aiPromptLabel');
  const promptInput = document.getElementById('aiPromptInput');

  if (mode === 'text') {
    stopLiveCamera();
    imgZone.classList.add('hidden');
    promptLabel.textContent = '먹은 음식 입력 (쉼표나 줄바꿈으로 구분해 적어보세요)';
    promptInput.placeholder = '예: 잡곡밥 1공기, 된장찌개 1인분, 고등어구이 1토막, 아이스 아메리카노 1잔';
  } else if (mode === 'photo') {
    imgZone.classList.remove('hidden');
    promptLabel.textContent = '음식 사진 보충 메모 (선택사항)';
    promptInput.placeholder = '예: 밥은 반공기만 먹었어요 / 2인분 중 절반 섭취 등 (비워두어도 사진을 AI가 자동 분석합니다)';
  } else if (mode === 'menu_table') {
    imgZone.classList.remove('hidden');
    promptLabel.textContent = '식단표 캡처 보충 메모 (선택사항)';
    promptInput.placeholder = '예: 수요일 중식 메뉴만 계산해줘 / 혹은 비워두시면 식단표 전체 끼니를 자동 추출합니다!';
  }
}

async function startLiveCamera() {
  stopLiveCamera();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // 브라우저가 인앱 웹캠 스트림을 지원하지 않으면 휴대폰 기본 카메라 앱 즉시 호출
    document.getElementById('cameraFileInput').click();
    return;
  }

  try {
    liveCameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: currentCameraFacing },
        width: { ideal: 1280 },
        height: { ideal: 960 }
      },
      audio: false
    });
    const videoEl = document.getElementById('liveCameraVideo');
    videoEl.srcObject = liveCameraStream;
    document.getElementById('liveCameraBox').classList.remove('hidden');
    document.getElementById('imagePreviewWrap').classList.add('hidden');
  } catch (err) {
    // 권한 거부 또는 지원 안 될 경우 휴대폰 기본 카메라로 폴백
    showToast('기본 카메라 앱을 실행합니다.');
    document.getElementById('cameraFileInput').click();
  }
}

function stopLiveCamera() {
  if (liveCameraStream) {
    liveCameraStream.getTracks().forEach(track => track.stop());
    liveCameraStream = null;
  }
  const videoEl = document.getElementById('liveCameraVideo');
  if (videoEl) videoEl.srcObject = null;
  const box = document.getElementById('liveCameraBox');
  if (box) box.classList.add('hidden');
}

async function switchCameraFacing() {
  currentCameraFacing = currentCameraFacing === 'environment' ? 'user' : 'environment';
  await startLiveCamera();
}

function captureLivePhoto() {
  const videoEl = document.getElementById('liveCameraVideo');
  if (!videoEl || !videoEl.videoWidth) {
    showToast('카메라 화면이 아직 준비되지 않았습니다.');
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

  const img = new Image();
  img.onload = () => {
    state.uploadedImageBase64 = resizeImageToDataUrl(img, 1280, 0.82);
    state.uploadedThumbBase64 = resizeImageToDataUrl(img, 140, 0.7);
    state.uploadedMimeType = 'image/jpeg';

    stopLiveCamera();

    const previewEl = document.getElementById('imagePreviewEl');
    previewEl.src = state.uploadedImageBase64;
    document.getElementById('imagePreviewWrap').classList.remove('hidden');

    if (state.settings.has_gemini_key) {
      showToast('📸 촬영 완료! AI가 자동으로 칼로리를 분석합니다...');
      runAiAnalyze();
    } else {
      showToast('📸 사진이 촬영되었습니다! [AI 칼로리 계산]을 누르거나 음식 이름을 적어주세요.');
    }
  };
  img.src = canvas.toDataURL('image/jpeg', 0.9);
}

function clearUploadedImage() {
  state.uploadedImageBase64 = '';
  state.uploadedThumbBase64 = '';
  document.getElementById('imagePreviewWrap').classList.add('hidden');
  document.getElementById('imagePreviewEl').src = '';
  document.getElementById('cameraFileInput').value = '';
  document.getElementById('galleryFileInput').value = '';
}

// 이미지 압축 (AI 분석용 1280px & DB 썸네일용 160px)
function processImageFile(file, autoAnalyzeIfKey = true) {
  if (!file || !file.type.startsWith('image/')) return;
  stopLiveCamera();
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      state.uploadedImageBase64 = resizeImageToDataUrl(img, 1280, 0.82);
      state.uploadedThumbBase64 = resizeImageToDataUrl(img, 140, 0.7);
      state.uploadedMimeType = 'image/jpeg';

      const previewEl = document.getElementById('imagePreviewEl');
      previewEl.src = state.uploadedImageBase64;
      document.getElementById('imagePreviewWrap').classList.remove('hidden');

      if (state.modalMode === 'text') {
        setModalMode('photo');
      }
      if (autoAnalyzeIfKey && state.settings.has_gemini_key) {
        showToast('사진 업로드 완료! AI가 자동으로 칼로리를 계산합니다...');
        runAiAnalyze();
      } else {
        showToast('이미지가 준비되었습니다. [AI 칼로리 계산]을 눌러보세요!');
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function resizeImageToDataUrl(img, maxDim, quality) {
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    if (width > height) {
      height = Math.round((height * maxDim) / width);
      width = maxDim;
    } else {
      width = Math.round((width * maxDim) / height);
      height = maxDim;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

async function runAiAnalyze() {
  const text = document.getElementById('aiPromptInput').value.trim();
  const targetDate = document.getElementById('modalDateInput').value || state.selectedDate;
  const targetMealType = document.getElementById('modalMealTypeSelect').value || 'lunch';

  if (!text && !state.uploadedImageBase64) {
    showToast('먹은 음식을 적거나 음식/식단표 사진을 먼저 올려주세요!');
    return;
  }

  const btn = document.getElementById('runAiAnalyzeBtn');
  const btnText = document.getElementById('aiAnalyzeBtnText');
  btn.disabled = true;
  btnText.textContent = 'AI 분석 중...';

  try {
    const res = await fetch('/api/ai/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: state.modalMode,
        text,
        imageBase64: state.uploadedImageBase64,
        mimeType: state.uploadedMimeType,
        targetDate,
        targetMealType
      })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'AI 분석 중 오류가 발생했습니다.');
      if (data.requiresApiKey) {
        openSettingsModal();
      }
      return;
    }

    // 요약 표시
    const sumBox = document.getElementById('aiResultSummaryBox');
    document.getElementById('aiEngineBadge').textContent = data.engine || 'AI 영양 분석';
    document.getElementById('aiSummaryText').textContent = data.summary || '';
    sumBox.classList.remove('hidden');

    // 다중 슬롯(식단표 캡처에서 여러 날짜/끼니 추출된 경우)
    const multiBox = document.getElementById('multiSlotBox');
    if (data.is_multi_slot && Array.isArray(data.slots) && data.slots.length > 1) {
      state.detectedSlots = data.slots;
      renderMultiSlotCheckboxes(data.slots);
      multiBox.classList.remove('hidden');
    } else {
      multiBox.classList.add('hidden');
    }

    // 추출된 음식 항목을 등록 대기 목록에 추가
    const newItems = (data.items || []).map(it => ({
      food_name: it.food_name || '음식',
      amount: it.amount || '1인분',
      calories: Math.round(Number(it.calories) || 0),
      carbs: Math.round((Number(it.carbs) || 0) * 10) / 10,
      protein: Math.round((Number(it.protein) || 0) * 10) / 10,
      fat: Math.round((Number(it.fat) || 0) * 10) / 10,
      sugar: Math.round((Number(it.sugar) || 0) * 10) / 10,
      ai_note: it.ai_note || ''
    }));

    state.stagedItems = [...state.stagedItems, ...newItems];
    renderStagedItems();
    showToast(`${newItems.length}개 음식 칼로리 계산이 완료되었습니다!`);
  } catch (err) {
    showToast('네트워크 오류: ' + err.message);
  } finally {
    btn.disabled = false;
    btnText.textContent = 'AI 칼로리 계산';
  }
}

function renderMultiSlotCheckboxes(slots) {
  const listEl = document.getElementById('multiSlotList');
  listEl.innerHTML = slots.map((slot, idx) => {
    const names = (slot.items || []).map(i => i.food_name).join(', ');
    const cal = (slot.items || []).reduce((a, b) => a + (Number(b.calories) || 0), 0);
    return `
      <label class="multi-slot-item">
        <input type="checkbox" class="slot-check" data-slot-idx="${idx}" checked />
        <div>
          <strong>[${escapeHtml(slot.date || state.selectedDate)} · ${escapeHtml(slot.label || slot.meal_type)}]</strong>
          <span>${escapeHtml(names)} (총 ${Math.round(cal)} kcal)</span>
        </div>
      </label>
    `;
  }).join('');
}

async function saveSelectedMultiSlots() {
  const checks = document.querySelectorAll('.slot-check:checked');
  if (checks.length === 0) {
    showToast('등록할 끼니를 하나 이상 선택해주세요.');
    return;
  }

  const batchItems = [];
  checks.forEach(ch => {
    const slot = state.detectedSlots[Number(ch.dataset.slotIdx)];
    if (!slot || !Array.isArray(slot.items)) return;
    for (const item of slot.items) {
      batchItems.push({
        date: slot.date || document.getElementById('modalDateInput').value,
        meal_type: slot.meal_type || document.getElementById('modalMealTypeSelect').value,
        food_name: item.food_name,
        amount: item.amount || '1인분',
        calories: Number(item.calories) || 0,
        carbs: Number(item.carbs) || 0,
        protein: Number(item.protein) || 0,
        fat: Number(item.fat) || 0,
        sugar: Number(item.sugar) || 0,
        source_type: 'menu_table',
        image_data: state.uploadedThumbBase64 || null,
        ai_note: item.ai_note || slot.label || '식단표 자동 인식'
      });
    }
  });

  await fetch('/api/meals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: batchItems })
  });

  closeMealModal();
  showToast(`식단표에서 선택한 ${checks.length}개 끼니(${batchItems.length}개 메뉴)가 일괄 저장되었습니다!`);
  await refreshCurrentView();
}

function renderStagedItems() {
  const listEl = document.getElementById('stagedItemsList');
  const countEl = document.getElementById('stagedCountText');
  const totalCalEl = document.getElementById('stagedTotalCalText');

  countEl.textContent = String(state.stagedItems.length);
  const sumCal = state.stagedItems.reduce((acc, it) => acc + (Number(it.calories) || 0), 0);
  totalCalEl.textContent = Math.round(sumCal).toLocaleString();

  if (state.stagedItems.length === 0) {
    listEl.innerHTML = `<div style="text-align:center;padding:14px;color:#94a3b8;font-size:0.82rem;">
      위에서 음식을 적고 <b>[✨ AI 칼로리 계산]</b>을 누르거나 빠른 음식 칩을 클릭해보세요.
    </div>`;
    return;
  }

  listEl.innerHTML = state.stagedItems.map((it, idx) => `
    <div class="staged-row" data-idx="${idx}">
      <div class="staged-field">
        <span>음식명</span>
        <input type="text" data-field="food_name" value="${escapeHtml(it.food_name)}" />
      </div>
      <div class="staged-field">
        <span>섭취량</span>
        <input type="text" data-field="amount" value="${escapeHtml(it.amount)}" />
      </div>
      <div class="staged-field">
        <span>칼로리(kcal)</span>
        <input type="number" data-field="calories" value="${Math.round(it.calories)}" />
      </div>
      <div class="staged-field">
        <span>탄수(g)</span>
        <input type="number" step="0.1" data-field="carbs" value="${it.carbs}" />
      </div>
      <div class="staged-field">
        <span>단백(g)</span>
        <input type="number" step="0.1" data-field="protein" value="${it.protein}" />
      </div>
      <div class="staged-field">
        <span>지방(g)</span>
        <input type="number" step="0.1" data-field="fat" value="${it.fat}" />
      </div>
      <button type="button" class="mini-action-btn" data-remove-idx="${idx}" title="제거">✕</button>
    </div>
  `).join('');

  listEl.querySelectorAll('.staged-row').forEach(row => {
    const idx = Number(row.dataset.idx);
    row.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', () => {
        const f = inp.dataset.field;
        state.stagedItems[idx][f] = f === 'food_name' || f === 'amount' ? inp.value : Number(inp.value) || 0;
        const newSum = state.stagedItems.reduce((a, b) => a + (Number(b.calories) || 0), 0);
        totalCalEl.textContent = Math.round(newSum).toLocaleString();
      });
    });
  });

  listEl.querySelectorAll('[data-remove-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.stagedItems.splice(Number(btn.dataset.removeIdx), 1);
      renderStagedItems();
    });
  });
}

async function loadFoodSuggestions(query) {
  try {
    const res = await fetch(`/api/foods/suggest?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    const container = document.getElementById('quickFoodChipsContainer');
    container.innerHTML = (data.suggestions || []).map((s, i) => `
      <button type="button" class="food-chip" data-sug-idx="${i}">
        <span>${s.source === 'recent' ? '🕒' : '🥗'} ${escapeHtml(s.food_name)}</span>
        <small>${Math.round(s.calories)}kcal</small>
      </button>
    `).join('');

    container.querySelectorAll('.food-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const item = data.suggestions[Number(chip.dataset.sugIdx)];
        state.stagedItems.push({
          food_name: item.food_name,
          amount: item.amount || '1인분',
          calories: item.calories,
          carbs: item.carbs,
          protein: item.protein,
          fat: item.fat,
          sugar: item.sugar || 0,
          ai_note: item.source === 'recent' ? '내가 자주 먹은 메뉴' : '한국음식 영양DB'
        });
        renderStagedItems();
      });
    });
  } catch (_) {}
}

async function saveStagedMeals() {
  // 만약 stagedItems가 비어있는데 텍스트 입력창에 글자가 있다면 자동으로 먼저 계산 후 저장!
  const promptText = document.getElementById('aiPromptInput').value.trim();
  if (state.stagedItems.length === 0 && (promptText || state.uploadedImageBase64)) {
    await runAiAnalyze();
    if (state.stagedItems.length === 0) return;
  }

  if (state.stagedItems.length === 0) {
    showToast('등록할 음식이 없습니다. 음식을 입력하거나 추가해주세요.');
    return;
  }

  const date = document.getElementById('modalDateInput').value || state.selectedDate;
  const meal_type = document.getElementById('modalMealTypeSelect').value || 'lunch';

  await fetch('/api/meals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date,
      meal_type,
      source_type: state.modalMode,
      image_data: state.uploadedThumbBase64 || null,
      items: state.stagedItems
    })
  });

  closeMealModal();
  state.selectedDate = date;
  showToast('식단이 저장되어 모든 기기에 동기화되었습니다!');
  await refreshCurrentView();
}

// ============================================================================
// 설정 모달 및 백업/복원
// ============================================================================
async function openSettingsModal() {
  await loadSettings();
  const s = state.settings;

  const badge = document.getElementById('geminiKeyStatusBadge');
  if (s.has_gemini_key) {
    badge.textContent = `연결됨 (${s.gemini_key_preview})`;
    badge.classList.add('ok');
  } else {
    badge.textContent = '미설정 (내장 DB 모드)';
    badge.classList.remove('ok');
  }

  document.getElementById('settingGeminiKey').value = '';
  document.getElementById('settingGeminiModel').value = s.gemini_model || 'gemini-2.5-flash';
  document.getElementById('settingTargetCal').value = s.target_calories;
  document.getElementById('settingTargetWeight').value = s.target_weight;
  document.getElementById('settingTargetCarbs').value = s.target_carbs;
  document.getElementById('settingTargetProtein').value = s.target_protein;
  document.getElementById('settingTargetFat').value = s.target_fat;
  document.getElementById('settingTargetWater').value = s.target_water;

  document.getElementById('settingsModalBackdrop').classList.remove('hidden');
}

async function saveSettings() {
  const payload = {
    gemini_api_key: document.getElementById('settingGeminiKey').value.trim(),
    gemini_model: document.getElementById('settingGeminiModel').value,
    target_calories: Number(document.getElementById('settingTargetCal').value) || 2000,
    target_weight: Number(document.getElementById('settingTargetWeight').value) || 65,
    target_carbs: Number(document.getElementById('settingTargetCarbs').value) || 250,
    target_protein: Number(document.getElementById('settingTargetProtein').value) || 100,
    target_fat: Number(document.getElementById('settingTargetFat').value) || 65,
    target_water: Number(document.getElementById('settingTargetWater').value) || 2000
  };

  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  document.getElementById('settingsModalBackdrop').classList.add('hidden');
  await loadSettings();
  await refreshCurrentView();
  showToast('설정이 저장되었습니다!');
}

// ============================================================================
// 이벤트 바인딩
// ============================================================================
function bindEvents() {
  // 상단/모바일 탭 전환
  document.querySelectorAll('.tab-btn, .mob-nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.getElementById('brandHomeBtn').addEventListener('click', () => {
    state.selectedDate = getLocalTodayStr();
    switchView('daily');
  });

  // 일별 날짜 이동
  document.getElementById('prevDayBtn').addEventListener('click', () => shiftSelectedDate(-1));
  document.getElementById('nextDayBtn').addEventListener('click', () => shiftSelectedDate(1));
  document.getElementById('goTodayBtn').addEventListener('click', () => {
    loadDailyData(getLocalTodayStr());
  });
  document.getElementById('dailyDateInput').addEventListener('change', (e) => {
    if (e.target.value) loadDailyData(e.target.value);
  });

  // 월별 이동
  document.getElementById('prevMonthBtn').addEventListener('click', () => shiftMonth(-1));
  document.getElementById('nextMonthBtn').addEventListener('click', () => shiftMonth(1));
  document.getElementById('goThisMonthBtn').addEventListener('click', () => {
    const now = new Date();
    loadMonthlyData(now.getFullYear(), now.getMonth() + 1);
  });

  // 년도별 이동
  document.getElementById('prevYearBtn').addEventListener('click', () => {
    loadYearlyData(state.selectedYear - 1);
  });
  document.getElementById('nextYearBtn').addEventListener('click', () => {
    loadYearlyData(state.selectedYear + 1);
  });
  document.getElementById('goThisYearBtn').addEventListener('click', () => {
    loadYearlyData(new Date().getFullYear());
  });

  // 음수량 & 체중 & 메모 저장
  document.getElementById('waterPlus250Btn').addEventListener('click', () => updateDailyLog({ water_delta: 250 }));
  document.getElementById('waterPlus500Btn').addEventListener('click', () => updateDailyLog({ water_delta: 500 }));
  document.getElementById('waterMinusBtn').addEventListener('click', () => updateDailyLog({ water_delta: -250 }));

  document.getElementById('saveWeightBtn').addEventListener('click', () => {
    const w = document.getElementById('dailyWeightInput').value;
    updateDailyLog({ weight: w });
    showToast('오늘 체중이 기록되었습니다.');
  });

  document.getElementById('saveMemoBtn').addEventListener('click', () => {
    const memo = document.getElementById('dailyMemoInput').value;
    updateDailyLog({ memo });
    showToast('오늘 메모가 저장되었습니다.');
  });

  // AI 배너 버튼 & 모바일 중앙 + 버튼
  document.getElementById('openAiTextBtn').addEventListener('click', () => openMealModal({ mealType: guessCurrentMealType(), mode: 'text' }));
  document.getElementById('openAiLiveCamBtn').addEventListener('click', () => openMealModal({ mealType: guessCurrentMealType(), mode: 'photo', autoStartCamera: true }));
  document.getElementById('openAiPhotoBtn').addEventListener('click', () => openMealModal({ mealType: guessCurrentMealType(), mode: 'photo' }));
  document.getElementById('openAiMenuTableBtn').addEventListener('click', () => openMealModal({ mealType: guessCurrentMealType(), mode: 'menu_table' }));
  document.getElementById('mobileQuickAddBtn').addEventListener('click', () => openMealModal({ mealType: guessCurrentMealType(), mode: 'text' }));

  // 식단 모달 내부 이벤트
  document.getElementById('closeMealModalBtn').addEventListener('click', closeMealModal);
  document.getElementById('cancelMealModalBtn').addEventListener('click', closeMealModal);

  document.getElementById('startLiveCameraBtn').addEventListener('click', startLiveCamera);
  document.getElementById('switchCameraFacingBtn').addEventListener('click', switchCameraFacing);
  document.getElementById('captureLivePhotoBtn').addEventListener('click', captureLivePhoto);
  document.getElementById('closeLiveCameraBtn').addEventListener('click', stopLiveCamera);

  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => setModalMode(tab.dataset.mode));
  });

  document.getElementById('cameraFileInput').addEventListener('change', (e) => {
    if (e.target.files?.[0]) processImageFile(e.target.files[0]);
  });
  document.getElementById('galleryFileInput').addEventListener('change', (e) => {
    if (e.target.files?.[0]) processImageFile(e.target.files[0]);
  });
  document.getElementById('removeImageBtn').addEventListener('click', clearUploadedImage);

  // 클립보드 이미지 붙여넣기 (Ctrl + V) 지원
  window.addEventListener('paste', (e) => {
    const modalOpen = !document.getElementById('mealModalBackdrop').classList.contains('hidden');
    if (!modalOpen) return;
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) processImageFile(file);
        break;
      }
    }
  });

  document.getElementById('runAiAnalyzeBtn').addEventListener('click', runAiAnalyze);
  document.getElementById('saveMultiSlotsBtn').addEventListener('click', saveSelectedMultiSlots);

  document.getElementById('quickFoodSearchInput').addEventListener('input', (e) => {
    loadFoodSuggestions(e.target.value);
  });

  document.getElementById('addBlankRowBtn').addEventListener('click', () => {
    state.stagedItems.push({
      food_name: '',
      amount: '1인분',
      calories: 250,
      carbs: 30,
      protein: 12,
      fat: 8,
      sugar: 2
    });
    renderStagedItems();
  });

  document.getElementById('saveStagedMealsBtn').addEventListener('click', saveStagedMeals);

  // 설정 및 서버 연동 모달
  document.getElementById('openSettingsBtn').addEventListener('click', openSettingsModal);
  document.getElementById('mobileSettingsNavBtn').addEventListener('click', openSettingsModal);
  document.getElementById('closeSettingsModalBtn').addEventListener('click', () => {
    document.getElementById('settingsModalBackdrop').classList.add('hidden');
  });
  document.getElementById('cancelSettingsBtn').addEventListener('click', () => {
    document.getElementById('settingsModalBackdrop').classList.add('hidden');
  });
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);

  document.getElementById('openSyncGuideBtn').addEventListener('click', () => {
    loadServerInfo();
    document.getElementById('syncGuideModalBackdrop').classList.remove('hidden');
  });
  document.getElementById('closeSyncGuideModalBtn').addEventListener('click', () => {
    document.getElementById('syncGuideModalBackdrop').classList.add('hidden');
  });
  document.getElementById('okSyncGuideBtn').addEventListener('click', () => {
    document.getElementById('syncGuideModalBackdrop').classList.add('hidden');
  });

  // 백업 내보내기 / 가져오기
  document.getElementById('exportDataBtn').addEventListener('click', async () => {
    const res = await fetch('/api/backup/export');
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diet-backup-${getLocalTodayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('식단 백업 파일이 다운로드되었습니다.');
  });

  document.getElementById('importDataInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const res = await fetch('/api/backup/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json)
      });
      const result = await res.json();
      if (res.ok) {
        showToast(`복원 완료! (식단 ${result.importedMeals}건)`);
        await refreshCurrentView();
      } else {
        showToast(result.error || '복원 실패');
      }
    } catch (err) {
      showToast('올바른 JSON 백업 파일이 아닙니다.');
    }
  });
}

function guessCurrentMealType() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 10) return 'breakfast';
  if (hour >= 10 && hour < 15) return 'lunch';
  if (hour >= 17 && hour < 21) return 'dinner';
  return 'snack';
}

function shiftSelectedDate(daysDelta) {
  const d = new Date(state.selectedDate + 'T00:00:00');
  d.setDate(d.getDate() + daysDelta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  loadDailyData(`${y}-${m}-${day}`);
}

function shiftMonth(monthDelta) {
  let y = state.selectedYear;
  let m = state.selectedMonth + monthDelta;
  if (m < 1) {
    m = 12;
    y -= 1;
  } else if (m > 12) {
    m = 1;
    y += 1;
  }
  loadMonthlyData(y, m);
}

async function updateDailyLog(payload) {
  await fetch('/api/daily-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: state.selectedDate,
      ...payload
    })
  });
  await loadDailyData(state.selectedDate);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
