// 내장 한국인 다빈도 음식 영양성분 데이터베이스 (1인분 기준: kcal, 탄수화물g, 단백질g, 지방g, 당류g)
// Gemini API 키 미설정 시 스마트 폴백 분석 및 검색 자동완성에 활용됩니다.

const KOREAN_FOOD_DB = [
  // 밥류 / 주식
  { keywords: ['햇반', '오뚜기밥', '즉석밥', '공기밥', '쌀밥', '흰쌀밥', '밥', '백미밥'], name: '햇반/쌀밥(백미)', unit: '1공기(210g)', calories: 315, carbs: 70, protein: 6, fat: 1.0, sugar: 0 },
  { keywords: ['현미밥', '잡곡밥', '오곡밥', '흑미밥', '귀리밥', '현미햇반', '잡곡햇반'], name: '잡곡/현미밥', unit: '1공기(210g)', calories: 295, carbs: 63, protein: 7, fat: 1.5, sugar: 0 },
  { keywords: ['김밥', '야채김밥', '참치김밥', '김밥한줄'], name: '김밥', unit: '1줄(250g)', calories: 460, carbs: 72, protein: 14, fat: 12, sugar: 3 },
  { keywords: ['삼각김밥'], name: '삼각김밥', unit: '1개(110g)', calories: 195, carbs: 35, protein: 4.5, fat: 3.8, sugar: 1 },
  { keywords: ['비빔밥', '산채비빔밥', '돌솥비빔밥'], name: '비빔밥', unit: '1인분', calories: 580, carbs: 88, protein: 21, fat: 15, sugar: 8 },
  { keywords: ['볶음밥', '김치볶음밥', '새우볶음밥', '계란볶음밥'], name: '볶음밥', unit: '1인분', calories: 620, carbs: 85, protein: 18, fat: 22, sugar: 5 },
  { keywords: ['오므라이스'], name: '오므라이스', unit: '1인분', calories: 680, carbs: 92, protein: 22, fat: 24, sugar: 10 },
  { keywords: ['카레라이스', '카레밥', '카레'], name: '카레라이스', unit: '1인분', calories: 560, carbs: 86, protein: 16, fat: 16, sugar: 7 },
  { keywords: ['짜장밥'], name: '짜장밥', unit: '1인분', calories: 670, carbs: 98, protein: 20, fat: 21, sugar: 9 },
  { keywords: ['제육덮밥', '제육볶음밥'], name: '제육덮밥', unit: '1인분', calories: 720, carbs: 85, protein: 32, fat: 26, sugar: 14 },
  { keywords: ['오징어덮밥'], name: '오징어덮밥', unit: '1인분', calories: 590, carbs: 84, protein: 28, fat: 14, sugar: 11 },
  { keywords: ['규동', '소불고기덮밥', '불고기덮밥'], name: '소불고기덮밥', unit: '1인분', calories: 660, carbs: 82, protein: 30, fat: 22, sugar: 13 },
  { keywords: ['연어덮밥', '사케동'], name: '연어덮밥', unit: '1인분', calories: 610, carbs: 72, protein: 32, fat: 20, sugar: 6 },
  { keywords: ['포케', '연어포케', '닭가슴살포케'], name: '하와이안 포케 볼', unit: '1볼', calories: 480, carbs: 52, protein: 29, fat: 16, sugar: 6 },
  { keywords: ['죽', '야채죽', '전복죽', '소고기죽', '호박죽'], name: '영양죽', unit: '1그릇', calories: 320, carbs: 58, protein: 11, fat: 5, sugar: 4 },
  { keywords: ['국밥', '돼지국밥', '순대국밥', '순댓국', '소머리국밥', '설렁탕', '곰탕'], name: '국밥/탕류(밥 포함)', unit: '1인분', calories: 750, carbs: 72, protein: 38, fat: 32, sugar: 2 },
  { keywords: ['갈비탕'], name: '갈비탕', unit: '1인분', calories: 630, carbs: 15, protein: 42, fat: 42, sugar: 2 },
  { keywords: ['삼계탕', '반계탕'], name: '삼계탕', unit: '1인분', calories: 850, carbs: 45, protein: 68, fat: 44, sugar: 2 },
  { keywords: ['육개장'], name: '육개장', unit: '1인분', calories: 290, carbs: 14, protein: 24, fat: 15, sugar: 2 },
  { keywords: ['감자탕', '뼈해장국'], name: '뼈해장국/감자탕', unit: '1인분', calories: 640, carbs: 24, protein: 45, fat: 38, sugar: 3 },

  // 국 / 찌개류
  { keywords: ['김치찌개', '돼지고기김치찌개', '참치김치찌개'], name: '김치찌개', unit: '1인분', calories: 240, carbs: 12, protein: 18, fat: 14, sugar: 4 },
  { keywords: ['된장찌개', '차돌된장찌개'], name: '된장찌개', unit: '1인분', calories: 175, carbs: 14, protein: 13, fat: 7.5, sugar: 3 },
  { keywords: ['순두부찌개', '해물순두부'], name: '순두부찌개', unit: '1인분', calories: 230, carbs: 11, protein: 17, fat: 13, sugar: 2 },
  { keywords: ['부대찌개'], name: '부대찌개', unit: '1인분', calories: 420, carbs: 25, protein: 22, fat: 26, sugar: 5 },
  { keywords: ['청국장'], name: '청국장찌개', unit: '1인분', calories: 210, carbs: 14, protein: 18, fat: 9, sugar: 2 },
  { keywords: ['미역국', '소고기미역국'], name: '소고기미역국', unit: '1대접', calories: 135, carbs: 6, protein: 12, fat: 7, sugar: 1 },
  { keywords: ['콩나물국', '콩나물해장국'], name: '콩나물국', unit: '1대접', calories: 75, carbs: 7, protein: 6, fat: 2, sugar: 1 },
  { keywords: ['계란국', '달걀국', '떡만둣국', '만둣국', '떡국'], name: '떡만둣국/계란국', unit: '1인분', calories: 460, carbs: 68, protein: 19, fat: 12, sugar: 2 },
  { keywords: ['된장국', '시래기국', '배추된장국', '무국', '소고기무국'], name: '국(된장국/무국)', unit: '1대접', calories: 105, carbs: 9, protein: 8, fat: 4, sugar: 2 },

  // 메인 반찬 / 고기 / 생선 / 구내식당 단골 메뉴
  { keywords: ['제육볶음', '돼지주물럭', '두루치기'], name: '제육볶음', unit: '1인분(180g)', calories: 410, carbs: 16, protein: 28, fat: 26, sugar: 11 },
  { keywords: ['불고기', '소불고기', '뚝배기불고기'], name: '소불고기', unit: '1인분(180g)', calories: 360, carbs: 15, protein: 31, fat: 19, sugar: 12 },
  { keywords: ['돈까스', '등심돈까스', '치즈돈까스', '왕돈까스', '돈가스'], name: '돈까스', unit: '1인분', calories: 650, carbs: 48, protein: 32, fat: 36, sugar: 6 },
  { keywords: ['생선까스'], name: '생선까스', unit: '1인분', calories: 490, carbs: 42, protein: 22, fat: 26, sugar: 4 },
  { keywords: ['삼겹살', '구운삼겹살', '오겹살'], name: '삼겹살 구이', unit: '1인분(200g)', calories: 660, carbs: 1, protein: 34, fat: 56, sugar: 0 },
  { keywords: ['목살', '돼지목살'], name: '돼지목살 구이', unit: '1인분(200g)', calories: 480, carbs: 1, protein: 40, fat: 34, sugar: 0 },
  { keywords: ['소고기', '한우', '등심', '안심', '채끝살', '부채살', '스테이크'], name: '소고기 스테이크/구이', unit: '1인분(200g)', calories: 490, carbs: 2, protein: 46, fat: 32, sugar: 0 },
  { keywords: ['닭가슴살', '훈제닭가슴살', '수비드닭가슴살'], name: '닭가슴살', unit: '1팩(100g)', calories: 115, carbs: 1, protein: 24, fat: 1.5, sugar: 0.5 },
  { keywords: ['치킨', '후라이드치킨', '양념치킨', '간장치킨', '순살치킨'], name: '치킨', unit: '1/2마리(조각 4~5개)', calories: 790, carbs: 42, protein: 52, fat: 46, sugar: 12 },
  { keywords: ['찜닭', '안동찜닭', '닭볶음탕', '닭도리탕'], name: '닭볶음탕/찜닭', unit: '1인분', calories: 520, carbs: 32, protein: 42, fat: 24, sugar: 14 },
  { keywords: ['족발', '보쌈', '수육'], name: '보쌈/족발', unit: '1인분(200g)', calories: 560, carbs: 6, protein: 42, fat: 40, sugar: 4 },
  { keywords: ['고등어구이', '삼치구이', '갈치구이', '꽁치구이', '생선구이'], name: '생선구이(고등어/삼치)', unit: '1토막', calories: 260, carbs: 1, protein: 25, fat: 17, sugar: 0 },
  { keywords: ['고등어조림', '갈치조림', '코다리조림'], name: '생선조림', unit: '1인분', calories: 290, carbs: 12, protein: 26, fat: 15, sugar: 6 },
  { keywords: ['오징어볶음', '낙지볶음', '쭈꾸미볶음'], name: '오징어/쭈꾸미볶음', unit: '1인분', calories: 250, carbs: 18, protein: 26, fat: 7, sugar: 9 },
  { keywords: ['탕수육', '꿔바로우'], name: '탕수육', unit: '1인분(소)', calories: 540, carbs: 58, protein: 24, fat: 23, sugar: 18 },
  { keywords: ['떡갈비', '함박스테이크', '동그랑땡', '미트볼'], name: '떡갈비/함박스테이크', unit: '1인분', calories: 380, carbs: 18, protein: 22, fat: 24, sugar: 8 },
  { keywords: ['훈제오리', '오리불고기', '오리로스'], name: '훈제오리/오리구이', unit: '1인분(150g)', calories: 410, carbs: 3, protein: 27, fat: 32, sugar: 2 },

  // 계란 / 두부 / 일반 밑반찬
  { keywords: ['계란말이', '달걀말이'], name: '계란말이', unit: '1인분(4~5조각)', calories: 170, carbs: 3, protein: 13, fat: 12, sugar: 1 },
  { keywords: ['계란후라이', '달걀프라이', '계란프라이'], name: '계란후라이', unit: '1개', calories: 95, carbs: 0.6, protein: 6.5, fat: 7.2, sugar: 0 },
  { keywords: ['삶은계란', '삶은달걀', '구운란', '반숙란', '계란', '달걀'], name: '삶은 계란', unit: '1개(50g)', calories: 75, carbs: 0.6, protein: 6.3, fat: 5.0, sugar: 0 },
  { keywords: ['계란찜', '달걀찜'], name: '계란찜', unit: '1인분', calories: 145, carbs: 3, protein: 12, fat: 9.5, sugar: 1 },
  { keywords: ['두부조림', '두부구이', '두부김치', '모두부', '두부'], name: '두부요리(구이/조림)', unit: '1인분(120g)', calories: 160, carbs: 6, protein: 13, fat: 9.5, sugar: 2 },
  { keywords: ['배추김치', '김치', '깍두기', '열무김치', '총각김치', '겉절이'], name: '김치', unit: '1접시(50g)', calories: 20, carbs: 4, protein: 1, fat: 0.2, sugar: 1.5 },
  { keywords: ['멸치볶음', '진미채볶음', '어묵볶음', '오뎅볶음', '소시지야채볶음', '쏘야'], name: '볶음 밑반찬(어묵/멸치/소시지)', unit: '1인분', calories: 140, carbs: 11, protein: 8, fat: 7, sugar: 4 },
  { keywords: ['나물', '시금치나물', '콩나물무침', '숙주나물', '고사리나물', '무생채', '오이무침'], name: '나물/무침 반찬', unit: '1접시(70g)', calories: 55, carbs: 6, protein: 2.5, fat: 2.5, sugar: 1.5 },
  { keywords: ['잡채', '콩나물잡채'], name: '잡채', unit: '1인분', calories: 285, carbs: 42, protein: 7, fat: 10, sugar: 8 },

  // 면류 / 분식
  { keywords: ['라면', '신라면', '진라면', '짜파게티', '불닭볶음면', '컵라면'], name: '라면', unit: '1봉지/1개', calories: 505, carbs: 78, protein: 10, fat: 16, sugar: 4 },
  { keywords: ['짜장면', '간짜장'], name: '짜장면', unit: '1그릇', calories: 780, carbs: 118, protein: 22, fat: 24, sugar: 14 },
  { keywords: ['짬뽕', '해물짬뽕', '차돌짬뽕'], name: '짬뽕', unit: '1그릇', calories: 690, carbs: 94, protein: 30, fat: 21, sugar: 6 },
  { keywords: ['칼국수', '바지락칼국수', '해물칼국수', '수제비'], name: '칼국수/수제비', unit: '1그릇', calories: 540, carbs: 96, protein: 20, fat: 8, sugar: 3 },
  { keywords: ['냉면', '물냉면', '비빔냉면', '막국수', '쫄면'], name: '냉면/막국수', unit: '1그릇', calories: 530, carbs: 98, protein: 18, fat: 7, sugar: 12 },
  { keywords: ['우동', '어묵우동', '잔치국수', '비빔국수', '소바', '메밀소바'], name: '국수/우동/소바', unit: '1그릇', calories: 470, carbs: 86, protein: 15, fat: 6, sugar: 8 },
  { keywords: ['파스타', '토마토파스타', '알리오올리오', '봉골레', '스파게티'], name: '파스타', unit: '1인분', calories: 610, carbs: 82, protein: 22, fat: 21, sugar: 7 },
  { keywords: ['크림파스타', '까르보나라', '로제파스타'], name: '크림/로제 파스타', unit: '1인분', calories: 740, carbs: 80, protein: 24, fat: 36, sugar: 6 },
  { keywords: ['떡볶이', '국물떡볶이', '로제떡볶이', '라볶이'], name: '떡볶이', unit: '1인분', calories: 480, carbs: 88, protein: 12, fat: 9, sugar: 18 },
  { keywords: ['순대', '찰순대'], name: '순대', unit: '1인분(200g)', calories: 360, carbs: 52, protein: 14, fat: 10, sugar: 1 },
  { keywords: ['만두', '고기만두', '김치만두', '군만두', '찐만두'], name: '만두', unit: '1인분(6개)', calories: 380, carbs: 46, protein: 15, fat: 15, sugar: 3 },

  // 샐러드 / 다이어트식 / 빵 / 샌드위치
  { keywords: ['샐러드', '닭가슴살샐러드', '리코타치즈샐러드', '연어샐러드', '양상추샐러드', '그린샐러드'], name: '신선 샐러드', unit: '1볼', calories: 240, carbs: 16, protein: 18, fat: 12, sugar: 6 },
  { keywords: ['고구마', '군고구마', '찐고구마'], name: '고구마', unit: '1개(150g)', calories: 195, carbs: 45, protein: 2.5, fat: 0.3, sugar: 12 },
  { keywords: ['감자', '찐감자', '구운감자'], name: '감자', unit: '1개(150g)', calories: 115, carbs: 26, protein: 3, fat: 0.2, sugar: 1.5 },
  { keywords: ['오트밀', '오버나이트오트밀', '뮤즐리', '그래놀라', '시리얼'], name: '오트밀/시리얼', unit: '1회분(50g)', calories: 190, carbs: 34, protein: 6.5, fat: 3.5, sugar: 6 },
  { keywords: ['식빵', '토스트', '통밀식빵', '호밀빵'], name: '식빵/토스트', unit: '2쪽(80g)', calories: 210, carbs: 38, protein: 7, fat: 3.5, sugar: 4 },
  { keywords: ['베이글', '크림치즈베이글'], name: '베이글', unit: '1개', calories: 290, carbs: 56, protein: 10, fat: 2.5, sugar: 6 },
  { keywords: ['샌드위치', '에그샌드위치', '클럽샌드위치', '닭가슴살샌드위치', '서브웨이'], name: '샌드위치', unit: '1개', calories: 410, carbs: 44, protein: 22, fat: 16, sugar: 6 },
  { keywords: ['햄버거', '버거', '치즈버거', '불고기버거', '싸이버거', '빅맥'], name: '햄버거(단품)', unit: '1개', calories: 560, carbs: 48, protein: 26, fat: 29, sugar: 9 },
  { keywords: ['감자튀김', '프렌치프라이'], name: '감자튀김', unit: '1개(M)', calories: 330, carbs: 42, protein: 4, fat: 16, sugar: 0.5 },
  { keywords: ['피자', '페퍼로니피자', '불고기피자', '콤비네이션피자'], name: '피자', unit: '2조각', calories: 620, carbs: 66, protein: 26, fat: 28, sugar: 7 },

  // 과일 / 유제품 / 간식 / 음료
  { keywords: ['사과'], name: '사과', unit: '1개(200g)', calories: 114, carbs: 30, protein: 0.6, fat: 0.4, sugar: 21 },
  { keywords: ['바나나'], name: '바나나', unit: '1개(120g)', calories: 105, carbs: 27, protein: 1.3, fat: 0.4, sugar: 14 },
  { keywords: ['방울토마토', '토마토'], name: '방울토마토/토마토', unit: '1컵(150g)', calories: 28, carbs: 6, protein: 1.3, fat: 0.3, sugar: 4 },
  { keywords: ['귤', '오렌지', '한라봉', '천혜향'], name: '귤/감귤류', unit: '1개(100g)', calories: 42, carbs: 10.5, protein: 0.8, fat: 0.2, sugar: 8.5 },
  { keywords: ['딸기', '블루베리', '포도', '샤인머스캣', '수박', '참외', '복숭아', '배'], name: '제철 과일', unit: '1인분(150g)', calories: 75, carbs: 18, protein: 1, fat: 0.3, sugar: 14 },
  { keywords: ['견과류', '하루견과', '아몬드', '호두', '캐슈넛', '땅콩'], name: '하루견과/견과류', unit: '1봉(25g)', calories: 145, carbs: 5, protein: 5, fat: 12.5, sugar: 1.5 },
  { keywords: ['그릭요거트', '요거트', '플레인요거트', '떠먹는요거트'], name: '그릭/플레인 요거트', unit: '1컵(100g)', calories: 110, carbs: 6, protein: 10, fat: 5, sugar: 4 },
  { keywords: ['우유', '저지방우유', '두유', '아몬드브리즈'], name: '우유/두유', unit: '1팩(200ml)', calories: 125, carbs: 10, protein: 6.5, fat: 6.5, sugar: 8 },
  { keywords: ['단백질쉐이크', '프로틴', '프로틴쉐이크', '단백질보충제', '단백질음료', '셀렉스', '더단백'], name: '단백질 쉐이크/음료', unit: '1회분', calories: 140, carbs: 6, protein: 24, fat: 2, sugar: 2 },
  { keywords: ['아메리카노', '아아', '블랙커피', '에스프레소', '드립커피', '커피'], name: '아메리카노', unit: '1잔(355ml)', calories: 10, carbs: 2, protein: 0.5, fat: 0, sugar: 0 },
  { keywords: ['카페라떼', '라떼', '바닐라라떼', '카푸치노', '플랫화이트', '믹스커피'], name: '카페라떼/밀크커피', unit: '1잔(355ml)', calories: 180, carbs: 16, protein: 8, fat: 9, sugar: 14 },
  { keywords: ['제로콜라', '제로사이다', '탄산수', '제로음료'], name: '제로 탄산음료/탄산수', unit: '1캔(355ml)', calories: 0, carbs: 0, protein: 0, fat: 0, sugar: 0 },
  { keywords: ['콜라', '사이다', '환타', '탄산음료', '주스', '오렌지주스', '에이드'], name: '탄산음료/과일주스', unit: '1캔/1잔(355ml)', calories: 150, carbs: 38, protein: 0, fat: 0, sugar: 36 },
  { keywords: ['과자', '포카칩', '새우깡', '초코파이', '쿠키', '케이크', '빵', '크로와상', '도넛', '마카롱', '아이스크림', '초콜릿'], name: '디저트/간식류', unit: '1회분(70g)', calories: 280, carbs: 36, protein: 4, fat: 14, sugar: 18 },
  { keywords: ['하이네켄', '카스', '테라', '켈리', '아사히', '기네스', '클라우드', '생맥주', '캔맥주', '맥주'], name: '맥주', unit: '1캔(500ml)', calories: 210, carbs: 16, protein: 2, fat: 0, sugar: 0 },
  { keywords: ['소주', '참이슬', '처음처럼', '새로', '진로', '막걸리', '와인', '하이볼', '위스키'], name: '주류(소주/와인/하이볼)', unit: '1잔/1병(360ml)', calories: 400, carbs: 4, protein: 0, fat: 0, sugar: 1 }
];

/**
 * 텍스트 입력을 파싱하여 내장 DB 기반으로 칼로리 및 영양성분을 계산합니다.
 */
function estimateFromTextFallback(inputText) {
  const rawParts = String(inputText || '')
    .split(/[,/\n+·•]|그리고|이랑|하고|와\s|과\s/)
    .map(s => s.trim())
    .filter(Boolean);

  const items = [];
  for (const part of rawParts) {
    const cleanedName = part
      .replace(/(\d+(?:\.\d+)?)\s*(인분|공기|그릇|개|줄|잔|팩|봉|봉지|캔|컵|쪽|토막|조각|병|g|ml)/gi, '')
      .replace(/반\s*(공기|그릇|개|줄|인분|쪽)/g, '')
      .trim() || part;

    // 매칭 탐색 (가장 긴 키워드 우선 매칭)
    let matched = null;
    let bestKeywordLen = 0;
    const normalized = cleanedName.replace(/\s+/g, '');

    for (const entry of KOREAN_FOOD_DB) {
      for (const kw of entry.keywords) {
        if (normalized.includes(kw) && kw.length > bestKeywordLen) {
          matched = entry;
          bestKeywordLen = kw.length;
        }
      }
    }

    // 수량/배수 파싱 (해당 음식의 기본 g/ml 중량 대비 정확한 비율 계산)
    let multiplier = 1;
    let amountNote = '';
    if (/반\s*(공기|그릇|개|줄|인분|쪽)/.test(part) || /1\/2/.test(part)) {
      multiplier = 0.5;
      amountNote = '0.5인분(반)';
    } else if (/두\s*(공기|그릇|개|줄|인분|잔|쪽)/.test(part)) {
      multiplier = 2;
      amountNote = '2개/2인분';
    } else if (/세\s*(공기|그릇|개|줄|인분|잔|쪽)/.test(part)) {
      multiplier = 3;
      amountNote = '3개/3인분';
    } else {
      const numMatch = part.match(/(\d+(?:\.\d+)?)\s*(인분|공기|그릇|개|줄|잔|팩|봉|봉지|캔|컵|쪽|토막|조각|병|g|ml)/i);
      if (numMatch) {
        const val = parseFloat(numMatch[1]);
        const unit = numMatch[2].toLowerCase();
        if (unit === 'g') {
          const baseGMatch = matched?.unit?.match(/(\d+)\s*g/i);
          const baseG = baseGMatch ? parseFloat(baseGMatch[1]) : 150;
          multiplier = Math.max(0.1, Math.min(8, val / baseG));
          amountNote = `${val}g`;
        } else if (unit === 'ml') {
          const baseMlMatch = matched?.unit?.match(/(\d+)\s*ml/i);
          const baseMl = baseMlMatch ? parseFloat(baseMlMatch[1]) : 355;
          multiplier = Math.max(0.1, Math.min(8, val / baseMl));
          amountNote = `${val}ml`;
        } else if (unit === '조각') {
          multiplier = Math.max(0.25, Math.min(4, val / 3));
          amountNote = `${val}조각`;
        } else {
          multiplier = Math.max(0.2, Math.min(10, val));
          amountNote = `${val}${numMatch[2]}`;
        }
      }
    }

    if (matched) {
      const multRounded = Math.round(multiplier * 100) / 100;
      items.push({
        food_name: cleanedName.length <= 20 ? cleanedName : matched.name,
        amount: amountNote || matched.unit,
        calories: Math.round(matched.calories * multiplier),
        carbs: Math.round(matched.carbs * multiplier * 10) / 10,
        protein: Math.round(matched.protein * multiplier * 10) / 10,
        fat: Math.round(matched.fat * multiplier * 10) / 10,
        sugar: Math.round(matched.sugar * multiplier * 10) / 10,
        ai_note: `내장 영양DB 기준 (${matched.name} ${matched.unit} × ${multRounded})`
      });
    } else {
      // 미등록 일반 음식은 기본 균형 한식 단품으로 추정
      items.push({
        food_name: cleanedName,
        amount: amountNote || '1인분(추정)',
        calories: Math.round(280 * multiplier),
        carbs: Math.round(32 * multiplier * 10) / 10,
        protein: Math.round(14 * multiplier * 10) / 10,
        fat: Math.round(10 * multiplier * 10) / 10,
        sugar: Math.round(4 * multiplier * 10) / 10,
        ai_note: '일반 음식 평균치 추정 (Gemini API 키 연결 시 정밀 분석 가능)'
      });
    }
  }

  return items;
}

module.exports = {
  KOREAN_FOOD_DB,
  estimateFromTextFallback
};
