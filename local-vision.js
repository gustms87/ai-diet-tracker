// ============================================================================
// 내 PC 로컬 이미지·영양성분표·식단표 정밀 분석 엔진 (Google API 키 불필요)
// - Windows 신경망 한국어 OCR (정방향 + 역상 반전 + 회전 보정 + 해상도 확대)
//   + Tesseract 한/영 듀얼 OCR 병렬 실행으로 사진 속 칼로리·영양성분 인식률 극대화
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
      { timeout: 12000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
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

async function runTesseractOcr(imgBuffer) {
  try {
    const worker = await getKoreanOcrWorker();
    const { data } = await worker.recognize(imgBuffer);
    return (data?.text || '').trim();
  } catch (_) {
    return '';
  }
}

/**
 * 숫자+단위 토큰에서 그램(g) 수치를 추출합니다.
 * - Windows 한국어 OCR에서 'g'가 '9'로 변환된 경우(예: 25g -> 259, 1.5g -> 1.59, 0g -> 09)를
 *   정확히 판별하여 복원합니다.
 */
function parseGramToken(rawToken, nextToken = '', maxVal = 250) {
  if (!rawToken) return null;
  const cleaned = String(rawToken)
    .replace(/,/g, '')
    .replace(/^[(:]+|[):]+$/g, '')
    .trim();

  // 퍼센트(%), mg, kcal, ml 토큰은 그램(g)이 아니므로 제외
  if (/%|mg|㎎|kcal|㎉|ml|mL/i.test(cleaned)) return null;

  // 다음 단어에 '%'가 바로 붙어 있는 경우(예: "22" + "%") 제외
  if (/^%/.test(String(nextToken || '').trim())) return null;

  // 1) 명시적으로 g/q가 붙은 경우: "25g", "1.5g", "0g"
  const explicitG = cleaned.match(/^(\d{1,3}(?:\.\d+)?)\s*[gGｇqQ]$/);
  if (explicitG) {
    const v = parseFloat(explicitG[1]);
    return v >= 0 && v <= maxVal ? Math.round(v * 10) / 10 : null;
  }

  // 2) 다음 단어가 단독 'g'인 경우 (예: "70" + "g") -> 숫자 그대로 반환 ('9'를 자르지 않음!)
  if (/^[gGｇqQ]\b/.test(String(nextToken || '').trim())) {
    const numMatch = cleaned.match(/^(\d{1,3}(?:\.\d+)?)$/);
    if (numMatch) {
      const v = parseFloat(numMatch[1]);
      return v >= 0 && v <= maxVal ? Math.round(v * 10) / 10 : null;
    }
  }

  // 3) 소수점 둘째 자리가 9로 끝나는 경우 (예: "1.59" = 1.5g, "0.69" = 0.6g, "2.19" = 2.1g)
  //    한국 영양성분표의 g 단위는 소수점 첫째 자리까지만 표기되므로 100% 끝의 9는 'g'입니다.
  const decimalNine = cleaned.match(/^(\d{1,3}\.\d)9$/);
  if (decimalNine) {
    const v = parseFloat(decimalNine[1]);
    return v >= 0 && v <= maxVal ? Math.round(v * 10) / 10 : null;
  }

  // 4) "09" (0g) 또는 3자리 이상인데 9로 끝나는 경우 (예: "259" = 25g, "709" = 70g)
  if (cleaned === '09') return 0;
  const threeDigitNine = cleaned.match(/^(\d{2,3})9$/);
  if (threeDigitNine) {
    const v = parseFloat(threeDigitNine[1]);
    return v >= 0 && v <= maxVal ? v : null;
  }

  // 5) 2자리이고 9로 끝나는 경우 (예: "49" = 4g, "69" = 6g, "99" = 9g)
  const twoDigitNine = cleaned.match(/^(\d)9$/);
  if (twoDigitNine) {
    return parseFloat(twoDigitNine[1]);
  }

  // 6) 순수 숫자 (예: "24", "1.5", "0")
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
 * OCR 결과(Windows OCR + Tesseract OCR)에서 칼로리 및 영양성분을 최우선 추출합니다.
 */
function extractNutritionFromOcrData(winOcrData, tesseractText, userMemo = '') {
  const winText = winOcrData?.fullText || '';
  const combinedText = `${winText}\n${tesseractText || ''}`;
  const lines = Array.isArray(winOcrData?.lines) ? winOcrData.lines : [];

  // "2,000 kcal 기준" 문구만 안전하게 제거 (실제 열량이 같은 줄에 있어도 보존되도록 정확히 해당 구문만 치환)
  const textWithout2000Ref = combinedText
    .replace(/,/g, '')
    .replace(/2\s*0\s*0\s*0\s*(?:kcal|㎉|kca1|kcaI|칼로리)\s*기\s*준/gi, ' ')
    .replace(/기준치[가-힣\s()*%0-9]{0,20}2000\s*(?:kcal|㎉)/gi, ' ');

  // --------------------------------------------------------------------------
  // 1. 칼로리(kcal / 열량) 추출
  // --------------------------------------------------------------------------
  let calories = null;
  const calCandidates = [];

  const calRegexes = [
    /(\d{1,4}(?:\.\d+)?)\s*(?:kcal|㎉|kca1|kcaI|kcai|KCAL|칼로리)/gi,
    /열\s*량\s*[:.]?\s*(\d{1,4}(?:\.\d+)?)/gi,
    /칼\s*로\s*리\s*[:.]?\s*(\d{1,4}(?:\.\d+)?)/gi
  ];

  for (const rx of calRegexes) {
    const matches = [...textWithout2000Ref.matchAll(rx)];
    for (const m of matches) {
      const val = parseFloat(m[1]);
      if (val >= 5 && val !== 2000 && val <= 3000) {
        calCandidates.push(Math.round(val));
      }
    }
  }
  if (calCandidates.length > 0) {
    calories = calCandidates[0];
  }

  // --------------------------------------------------------------------------
  // 2. 영양성분(탄수화물/단백질/지방/당류) 추출
  //    - 단어가 붙어있는 경우("탄수화물70g", "탄수화물709")도 처리
  //    - %가 앞에 오든 뒤에 오든("탄수화물 22% 70g", "탄수화물 70g 22%") 처리
  //    - 가로형 표(윗줄 헤더, 아랫줄 수치)도 X 좌표로 매칭
  // --------------------------------------------------------------------------
  function findNutrientByKeyword(keywordRegex, excludeRegex = null, maxVal = 250) {
    // (A) 먼저 Tesseract 텍스트(영어 'g' 인식 정확도 높음)에서 명시적 '<숫자>g' 탐색
    let tessTarget = (tesseractText || '').replace(/,/g, '');
    if (excludeRegex) {
      tessTarget = tessTarget.replace(new RegExp(excludeRegex.source + '[^\\n]{0,18}', 'gi'), ' ');
    }
    const explicitTessRx = new RegExp(
      keywordRegex.source + '[^\\d\\n]{0,15}(?:\\d{1,3}\\s*%\\s*)?(\\d{1,3}(?:\\.\\d+)?)\\s*[gGｇ]',
      'i'
    );
    const tessMatch = tessTarget.match(explicitTessRx);
    if (tessMatch && tessMatch[1] !== undefined) {
      const v = parseFloat(tessMatch[1]);
      if (!isNaN(v) && v >= 0 && v <= maxVal) {
        return Math.round(v * 10) / 10;
      }
    }

    // (B) Windows 신경망 OCR 줄/단어 좌표 탐색
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const words = line.words || [];

      for (let wi = 0; wi < words.length; wi++) {
        const wText = words[wi].text || '';
        const twoWord = wi + 1 < words.length ? wText + words[wi + 1].text : wText;

        const matchedSingle = keywordRegex.test(wText) && (!excludeRegex || !excludeRegex.test(wText));
        const matchedTwo = !matchedSingle && keywordRegex.test(twoWord) && (!excludeRegex || !excludeRegex.test(twoWord));

        if (matchedSingle || matchedTwo) {
          const kwX = words[wi].x;

          // 0) 만약 키워드 단어 자체에 숫자가 붙어있는 경우 (예: "탄수화물70g", "탄수화물709", "단백질24g")
          const targetWord = matchedTwo ? twoWord : wText;
          const restInWord = targetWord.replace(keywordRegex, '').replace(/^[:.\s]+/, '');
          if (/\d/.test(restInWord)) {
            const nextW = words[matchedTwo ? wi + 2 : wi + 1]?.text || '';
            const inWordVal = parseGramToken(restInWord, nextW, maxVal);
            if (inWordVal !== null) return inWordVal;
          }

          // 1) 같은 줄의 오른쪽 단어들에서 찾기
          const startIdx = matchedTwo ? wi + 2 : wi + 1;
          for (let k = startIdx; k < Math.min(words.length, startIdx + 5); k++) {
            const candidate = words[k].text;
            const nextToken = words[k + 1]?.text || '';
            if (/탄수|단백|지방|당류|나트륨|콜레스|열량|칼로리/.test(candidate)) break;
            const parsed = parseGramToken(candidate, nextToken, maxVal);
            if (parsed !== null) return parsed;
          }

          // 2) 가로 방향 표(헤더 바로 아랫줄 같은 X 좌표에 수치가 있는 표)
          if (li + 1 < lines.length) {
            const nextWords = lines[li + 1].words || [];
            let bestVal = null;
            let bestDist = 9999;
            for (let nwIdx = 0; nwIdx < nextWords.length; nwIdx++) {
              const nw = nextWords[nwIdx];
              const dist = Math.abs((nw.x || 0) - (kwX || 0));
              if (dist < 110 && dist < bestDist) {
                const parsed = parseGramToken(nw.text, nextWords[nwIdx + 1]?.text || '', maxVal);
                if (parsed !== null) {
                  bestDist = dist;
                  bestVal = parsed;
                }
              }
            }
            if (bestVal !== null) return bestVal;
          }
        }
      }
    }

    // (C) 전체 합산 텍스트 정규식 탐색
    let targetText = combinedText.replace(/,/g, '');
    if (excludeRegex) {
      targetText = targetText.replace(new RegExp(excludeRegex.source + '[^\\d\\n]{0,15}\\d+(?:\\.\\d+)?[g9%]?', 'gi'), ' ');
    }
    const pattern = new RegExp(
      keywordRegex.source + '[^\\d\\n]{0,15}(?:\\d{1,3}\\s*%\\s*)?(\\d{1,3}(?:\\.\\d+)?\\s*[gG9qQ]?)',
      'i'
    );
    const m = targetText.match(pattern);
    if (m && m[1]) {
      const rawCap = m[1].trim();
      const parts = rawCap.split(/\s+/);
      const parsed = parseGramToken(parts[0], parts[1] || '', maxVal);
      if (parsed !== null) return parsed;
    }

    return null;
  }

  const carbs = findNutrientByKeyword(/(?:탄\s*수\s*화\s*[물믈]|탄수회물|Carbohydrate)/i, null, 250);
  const protein = findNutrientByKeyword(/(?:단\s*백\s*[질실]|Protein)/i, null, 200);
  const fat = findNutrientByKeyword(/(?:지\s*방|Fat)/i, /포\s*화|트\s*랜\s*스|불\s*포\s*화/i, 180);
  const sugar = findNutrientByKeyword(/(?:당\s*류|Sugars?)/i, null, 150);

  // --------------------------------------------------------------------------
  // 3. 총 내용량 / 중량 (g / ml) 추출
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

  // 칼로리가 안 읽혔지만 탄/단/지가 읽힌 경우 4-4-9 공식으로 자동 계산
  if (calories === null && (carbs !== null || protein !== null || fat !== null)) {
    calories = Math.round((carbs || 0) * 4 + (protein || 0) * 4 + (fat || 0) * 9);
  }

  const anyMacroFound = carbs !== null || protein !== null || fat !== null || sugar !== null;
  const anyNumberFound = calories !== null || anyMacroFound;

  // --------------------------------------------------------------------------
  // 4. 사진 속 텍스트에서 제품명 추출
  // --------------------------------------------------------------------------
  let foodName = (userMemo || '').trim();
  if (!foodName && lines.length > 0) {
    const ignoreLineRx = /영양정보|영양성분|내용량|탄수화물|단백질|포화지방|트랜스지방|콜레스테롤|나트륨|기준치|kcal|%|원재료|보관방법|소비기한|유통기한|비율/i;
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

  // OCR 인식 원문 요약 (사용자가 화면에서 뭐가 읽혔는지 확인할 수 있도록)
  const cleanPreview = (winText || tesseractText || '')
    .split(/[\r\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(' / ');

  return {
    anyNumberFound,
    calories,
    carbs,
    protein,
    fat,
    sugar,
    amount: amount || '1개(1인분)',
    foodName: foodName || '스캔한 식품 (이름 확인)',
    rawText: combinedText.trim(),
    ocrPreview: cleanPreview
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

async function analyzeImageOnLocalPC({ mode, text, imageBase64 }) {
  const cleanBase64 = (imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
  const imgBuffer = cleanBase64 ? Buffer.from(cleanBase64, 'base64') : null;

  let winOcrData = null;
  let tesseractText = '';

  if (imgBuffer) {
    // Windows 신경망 한국어 OCR(정방향+반전+확대)과 Tesseract(한/영)를 병렬 실행하여 인식률 극대화
    const [winRes, tessRes] = await Promise.all([
      runWindowsNativeOcr(imgBuffer),
      runTesseractOcr(imgBuffer)
    ]);
    winOcrData = winRes;
    tesseractText = tessRes;
  }

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
      engine: '사진 속 영양성분/칼로리 직접 추출 (듀얼 신경망 OCR)',
      mode: 'nutrition_label',
      ocr_preview: extracted.ocrPreview,
      summary: `✅ 사진에 적힌 수치(${detectedParts.join(' · ')})를 읽어서 적용했습니다!${extracted.ocrPreview ? `\n[읽힌 글자: ${extracted.ocrPreview}]` : ''}`,
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
          ai_note: `사진 표기 수치 (${detectedParts.join(', ')})`
        }
      ]
    };
  }

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
      ocr_preview: extracted.ocrPreview,
      summary: `사진에서 ${merged.length}개 메뉴 이름을 인식했습니다.${extracted.ocrPreview ? `\n[읽힌 글자: ${extracted.ocrPreview}]` : ''}`,
      is_multi_slot: false,
      slots: [],
      items: merged
    };
  }

  return {
    engine: '사진 직접 입력 모드 (글자 미감지)',
    mode,
    ocr_preview: extracted.ocrPreview,
    summary: `⚠️ 사진에서 칼로리/성분 숫자를 명확히 읽지 못했습니다.${extracted.ocrPreview ? ` (인식된 일부 글자: ${extracted.ocrPreview})` : ''} 글자가 잘 보이게 가까이서 다시 찍거나 아래 칸에 수치를 입력해 주세요.`,
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
        ai_note: '사진 첨부됨 (성분 수치를 입력해 주세요)'
      }
    ]
  };
}

module.exports = {
  analyzeImageOnLocalPC,
  extractNutritionFromOcrData
};
