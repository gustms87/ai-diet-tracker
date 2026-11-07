// ============================================================================
// 내 PC 로컬 이미지·식단표 분석 엔진 (Google API 키 없이 PC에서 직접 처리)
// 1순위: 내 PC의 로컬 비전 AI (Ollama - RTX 4070 Ti GPU 가속)
// 2순위: 내 PC의 로컬 한국어 OCR (Tesseract.js kor+eng) + 내장 한국음식 영양DB 매칭
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
async function tryLocalOllamaVision({ mode, text, cleanBase64, targetDate, targetMealType }) {
  try {
    const tagsRes = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(1500)
    });
    if (!tagsRes.ok) return null;
    const tagsData = await tagsRes.json();
    const models = (tagsData.models || []).map(m => m.name);

    // 비전 지원 모델 탐색 (gemma3, llava, qwen2.5vl, llama3.2-vision, minicpm-v 등)
    const visionModel = models.find(m =>
      /gemma3|llava|vl|vision|minicpm|moondream|bakllava/i.test(m)
    );
    if (!visionModel) return null;

    const prompt = mode === 'menu_table'
      ? `이 식단표 이미지를 읽고 메뉴 이름과 1인분 기준 칼로리(kcal), 탄수화물(g), 단백질(g), 지방(g), 당류(g)를 다음 JSON 형식으로만 출력하세요. 추가 메모: "${text || '없음'}"
{"summary":"한줄 요약","items":[{"food_name":"음식명","amount":"1인분","calories":300,"carbs":40,"protein":15,"fat":8,"sugar":3,"ai_note":"식단표 인식"}]}`
      : `이 음식 사진에 보이는 모든 한국 음식/반찬/음료를 식별하고 1인분 기준 칼로리(kcal), 탄수화물(g), 단백질(g), 지방(g), 당류(g)를 다음 JSON 형식으로만 출력하세요. 추가 메모: "${text || '없음'}"
{"summary":"영양 한줄 코멘트","items":[{"food_name":"음식명","amount":"1인분","calories":350,"carbs":45,"protein":20,"fat":10,"sugar":4,"ai_note":"사진 분석"}]}`;

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
  } catch (_) {
    // 로컬 Ollama 미실행 시 조용히 다음 단계(로컬 OCR)로 진행
  }
  return null;
}

/**
 * OCR 텍스트에서 의미 있는 음식/메뉴 단어들을 추출하여 영양성분 계산
 */
function parseOcrTextToMenuItems(ocrText, userMemo = '') {
  const combined = `${userMemo ? userMemo + '\n' : ''}${ocrText || ''}`;

  // 노이즈 제거 (특수문자, 날짜/숫자만 있는 줄, 요일 헤더 등 정리)
  const rawTokens = combined
    .replace(/[|[\]{}()<>~`!@#$%^&*=+_\\:;"'?,./]/g, ' ')
    .split(/[\r\n\s,·•+]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && /[가-힣]/.test(t));

  // 불용어 제외
  const stopWords = new Set([
    '월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일',
    '조식', '중식', '석식', '아침', '점심', '저녁', '간식', '식단표', '주간식단표',
    '영양량', '칼로리', '원산지', '알레르기', '안내', '메뉴', '코너', '구분'
  ]);

  const matchedItems = [];
  const seenNames = new Set();

  // 1차: 내장 한국음식 DB에서 정확히 매칭되는 메뉴 탐색
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

  // 2차: DB에 정확히 없지만 한국 음식 접미사(밥, 국, 탕, 찌개, 볶음, 구이, 조림, 튀김, 전, 무침, 나물, 김치, 면, 빵, 샐러드, 죽)로 끝나는 단어 추출
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

  // (A) 먼저 로컬 Ollama 비전 AI가 켜져 있으면 최우선 사용
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

  // (B) 사용자가 보충 메모에 음식 이름을 함께 적은 경우 즉시 계산에 반영
  const memoItems = text && text.trim() ? estimateFromTextFallback(text.trim()) : [];

  // (C) 내 PC의 로컬 한국어 OCR (Tesseract.js)로 사진 속 글자/식단표 메뉴 직접 읽기
  let ocrItems = [];
  let rawOcrPreview = '';
  if (cleanBase64) {
    try {
      const imgBuffer = Buffer.from(cleanBase64, 'base64');
      const worker = await getKoreanOcrWorker();
      const { data } = await worker.recognize(imgBuffer);
      rawOcrPreview = (data?.text || '').trim();
      if (rawOcrPreview) {
        ocrItems = parseOcrTextToMenuItems(rawOcrPreview, '');
      }
    } catch (ocrErr) {
      console.error('[Local OCR Error]:', ocrErr.message);
    }
  }

  // 메모 항목과 OCR 인식 항목 합치기 (중복 제거)
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
      summary: `외부 API 키 없이 내 PC에서 직접 분석하여 ${merged.length}개 메뉴의 칼로리를 계산했습니다. 아래 목록에서 수량이나 이름을 자유롭게 수정한 뒤 저장하세요!`,
      is_multi_slot: false,
      slots: [],
      items: merged
    };
  }

  // (D) 글자가 전혀 없는 일반 음식 사진인데 메모도 비어 있는 경우:
  // 에러를 내지 않고 사진을 첨부한 채로 바로 이름을 적거나 수정할 수 있게 기본 행을 생성해 줌
  return {
    engine: '내 PC 로컬 사진 등록 모드',
    mode,
    summary: '사진에 글자(메뉴판/식단표)가 없어 기본 한식 1인분으로 항목을 준비했습니다. 아래 [음식명] 칸에 드신 음식 이름을 적거나 수정하시면 사진과 함께 바로 저장됩니다! (글자 없는 음식 사진까지 내 PC 그래픽카드로 자동 식별하려면 무료 로컬 AI Ollama를 켜실 수 있습니다.)',
    is_multi_slot: false,
    slots: [],
    items: [
      {
        food_name: '촬영한 식사 (음식명을 수정하세요)',
        amount: '1인분',
        calories: 550,
        carbs: 65,
        protein: 25,
        fat: 18,
        sugar: 5,
        ai_note: '촬영 사진 첨부됨'
      }
    ]
  };
}

module.exports = {
  analyzeImageOnLocalPC
};
