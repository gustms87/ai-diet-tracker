// ============================================================================
// 내 PC 로컬 이미지·영양성분표·식단표 분석 엔진 (Google API 키 불필요)
// - 카메라로 찍거나 올린 사진 속에 적힌 칼로리(kcal)와 영양성분(탄·단·지·당·중량)을
//   최우선으로 추출하여 적용합니다.
// - Windows 내장 신경망 한국어 OCR (Windows.Media.Ocr) + 좌표 기반 표 분석 + Tesseract 보조
// ============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
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
 * Windows 10/11 내장 신경망 한국어 OCR (win-ocr.ps1) 실행
 * - 한글 포장지, 영양성분표, 식단표 인식률이 매우 높고 단어별 (x, y) 좌표를 함께 반환합니다.
 */
function runWindowsNativeOcr(imgBuffer) {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `diet_ocr_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    try {
      fs.writeFileSync(tmpFile, imgBuffer);
    } catch (_) {
      return resolve(null);
    }

    const scriptPath = path.join(__dirname, 'win-ocr.ps1');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ImagePath', tmpFile],
      { timeout: 8000, maxBuffer: 5 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        if (err || !stdout) return resolve(null);
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(parsed);
        } catch (_) {
          resolve(null);
        }
      }
    );
  });
}

/**
 * 한국어 OCR에서 숫자 뒤의 'g'(그램)이 '9' 또는 'q'로 인식되는 현상을 정확히 복원합니다.
 * 예: "25g" -> "259" -> 25, "1.5g" -> "1.59" -> 1.5, "0g" -> "09" -> 0, "4g" -> "4g" -> 4
 */
function parseGramToken(rawToken, maxVal = 300) {
  if (!rawToken) return null;
  const cleaned = String(rawToken)
    .replace(/,/g, '')
    .replace(/^\(|\)$/g, '')
    .trim();

  // % (퍼센트 기준치) 또는 mg, kcal 토큰은 제외
  if (/%|mg|㎎|kcal|㎉|ml|mL/i.test(cleaned)) return null;

  // 1) 명시적으로 g/g/q가 붙은 경우: "25g", "1.5g", "0g"
  const explicitG = cleaned.match(/^(\d{1,3}(?:\.\d+)?)\s*[gGｇqQ]$/);
  if (explicitG) {
    const v = parseFloat(explicitG[1]);
    return v >= 0 && v <= maxVal ? Math.round(v * 10) / 10 : null;
  }

  // 2) Windows 한국어 OCR에서 'g'가 '9'로 변환된 경우:
  //    - "09" (0g), "49" (4g), "259" (25g), "709" (70g), "1.59" (1.5g), "0.69" (0.6g)
  const trailingNine = cleaned.match(/^(\d{1,3}(?:\.\d+)?)9$/);
  if (trailingNine) {
    const v = parseFloat(trailingNine[1]);
    if (v >= 0 && v <= maxVal) {
      return Math.round(v * 10) / 10;
    }
  }

  // 3) 단위 없이 숫자만 있는 표 셀 (예: "24", "1.5", "0")
  const pureNum = cleaned.match(/^(\d{1,3}(?:\.\d+)?)$/);
  if (pureNum) {
    const v = parseFloat(pureNum[1]);
    if (v >= 0 && v <= maxVal) {
      return Math.round(v * 10) / 10;
    }
  }

  return null;
}

/**
 * 사진 속 OCR 결과(줄/단어 좌표 및 전체 텍스트)에서
 * 칼로리(kcal), 탄수화물(g), 단백질(g), 지방(g), 당류(g), 총 내용량(g/ml)을 최우선 추출합니다.
 */
function extractNutritionFromOcrData(winOcrData, tesseractText, userMemo = '') {
  const winText = winOcrData?.fullText || '';
  const combinedText = `${winText}\n${tesseractText || ''}`;
  const lines = Array.isArray(winOcrData?.lines) ? winOcrData.lines : [];

  // "2,000 kcal 기준" 안내 문구 제거 (기준치 2000kcal를 식품 칼로리로 오인하는 것 방지)
  const textWithout2000Ref = combinedText
    .replace(/,/g, '')
    .replace(/2000\s*(?:kcal|㎉|칼로리)\s*기준/gi, ' ')
    .replace(/기준치[^\n]{0,25}2000\s*(?:kcal|㎉)/gi, ' ');

  // --------------------------------------------------------------------------
  // 1. 칼로리(kcal / 열량) 추출
  // --------------------------------------------------------------------------
  let calories = null;
  const calRegexes = [
    /(\d{1,4}(?:\.\d+)?)\s*(?:kcal|㎉|kca1|kcaI|KCAL|칼로리)/gi,
    /열\s*량\s*[:.]?\s*(\d{1,4}(?:\.\d+)?)/gi,
    /칼\s*로\s*리\s*[:.]?\s*(\d{1,4}(?:\.\d+)?)/gi
  ];
  for (const rx of calRegexes) {
    const matches = [...textWithout2000Ref.matchAll(rx)];
    for (const m of matches) {
      const val = parseFloat(m[1]);
      if (val >= 5 && val !== 2000 && val <= 3500) {
        calories = Math.round(val);
        break;
      }
    }
    if (calories !== null) break;
  }

  // --------------------------------------------------------------------------
  // 2. 단어 좌표(X, Y) 및 줄 단위 기반으로 영양성분(탄수화물/단백질/지방/당류) 정밀 추출
  // --------------------------------------------------------------------------
  function findNutrientByKeyword(keywordRegex, excludeRegex = null, maxVal = 250) {
    // (A) Windows OCR 줄/단어 배열에서 탐색 (가로형 표 + 세로형 표 모두 대응)
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const words = line.words || [];

      for (let wi = 0; wi < words.length; wi++) {
        const wText = words[wi].text || '';
        // 두 단어로 갈라진 경우(예: "탄수" + "화물")까지 합쳐서 확인
        const twoWord = wi + 1 < words.length ? wText + words[wi + 1].text : wText;

        const matchedSingle = keywordRegex.test(wText) && (!excludeRegex || !excludeRegex.test(wText));
        const matchedTwo = !matchedSingle && keywordRegex.test(twoWord) && (!excludeRegex || !excludeRegex.test(twoWord));

        if (matchedSingle || matchedTwo) {
          const startIdx = matchedTwo ? wi + 2 : wi + 1;
          const kwX = words[wi].x;

          // 1) 같은 줄의 오른쪽 단어들에서 첫 번째 유효한 g 수치 찾기 (예: "탄수화물 49 (1%)" 또는 "탄수화물 1% 49")
          for (let k = startIdx; k < Math.min(words.length, startIdx + 4); k++) {
            const candidate = words[k].text;
            // 다른 영양소 이름이 나오면 중단
            if (/탄수|단백|지방|당류|나트륨|콜레스|열량/.test(candidate)) break;
            const parsed = parseGramToken(candidate, maxVal);
            if (parsed !== null) return parsed;
          }

          // 2) 가로 방향 표(헤더 아랫줄에 수치가 있는 표)인 경우: 바로 다음 줄에서 X 좌표가 비슷한 단어 찾기
          if (li + 1 < lines.length) {
            const nextWords = lines[li + 1].words || [];
            let bestWord = null;
            let bestDist = 9999;
            for (const nw of nextWords) {
              const dist = Math.abs((nw.x || 0) - (kwX || 0));
              if (dist < 100 && dist < bestDist) {
                const parsed = parseGramToken(nw.text, maxVal);
                if (parsed !== null) {
                  bestDist = dist;
                  bestWord = parsed;
                }
              }
            }
            if (bestWord !== null) return bestWord;
          }
        }
      }
    }

    // (B) 전체 텍스트에서 정규식으로 탐색 (줄바꿈/공백 포함)
    let targetText = combinedText.replace(/,/g, '');
    if (excludeRegex) {
      targetText = targetText.replace(new RegExp(excludeRegex.source + '[^\\d\\n]{0,15}\\d+(?:\\.\\d+)?[g9%]?', 'gi'), ' ');
    }

    // 예: "탄수화물 70g", "탄수화물 709", "탄수화물 22% 70g"
    const pattern = new RegExp(
      keywordRegex.source + '[^\\d\\n]{0,15}(?:\\d{1,3}%\\s*)?(\\d{1,3}(?:\\.\\d+)?[gG9qQ]?)',
      'i'
    );
    const m = targetText.match(pattern);
    if (m && m[1]) {
      const parsed = parseGramToken(m[1], maxVal);
      if (parsed !== null) return parsed;
    }

    return null;
  }

  const carbs = findNutrientByKeyword(/^(?:탄\s*수\s*화\s*물|탄수화물|Carbohydrate)/i, null, 250);
  const protein = findNutrientByKeyword(/^(?:단\s*백\s*질|단백질|단백실|Protein)/i, null, 200);
  const fat = findNutrientByKeyword(/^(?:지\s*방|지방|Fat)/i, /포\s*화|트\s*랜\s*스|불\s*포\s*화/i, 180);
  const sugar = findNutrientByKeyword(/^(?:당\s*류|당류|Sugars?)/i, null, 150);

  // --------------------------------------------------------------------------
  // 3. 총 내용량 / 중량 (g / ml) 추출 (예: "총 내용량 100g", "1009 (135 kcal)", "210g")
  // --------------------------------------------------------------------------
  let amount = null;
  const flatNoComma = combinedText.replace(/,/g, '');

  const weightPatterns = [
    /(?:총\s*내\s*용\s*량|내\s*용\s*량|제\s*공\s*량)[^\d\n]{0,12}(\d{2,4})\s*(?:[gG9]|ml|mL)/i,
    /(\d{2,4})\s*(?:[gG9]|ml|mL)\s*\(\s*\d{2,4}\s*(?:kcal|㎉)/i,
    /(\d{2,4}\s*(?:g|ml|mL))\b/i
  ];
  for (const wp of weightPatterns) {
    const wm = flatNoComma.match(wp);
    if (wm && wm[1]) {
      const rawW = wm[1].replace(/\s+/g, '');
      if (/^\d+$/.test(rawW)) {
        const numW = parseInt(rawW, 10);
        if (numW >= 25 && numW <= 1500 && numW !== calories) {
          amount = `1개(${numW}g)`;
          break;
        }
      } else {
        amount = `1개(${rawW})`;
        break;
      }
    }
  }

  // 칼로리가 안 적혀 있거나 빛에 가렸는데 탄/단/지가 읽힌 경우 4-4-9 공식으로 계산
  if (calories === null && (carbs !== null || protein !== null || fat !== null)) {
    calories = Math.round((carbs || 0) * 4 + (protein || 0) * 4 + (fat || 0) * 9);
  }

  // 반대로 칼로리와 단백질(예: 앞면 포장지 "120kcal 단백질 23g")만 적혀 있고 탄/지가 없는 경우 자연스럽게 보정
  const anyMacroFound = carbs !== null || protein !== null || fat !== null || sugar !== null;
  const anyNumberFound = calories !== null || anyMacroFound;

  // --------------------------------------------------------------------------
  // 4. 사진 속 텍스트에서 제품명(음식 이름) 추출
  // --------------------------------------------------------------------------
  let foodName = (userMemo || '').trim();
  if (!foodName && lines.length > 0) {
    // 영양정보 표 헤더가 아닌 상단 줄에서 제품명 후보 찾기
    const ignoreLineRx = /영양정보|영양성분|내용량|탄수화물|단백질|포화지방|트랜스지방|콜레스테롤|나트륨|기준치|kcal|%|원재료|보관방법|소비기한|유통기한/i;
    for (const l of lines) {
      const txt = (l.text || '').trim().replace(/닭가습살/g, '닭가슴살');
      if (txt.length >= 2 && txt.length <= 28 && /[가-힣]/.test(txt) && !ignoreLineRx.test(txt)) {
        foodName = txt;
        break;
      }
    }
  }
  if (!foodName) {
    for (const entry of KOREAN_FOOD_DB) {
      for (const kw of entry.keywords) {
        if (combinedText.includes(kw)) {
          foodName = entry.name;
          break;
        }
      }
      if (foodName) break;
    }
  }

  return {
    anyNumberFound,
    calories,
    carbs,
    protein,
    fat,
    sugar,
    amount: amount || '1개(1인분)',
    foodName: foodName || '스캔한 식품 (이름 확인)',
    rawText: combinedText.trim()
  };
}

/**
 * 식단표 캡처 등에서 여러 메뉴 단어들을 추출
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
        ai_note: `식단표 글자 인식 (${bestEntry.name})`
      });
    }
  }

  return matchedItems;
}

/**
 * 내 PC에서 직접 이미지 분석 수행
 * - 사진 안에 칼로리(kcal)나 영양성분(탄수화물/단백질/지방/당류)이 적혀 있으면
 *   어떤 모드에서 찍었든 무조건 사진에 적힌 실제 수치를 최우선으로 적용합니다!
 */
async function analyzeImageOnLocalPC({ mode, text, imageBase64 }) {
  const cleanBase64 = (imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
  const imgBuffer = cleanBase64 ? Buffer.from(cleanBase64, 'base64') : null;

  let winOcrData = null;
  let tesseractText = '';

  if (imgBuffer) {
    // 1. Windows 내장 신경망 한국어 OCR 실행 (가장 빠르고 정확함)
    winOcrData = await runWindowsNativeOcr(imgBuffer);

    // 2. Windows OCR 결과가 비어있거나 보조가 필요할 때 Tesseract 실행
    if (!winOcrData || !winOcrData.fullText) {
      try {
        const worker = await getKoreanOcrWorker();
        const { data } = await worker.recognize(imgBuffer);
        tesseractText = (data?.text || '').trim();
      } catch (_) {}
    }
  }

  // --------------------------------------------------------------------------
  // 최우선 순위: 사진 안에 적힌 칼로리(kcal) 및 영양성분(탄·단·지·당) 추출!
  // --------------------------------------------------------------------------
  const extracted = extractNutritionFromOcrData(winOcrData, tesseractText, text);

  if (extracted.anyNumberFound && mode !== 'menu_table') {
    const cal = extracted.calories ?? 0;
    const c = extracted.carbs ?? 0;
    const p = extracted.protein ?? 0;
    const f = extracted.fat ?? 0;
    const s = extracted.sugar ?? 0;

    const detectedParts = [];
    if (extracted.calories !== null) detectedParts.push(`열량 ${cal}kcal`);
    if (extracted.carbs !== null) detectedParts.push(`탄수화물 ${c}g`);
    if (extracted.protein !== null) detectedParts.push(`단백질 ${p}g`);
    if (extracted.fat !== null) detectedParts.push(`지방 ${f}g`);
    if (extracted.sugar !== null) detectedParts.push(`당류 ${s}g`);

    return {
      engine: '사진 속 영양성분/칼로리 직접 추출 (내 PC 신경망 OCR)',
      mode: 'nutrition_label',
      summary: `✅ 사진에 적힌 수치(${detectedParts.join(' · ')})를 그대로 읽어서 적용했습니다! 제품명을 확인하고 저장하세요.`,
      is_multi_slot: false,
      slots: [],
      items: [
        {
          food_name: extracted.foodName,
          amount: extracted.amount,
          calories: cal,
          carbs: c,
          protein: p,
          fat: f,
          sugar: s,
          ai_note: `사진 속 표기 수치 적용 (${detectedParts.join(', ')})`
        }
      ]
    };
  }

  // --------------------------------------------------------------------------
  // 차순위: 식단표 캡처 또는 메뉴 이름만 적힌 이미지
  // --------------------------------------------------------------------------
  const memoItems = text && text.trim() ? estimateFromTextFallback(text.trim()) : [];
  const ocrItems = extracted.rawText ? parseOcrTextToMenuItems(extracted.rawText, '') : [];

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
      engine: '내 PC 한글 메뉴 인식 엔진',
      mode,
      summary: `사진에서 ${merged.length}개 메뉴 이름을 인식했습니다.`,
      is_multi_slot: false,
      slots: [],
      items: merged
    };
  }

  // 사진에서 글자가 전혀 안 읽힌 경우 (초점이 흐리거나 글자가 없는 순수 음식 사진)
  return {
    engine: '사진 직접 입력 모드 (글자 미감지)',
    mode,
    summary: '⚠️ 사진 속에서 칼로리나 성분표 글자가 선명하게 읽히지 않았습니다. 성분표 글자가 잘 보이도록 조금 더 가까이서 초점을 맞춰 다시 찍거나, 아래 칸에 수치를 직접 입력해 주세요.',
    is_multi_slot: false,
    slots: [],
    items: [
      {
        food_name: (text || '').trim() || '음식 이름 입력',
        amount: '1개(1인분)',
        calories: 0,
        carbs: 0,
        protein: 0,
        fat: 0,
        sugar: 0,
        ai_note: '글자가 인식되지 않아 0으로 비워두었습니다 (직접 입력 또는 재촬영)'
      }
    ]
  };
}

module.exports = {
  analyzeImageOnLocalPC,
  extractNutritionFromOcrData
};
