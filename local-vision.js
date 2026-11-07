// ============================================================================
// 내 PC 로컬 이미지·식단표·영양성분표 분석 엔진 (Google API 키 없이 PC에서 직접 처리)
// 1순위: 내 PC의 로컬 비전 AI (Ollama - RTX 4070 Ti GPU 가속)
// 2순위: 내 PC의 로컬 한국어 OCR (Tesseract.js kor+eng) + 영양성분표 전용 파서 & 내장 영양DB
// ============================================================================

const Tesseract = require('tesseract.js');
const { KOREAN_FOOD_DB, estimateFromTextFallback } = require('./food-db');

let ocrWorkerPromise = null;

async function getKoreanOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const worker = await Tesseract.createWorker(['kor', 'eng']);
      return worker;
    })().catch(err => {
      ocrWorkerPromise = null;
      throw err;
    });
  }
  return ocrWorkerPromise;
}

/**
 * 1. 내 PC에 로컬 Ollama AI 서버(http://localhost:11434)가 켜져 있는지 확인하고 비전 모델로 분석
 */
async function tryLocalOllamaVision({ mode, text, cleanBase64 }) {
  try {
    const tagsRes = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(1200)
    });
    if (!tagsRes.ok) return null;
    const tagsData = await tagsRes.json();
    const models = (tagsData.models || []).map(m => m.name);

    const visionModel = models.find(m =>
      /gemma3|llava|vl|vision|minicpm|moondream|bakllava/i.test(m)
    );
    if (!visionModel) return null;

    let prompt = '';
    if (mode === 'nutrition_label') {
      prompt = `이 식품 포장지의 '영양정보(영양성분표)' 이미지를 읽고 제품명(또는 사용자 메모 "${text || ''}"), 총 내용량(예: 1개(210g)), 열량(calories, kcal), 탄수화물(carbs, g), 단백질(protein, g), 지방(fat, g), 당류(sugar, g) 숫자를 정확히 추출해 다음 JSON 형식으로만 응답하세요. (2,000kcal 기준치 문구는 제외하고 실제 제품 열량을 추출하세요)
{"summary":"영양성분표 인식 완료","items":[{"food_name":"제품명","amount":"1개(100g)","calories":120,"carbs":2,"protein":24,"fat":1.5,"sugar":0,"ai_note":"영양성분표 스캔"}]}`;
    } else if (mode === 'menu_table') {
      prompt = `이 식단표 이미지를 읽고 메뉴 이름과 1인분 기준 칼로리(kcal), 탄수화물(g), 단백질(g), 지방(g), 당류(g)를 다음 JSON 형식으로만 출력하세요. 추가 메모: "${text || '없음'}"
{"summary":"한줄 요약","items":[{"food_name":"음식명","amount":"1인분","calories":300,"carbs":40,"protein":15,"fat":8,"sugar":3,"ai_note":"식단표 인식"}]}`;
    } else {
      prompt = `이 음식 사진에 보이는 모든 한국 음식/반찬/음료를 식별하고 1인분 기준 칼로리(kcal), 탄수화물(g), 단백질(g), 지방(g), 당류(g)를 다음 JSON 형식으로만 출력하세요. 추가 메모: "${text || '없음'}"
{"summary":"영양 한줄 코멘트","items":[{"food_name":"음식명","amount":"1인분","calories":350,"carbs":45,"protein":20,"fat":10,"sugar":4,"ai_note":"사진 분석"}]}`;
    }

    const chatRes = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: visionModel,
        stream: false,
        format: 'json',
        messages: [
          {
            role: 'user',
            content: prompt,
            images: cleanBase64 ? [cleanBase64] : undefined
          }
        ]
      })
    });

    if (!chatRes.ok) return null;
    const chatData = await chatRes.json();
    const raw = chatData?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.items) && parsed.items.length > 0) {
      return {
        engine: `내 PC 로컬 AI (${visionModel} · RTX GPU)`,
        mode,
        summary: parsed.summary || '내 PC 로컬 비전 AI가 사진을 분석했습니다.',
        is_multi_slot: Boolean(parsed.is_multi_slot && Array.isArray(parsed.slots)),
        slots: Array.isArray(parsed.slots) ? parsed.slots : [],
        items: parsed.items
      };
    }
  } catch (_) {}
  return null;
}

/**
 * 한국 가공식품 포장지 '영양정보 / 영양성분표' OCR 텍스트에서
 * 칼로리(kcal), 탄수화물(g), 단백질(g), 지방(g), 당류(g), 총 내용량(g/ml)을 정밀 추출합니다.
 */
function parseNutritionLabelOcr(ocrText, userMemo = '') {
  // 공백/줄바꿈 정리하되 키워드와 숫자 연결을 쉽게 만듦
  const norm = String(ocrText || '')
    .replace(/,/g, '') // 1,000 -> 1000 (소수점은 그대로 유지)
    .replace(/[|[\]{}]/g, ' ');

  // 하단 "1일 영양성분 기준치에 대한 비율(%)은 2000 kcal 기준이므로..." 문구 제거 (2000kcal 오인식 방지!)
  const cleanedForCal = norm
    .replace(/2000\s*(kcal|㎉|칼로리)\s*기준/gi, '')
    .replace(/기준치[가-힣\s()*%0-9]*2000\s*(kcal|㎉)/gi, '');

  // 1. 열량(kcal) 추출
  let calories = null;
  const calMatches = [
    ...cleanedForCal.matchAll(/(\d{1,4}(?:\.\d+)?)\s*(?:kcal|㎉|kca1|kcaI|칼로리)/gi),
    ...cleanedForCal.matchAll(/열\s*량\s*[:.]?\s*(\d{1,4}(?:\.\d+)?)/gi)
  ];
  for (const m of calMatches) {
    const val = parseFloat(m[1]);
    if (val > 0 && val !== 2000 && val <= 3500) {
      calories = Math.round(val);
      break;
    }
  }

  // 2. 탄수화물(g) 추출 (% 숫자보다 g 숫자를 우선 추출)
  function extractNutrientGrams(regexList, maxVal = 300) {
    for (const rx of regexList) {
      const m = norm.match(rx);
      if (m && m[1] !== undefined) {
        const val = parseFloat(m[1]);
        if (!isNaN(val) && val >= 0 && val <= maxVal) {
          return Math.round(val * 10) / 10;
        }
      }
    }
    return null;
  }

  const carbs = extractNutrientGrams([
    /탄\s*수\s*화\s*물[^\d\n]{0,12}(\d{1,3}(?:\.\d+)?)\s*[g9]/i,
    /탄\s*수\s*화\s*물\s*[:.]?\s*(\d{1,3}(?:\.\d+)?)/i,
    /Carbohydrate[^\d\n]{0,12}(\d{1,3}(?:\.\d+)?)\s*[g9]/i
  ]);

  const protein = extractNutrientGrams([
    /단\s*백\s*질[^\d\n]{0,12}(\d{1,3}(?:\.\d+)?)\s*[g9]/i,
    /단\s*백\s*질\s*[:.]?\s*(\d{1,3}(?:\.\d+)?)/i,
    /Protein[^\d\n]{0,12}(\d{1,3}(?:\.\d+)?)\s*[g9]/i
  ]);

  // 지방 추출 시 '포화지방', '트랜스지방', '불포화지방'을 먼저 지운 뒤 순수 '지방'을 찾음
  const normWithoutSatFat = norm
    .replace(/(포\s*화|트\s*랜\s*스|불\s*포\s*화)\s*지\s*방[^\n]{0,15}/g, ' ');

  let fat = null;
  for (const rx of [
    /지\s*방[^\d\n]{0,12}(\d{1,3}(?:\.\d+)?)\s*[g9]/i,
    /지\s*방\s*[:.]?\s*(\d{1,3}(?:\.\d+)?)/i,
    /Total\s*Fat[^\d\n]{0,12}(\d{1,3}(?:\.\d+)?)\s*[g9]/i
  ]) {
    const m = normWithoutSatFat.match(rx);
    if (m && m[1] !== undefined) {
      const val = parseFloat(m[1]);
      if (!isNaN(val) && val >= 0 && val <= 200) {
        fat = Math.round(val * 10) / 10;
        break;
      }
    }
  }

  const sugar = extractNutrientGrams([
    /당\s*류[^\d\n]{0,12}(\d{1,3}(?:\.\d+)?)\s*[g9]/i,
    /당\s*류\s*[:.]?\s*(\d{1,3}(?:\.\d+)?)/i,
    /Sugars?[^\d\n]{0,12}(\d{1,3}(?:\.\d+)?)\s*[g9]/i
  ]);

  // 3. 총 내용량 / 1회 제공량 (예: 210g, 100g, 190ml) 추출
  let amount = '1개(1회분)';
  const weightMatch =
    norm.match(/(?:총\s*내\s*용\s*량|내\s*용\s*량|제\s*공\s*량)[^\d\n]{0,10}(\d{2,4}\s*(?:g|ml|mL|G))/i) ||
    norm.match(/(\d{2,4}\s*(?:g|ml))\s*\(\s*\d+\s*(?:kcal|㎉)/i);
  if (weightMatch) {
    amount = `1개(${weightMatch[1].replace(/\s+/g, '')})`;
  }

  // 만약 칼로리가 빛 반사로 안 읽혔지만 탄/단/지 중 하나라도 읽혔다면 4-4-9 공식으로 자동 계산
  if (calories === null && (carbs !== null || protein !== null || fat !== null)) {
    calories = Math.round((carbs || 0) * 4 + (protein || 0) * 4 + (fat || 0) * 9);
  }

  // 제품 이름 추론 (사용자가 메모에 적었으면 최우선, 아니면 OCR에서 알려진 키워드 탐색)
  let foodName = (userMemo || '').trim();
  if (!foodName) {
    for (const entry of KOREAN_FOOD_DB) {
      for (const kw of entry.keywords) {
        if (norm.includes(kw)) {
          foodName = entry.name;
          break;
        }
      }
      if (foodName) break;
    }
  }
  if (!foodName) {
    if (/햇반|즉석밥|오뚜기밥/.test(norm)) foodName = '햇반(즉석밥)';
    else if (/닭가슴살/.test(norm)) foodName = '닭가슴살';
    else if (/프로틴|단백질/.test(norm) && /음료|드링크|밀크|우유/.test(norm)) foodName = '단백질 음료';
    else foodName = '성분표 스캔 식품 (이름을 적어주세요)';
  }

  const recognizedAny = calories !== null || carbs !== null || protein !== null || fat !== null;

  return {
    recognizedAny,
    item: {
      food_name: foodName,
      amount,
      calories: calories ?? 200,
      carbs: carbs ?? 20,
      protein: protein ?? 15,
      fat: fat ?? 5,
      sugar: sugar ?? 2,
      ai_note: recognizedAny
        ? `영양성분표 자동 스캔 (${calories ?? 0}kcal · 탄${carbs ?? 0}g · 단${protein ?? 0}g · 지${fat ?? 0}g)`
        : '성분표 글자가 흐려 기본값으로 채웠습니다. 숫자를 확인해 주세요.'
    }
  };
}

/**
 * OCR 텍스트에서 의미 있는 음식/메뉴 단어들을 추출하여 영양성분 계산
 */
function parseOcrTextToMenuItems(ocrText, userMemo = '') {
  const combined = `${userMemo ? userMemo + '\n' : ''}${ocrText || ''}`;

  const rawTokens = combined
    .replace(/[|[\]{}()<>~`!@#$%^&*=+_\\:;"'?,./]/g, ' ')
    .split(/[\r\n\s,·•+]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && /[가-힣]/.test(t));

  const stopWords = new Set([
    '월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일',
    '조식', '중식', '석식', '아침', '점심', '저녁', '간식', '식단표', '주간식단표',
    '영양량', '칼로리', '원산지', '알레르기', '안내', '메뉴', '코너', '구분',
    '영양정보', '영양성분', '내용량', '탄수화물', '단백질', '포화지방', '트랜스지방', '콜레스테롤', '나트륨'
  ]);

  const matchedItems = [];
  const seenNames = new Set();

  for (const token of rawTokens) {
    if (stopWords.has(token)) continue;
    let bestEntry = null;
    let bestLen = 0;

    for (const entry of KOREAN_FOOD_DB) {
      for (const kw of entry.keywords) {
        if (token.includes(kw) && kw.length > bestLen) {
          bestEntry = entry;
          bestLen = kw.length;
        }
      }
    }

    if (bestEntry && !seenNames.has(bestEntry.name)) {
      seenNames.add(bestEntry.name);
      matchedItems.push({
        food_name: token.length <= 12 ? token : bestEntry.name,
        amount: bestEntry.unit,
        calories: bestEntry.calories,
        carbs: bestEntry.carbs,
        protein: bestEntry.protein,
        fat: bestEntry.fat,
        sugar: bestEntry.sugar,
        ai_note: `내 PC 로컬 OCR 인식 (${bestEntry.name})`
      });
    }
  }

  const foodSuffixRegex = /^[가-힣]{1,10}(밥|국|탕|찌개|전골|볶음|구이|조림|찜|튀김|까스|가스|전|무침|나물|김치|깍두기|겉절이|면|국수|우동|파스타|빵|케이크|샐러드|죽|주스|라떼|커피|차|우유|요거트)$/;
  for (const token of rawTokens) {
    if (stopWords.has(token)) continue;
    if (foodSuffixRegex.test(token) && !seenNames.has(token) && matchedItems.length < 12) {
      seenNames.add(token);
      const estimated = estimateFromTextFallback(token)[0];
      if (estimated) {
        estimated.ai_note = '내 PC 로컬 OCR 메뉴 추출';
        matchedItems.push(estimated);
      }
    }
  }

  return matchedItems;
}

/**
 * 2. 내 PC에서 직접 이미지 분석 수행 (API 키 불필요)
 */
async function analyzeImageOnLocalPC({ mode, text, imageBase64, targetDate, targetMealType }) {
  const cleanBase64 = (imageBase64 || '').replace(/^data:[^;]+;base64,/, '');

  // (A) 로컬 Ollama 비전 AI가 켜져 있으면 최우선 사용
  const ollamaResult = await tryLocalOllamaVision({
    mode,
    text,
    cleanBase64,
    targetDate,
    targetMealType
  });
  if (ollamaResult) {
    return ollamaResult;
  }

  // (B) 내 PC의 로컬 한국어 OCR (Tesseract.js)로 사진 속 글자 읽기
  let rawOcrText = '';
  if (cleanBase64) {
    try {
      const imgBuffer = Buffer.from(cleanBase64, 'base64');
      const worker = await getKoreanOcrWorker();
      const { data } = await worker.recognize(imgBuffer);
      rawOcrText = (data?.text || '').trim();
    } catch (ocrErr) {
      console.error('[Local OCR Error]:', ocrErr.message);
    }
  }

  // (C) 영양성분표 모드이거나, 이미지 안에서 '영양정보/탄수화물/단백질/kcal' 패턴이 감지된 경우!
  const looksLikeNutritionLabel =
    mode === 'nutrition_label' ||
    (/탄\s*수\s*화\s*물|단\s*백\s*질|영\s*양\s*정\s*보|영\s*양\s*성\s*분/i.test(rawOcrText) &&
      /\d+\s*(?:kcal|㎉|g)/i.test(rawOcrText));

  if (looksLikeNutritionLabel) {
    const parsedLabel = parseNutritionLabelOcr(rawOcrText, text);
    return {
      engine: '내 PC 영양성분표 자동 스캐너 (로컬 OCR)',
      mode: 'nutrition_label',
      summary: parsedLabel.recognizedAny
        ? `✅ 포장지 영양성분표에서 칼로리(${parsedLabel.item.calories}kcal)와 탄·단·지 수치를 자동으로 읽어왔습니다! 제품 이름만 확인하고 [⭐ 빠른음식 저장] 또는 [식단표에 저장]을 눌러주세요.`
        : `사진에서 영양성분표 글자가 흐릿하여 기본값으로 채웠습니다. 글자가 잘 보이게 가까이 찍거나 아래 숫자를 살짝 수정해 주세요.`,
      is_multi_slot: false,
      slots: [],
      items: [parsedLabel.item]
    };
  }

  // (D) 일반 식단표 / 음식 사진 처리
  const memoItems = text && text.trim() ? estimateFromTextFallback(text.trim()) : [];
  const ocrItems = rawOcrText ? parseOcrTextToMenuItems(rawOcrText, '') : [];

  const merged = [...memoItems];
  const existingNames = new Set(merged.map(i => i.food_name));
  for (const item of ocrItems) {
    if (!existingNames.has(item.food_name)) {
      existingNames.add(item.food_name);
      merged.push(item);
    }
  }

  if (merged.length > 0) {
    return {
      engine: '내 PC 로컬 분석 엔진 (한국어 OCR + 내장 영양DB)',
      mode,
      summary: `외부 API 키 없이 내 PC에서 직접 분석하여 ${merged.length}개 메뉴의 칼로리를 계산했습니다!`,
      is_multi_slot: false,
      slots: [],
      items: merged
    };
  }

  return {
    engine: '내 PC 로컬 사진 등록 모드',
    mode,
    summary: '촬영된 사진이 첨부되었습니다. 아래 [음식명] 칸에 음식 이름(예: 햇반, 닭가슴살)을 적으시면 사진과 함께 저장됩니다.',
    is_multi_slot: false,
    slots: [],
    items: [
      {
        food_name: text.trim() || '촬영한 식사 (음식명을 수정하세요)',
        amount: '1인분',
        calories: 350,
        carbs: 40,
        protein: 20,
        fat: 10,
        sugar: 3,
        ai_note: '촬영 사진 첨부됨'
      }
    ]
  };
}

module.exports = {
  analyzeImageOnLocalPC,
  parseNutritionLabelOcr
};
