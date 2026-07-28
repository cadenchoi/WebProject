/**
 * zones.js
 * 국토의 계획 및 이용에 관한 법률 시행령 별표 기준
 * 전 용도지역별 법정 건폐율 및 용적률 데이터
 */

const ZONES = {
  // ── 주거지역 ────────────────────────────────────────
  '제1종전용주거지역': {
    category: '주거',
    bcrMax: 50,
    farBase: 50,
    farMax: 100,
    desc: '단독주택 중심의 양호한 주거환경 보호',
    residentialAllowed: true
  },
  '제2종전용주거지역': {
    category: '주거',
    bcrMax: 50,
    farBase: 100,
    farMax: 150,
    desc: '공동주택 중심의 양호한 주거환경 보호',
    residentialAllowed: true
  },
  '제1종일반주거지역': {
    category: '주거',
    bcrMax: 60,
    farBase: 100,
    farMax: 200,
    desc: '저층주택 중심의 편리한 주거환경 조성',
    residentialAllowed: true
  },
  '제2종일반주거지역': {
    category: '주거',
    bcrMax: 60,
    farBase: 150,
    farMax: 250,
    desc: '중층주택 중심의 편리한 주거환경 조성',
    residentialAllowed: true
  },
  '제3종일반주거지역': {
    category: '주거',
    bcrMax: 50,
    farBase: 200,
    farMax: 300,
    desc: '중·고층주택 중심의 편리한 주거환경 조성',
    residentialAllowed: true
  },
  '준주거지역': {
    category: '주거',
    bcrMax: 70,
    farBase: 200,
    farMax: 500,
    desc: '주거기능 위주로 이를 지원하는 상업·업무기능 보완',
    residentialAllowed: true
  },
  // ── 상업지역 ────────────────────────────────────────
  '중심상업지역': {
    category: '상업',
    bcrMax: 90,
    farBase: 400,
    farMax: 1500,
    desc: '도심·부도심의 상업·업무기능 담당',
    residentialAllowed: false
  },
  '일반상업지역': {
    category: '상업',
    bcrMax: 80,
    farBase: 300,
    farMax: 1300,
    desc: '일반적인 상업·업무기능 담당',
    residentialAllowed: false
  },
  '근린상업지역': {
    category: '상업',
    bcrMax: 70,
    farBase: 200,
    farMax: 900,
    desc: '근린지역의 일용품·서비스 공급',
    residentialAllowed: false
  },
  '유통상업지역': {
    category: '상업',
    bcrMax: 80,
    farBase: 200,
    farMax: 1100,
    desc: '도시 내·지역 간 유통기능 증진',
    residentialAllowed: false
  },
  // ── 공업지역 ────────────────────────────────────────
  '전용공업지역': {
    category: '공업',
    bcrMax: 70,
    farBase: 150,
    farMax: 300,
    desc: '중화학공업·공해성 공업 수용',
    residentialAllowed: false
  },
  '일반공업지역': {
    category: '공업',
    bcrMax: 70,
    farBase: 200,
    farMax: 350,
    desc: '환경을 저해하지 않는 공업 배치',
    residentialAllowed: false
  },
  '준공업지역': {
    category: '공업',
    bcrMax: 70,
    farBase: 200,
    farMax: 400,
    desc: '경공업 위주, 주거·상업·업무기능 보완',
    residentialAllowed: true
  },
  // ── 녹지지역 ────────────────────────────────────────
  '보전녹지지역': {
    category: '녹지',
    bcrMax: 20,
    farBase: 50,
    farMax: 80,
    desc: '도시의 자연환경·경관·산림·녹지공간 보전',
    residentialAllowed: false
  },
  '생산녹지지역': {
    category: '녹지',
    bcrMax: 20,
    farBase: 50,
    farMax: 100,
    desc: '농업적 생산을 위해 개발을 유보',
    residentialAllowed: false
  },
  '자연녹지지역': {
    category: '녹지',
    bcrMax: 20,
    farBase: 50,
    farMax: 100,
    desc: '도시의 녹지공간 확보·불가피한 경우 개발 허용',
    residentialAllowed: true
  }
};

/**
 * 용도지역 이름 목록을 카테고리별로 반환
 */
function getZonesByCategory() {
  const result = {};
  for (const [name, data] of Object.entries(ZONES)) {
    if (!result[data.category]) result[data.category] = [];
    result[data.category].push({ name, ...data });
  }
  return result;
}

/**
 * 특정 용도지역 정보 반환
 */
function getZone(name) {
  return ZONES[name] || null;
}

/**
 * 지자체별 조례 건폐율/용적률 데이터베이스
 */
const ORDINANCES = {
  '서울': {
    '제1종전용주거지역': { bcrMax: 50, farBase: 80, farMax: 100 },
    '제2종전용주거지역': { bcrMax: 40, farBase: 100, farMax: 120 },
    '제1종일반주거지역': { bcrMax: 60, farBase: 120, farMax: 150 },
    '제2종일반주거지역': { bcrMax: 60, farBase: 150, farMax: 200 },
    '제3종일반주거지역': { bcrMax: 50, farBase: 200, farMax: 250 },
    '준주거지역': { bcrMax: 60, farBase: 250, farMax: 400 },
    '중심상업지역': { bcrMax: 60, farBase: 600, farMax: 1000 },
    '일반상업지역': { bcrMax: 60, farBase: 500, farMax: 800 },
    '근린상업지역': { bcrMax: 60, farBase: 400, farMax: 600 },
    '유통상업지역': { bcrMax: 60, farBase: 400, farMax: 600 },
    '전용공업지역': { bcrMax: 60, farBase: 150, farMax: 200 },
    '일반공업지역': { bcrMax: 60, farBase: 150, farMax: 200 },
    '준공업지역': { bcrMax: 60, farBase: 200, farMax: 400 },
    '보전녹지지역': { bcrMax: 20, farBase: 50, farMax: 50 },
    '생산녹지지역': { bcrMax: 20, farBase: 50, farMax: 50 },
    '자연녹지지역': { bcrMax: 20, farBase: 50, farMax: 50 }
  },
  '울산': {
    '제1종전용주거지역': { bcrMax: 50, farBase: 60, farMax: 80 },
    '제2종전용주거지역': { bcrMax: 40, farBase: 80, farMax: 120 },
    '제1종일반주거지역': { bcrMax: 60, farBase: 100, farMax: 150 },
    '제2종일반주거지역': { bcrMax: 60, farBase: 150, farMax: 200 },
    '제3종일반주거지역': { bcrMax: 50, farBase: 200, farMax: 300 },
    '준주거지역': { bcrMax: 70, farBase: 350, farMax: 500 },
    '중심상업지역': { bcrMax: 80, farBase: 800, farMax: 1200 },
    '일반상업지역': { bcrMax: 80, farBase: 700, farMax: 1000 },
    '근린상업지역': { bcrMax: 70, farBase: 500, farMax: 700 },
    '유통상업지역': { bcrMax: 70, farBase: 500, farMax: 800 },
    '전용공업지역': { bcrMax: 70, farBase: 150, farMax: 250 },
    '일반공업지역': { bcrMax: 70, farBase: 200, farMax: 300 },
    '준공업지역': { bcrMax: 70, farBase: 200, farMax: 350 },
    '보전녹지지역': { bcrMax: 20, farBase: 50, farMax: 60 },
    '생산녹지지역': { bcrMax: 20, farBase: 50, farMax: 80 },
    '자연녹지지역': { bcrMax: 20, farBase: 50, farMax: 100 }
  },
  '부산': {
    '제1종전용주거지역': { bcrMax: 50, farBase: 80, farMax: 100 },
    '제2종전용주거지역': { bcrMax: 40, farBase: 100, farMax: 120 },
    '제1종일반주거지역': { bcrMax: 60, farBase: 120, farMax: 180 },
    '제2종일반주거지역': { bcrMax: 60, farBase: 150, farMax: 200 },
    '제3종일반주거지역': { bcrMax: 50, farBase: 200, farMax: 300 },
    '준주거지역': { bcrMax: 60, farBase: 300, farMax: 400 },
    '중심상업지역': { bcrMax: 80, farBase: 900, farMax: 1300 },
    '일반상업지역': { bcrMax: 60, farBase: 700, farMax: 1000 },
    '근린상업지역': { bcrMax: 60, farBase: 500, farMax: 700 },
    '유통상업지역': { bcrMax: 70, farBase: 700, farMax: 1000 },
    '전용공업지역': { bcrMax: 70, farBase: 150, farMax: 300 },
    '일반공업지역': { bcrMax: 70, farBase: 200, farMax: 350 },
    '준공업지역': { bcrMax: 70, farBase: 200, farMax: 400 },
    '보전녹지지역': { bcrMax: 20, farBase: 50, farMax: 60 },
    '생산녹지지역': { bcrMax: 20, farBase: 50, farMax: 80 },
    '자연녹지지역': { bcrMax: 20, farBase: 50, farMax: 80 }
  },
  '경기': {
    '제1종전용주거지역': { bcrMax: 50, farBase: 80, farMax: 100 },
    '제2종전용주거지역': { bcrMax: 40, farBase: 100, farMax: 150 },
    '제1종일반주거지역': { bcrMax: 60, farBase: 120, farMax: 180 },
    '제2종일반주거지역': { bcrMax: 60, farBase: 150, farMax: 230 },
    '제3종일반주거지역': { bcrMax: 50, farBase: 200, farMax: 280 },
    '준주거지역': { bcrMax: 70, farBase: 300, farMax: 400 },
    '중심상업지역': { bcrMax: 80, farBase: 800, farMax: 1200 },
    '일반상업지역': { bcrMax: 80, farBase: 600, farMax: 800 },
    '근린상업지역': { bcrMax: 70, farBase: 500, farMax: 700 },
    '유통상업지역': { bcrMax: 80, farBase: 600, farMax: 800 },
    '전용공업지역': { bcrMax: 70, farBase: 150, farMax: 300 },
    '일반공업지역': { bcrMax: 70, farBase: 200, farMax: 350 },
    '준공업지역': { bcrMax: 70, farBase: 200, farMax: 400 },
    '보전녹지지역': { bcrMax: 20, farBase: 50, farMax: 60 },
    '생산녹지지역': { bcrMax: 20, farBase: 50, farMax: 80 },
    '자연녹지지역': { bcrMax: 20, farBase: 50, farMax: 100 }
  },
  // 안산시 도시계획 조례([시행 2025.9.19.] 경기도안산시조례 제3019호) 제51조(건폐율)·
  // 제56조(용적률) 원문을 그대로 반영 — 경기도 일반 기준(위 '경기')과 다른 시 조례이므로
  // 별도 엔트리로 둔다(안산시 초지동 604-4 프로젝트 검토 중 확인: 앱이 안산시 대상지에도
  // '경기도 조례'로 표기하며 용적률도 실제(500%)보다 낮은 400%를 쓰고 있었음).
  // farBase는 안산시 조례 자체가 기준/상한을 구분하지 않고 단일 상한만 정하므로 farMax와
  // 동일하게 둔다(지구단위계획 등 개별 사업 인센티브로 달라지는 기준용적률은 이 표의
  // 범위 밖 — 프로젝트별로 조례 용적률 상한 입력란에 직접 덮어써야 한다).
  '안산': {
    '제1종전용주거지역': { bcrMax: 40, farBase: 100, farMax: 100 },
    '제2종전용주거지역': { bcrMax: 50, farBase: 150, farMax: 150 },
    '제1종일반주거지역': { bcrMax: 60, farBase: 200, farMax: 200 },
    '제2종일반주거지역': { bcrMax: 60, farBase: 250, farMax: 250 },
    '제3종일반주거지역': { bcrMax: 50, farBase: 300, farMax: 300 },
    '준주거지역': { bcrMax: 70, farBase: 500, farMax: 500 },
    '중심상업지역': { bcrMax: 70, farBase: 1100, farMax: 1100 },
    '일반상업지역': { bcrMax: 70, farBase: 1100, farMax: 1100 },
    '근린상업지역': { bcrMax: 70, farBase: 800, farMax: 800 },
    '유통상업지역': { bcrMax: 60, farBase: 1000, farMax: 1000 },
    '전용공업지역': { bcrMax: 70, farBase: 300, farMax: 300 },
    '일반공업지역': { bcrMax: 70, farBase: 350, farMax: 350 },
    '준공업지역': { bcrMax: 70, farBase: 400, farMax: 400 },
    '보전녹지지역': { bcrMax: 20, farBase: 50, farMax: 50 },
    '생산녹지지역': { bcrMax: 20, farBase: 80, farMax: 80 },
    '자연녹지지역': { bcrMax: 20, farBase: 80, farMax: 80 }
  },
  '대구': {
    '제1종전용주거지역': { bcrMax: 50, farBase: 80, farMax: 100 },
    '제2종전용주거지역': { bcrMax: 40, farBase: 100, farMax: 120 },
    '제1종일반주거지역': { bcrMax: 60, farBase: 120, farMax: 150 },
    '제2종일반주거지역': { bcrMax: 60, farBase: 150, farMax: 220 },
    '제3종일반주거지역': { bcrMax: 50, farBase: 200, farMax: 250 },
    '준주거지역': { bcrMax: 70, farBase: 300, farMax: 400 },
    '중심상업지역': { bcrMax: 70, farBase: 900, farMax: 1300 },
    '일반상업지역': { bcrMax: 70, farBase: 700, farMax: 1000 },
    '근린상업지역': { bcrMax: 70, farBase: 500, farMax: 700 },
    '유통상업지역': { bcrMax: 70, farBase: 500, farMax: 700 }
  },
  '인천': {
    '제1종전용주거지역': { bcrMax: 50, farBase: 80, farMax: 100 },
    '제2종전용주거지역': { bcrMax: 40, farBase: 100, farMax: 120 },
    '제1종일반주거지역': { bcrMax: 60, farBase: 120, farMax: 150 },
    '제2종일반주거지역': { bcrMax: 60, farBase: 150, farMax: 250 },
    '제3종일반주거지역': { bcrMax: 50, farBase: 200, farMax: 300 },
    '준주거지역': { bcrMax: 60, farBase: 300, farMax: 500 },
    '중심상업지역': { bcrMax: 80, farBase: 1000, farMax: 1300 },
    '일반상업지역': { bcrMax: 70, farBase: 700, farMax: 1000 },
    '근린상업지역': { bcrMax: 60, farBase: 500, farMax: 700 },
    '유통상업지역': { bcrMax: 70, farBase: 700, farMax: 1000 }
  },
  '광주': {
    '제1종전용주거지역': { bcrMax: 50, farBase: 80, farMax: 100 },
    '제2종전용주거지역': { bcrMax: 40, farBase: 100, farMax: 120 },
    '제1종일반주거지역': { bcrMax: 60, farBase: 120, farMax: 150 },
    '제2종일반주거지역': { bcrMax: 60, farBase: 150, farMax: 220 },
    '제3종일반주거지역': { bcrMax: 50, farBase: 200, farMax: 250 },
    '준주거지역': { bcrMax: 70, farBase: 300, farMax: 400 },
    '중심상업지역': { bcrMax: 80, farBase: 1000, farMax: 1400 },
    '일반상업지역': { bcrMax: 70, farBase: 800, farMax: 1100 },
    '근린상업지역': { bcrMax: 60, farBase: 500, farMax: 700 },
    '유통상업지역': { bcrMax: 70, farBase: 500, farMax: 700 }
  },
  '대전': {
    '제1종전용주거지역': { bcrMax: 50, farBase: 80, farMax: 100 },
    '제2종전용주거지역': { bcrMax: 40, farBase: 100, farMax: 120 },
    '제1종일반주거지역': { bcrMax: 60, farBase: 120, farMax: 150 },
    '제2종일반주거지역': { bcrMax: 60, farBase: 150, farMax: 200 },
    '제3종일반주거지역': { bcrMax: 50, farBase: 200, farMax: 250 },
    '준주거지역': { bcrMax: 60, farBase: 300, farMax: 400 },
    '중심상업지역': { bcrMax: 80, farBase: 900, farMax: 1300 },
    '일반상업지역': { bcrMax: 70, farBase: 700, farMax: 1000 },
    '근린상업지역': { bcrMax: 60, farBase: 500, farMax: 700 },
    '유통상업지역': { bcrMax: 70, farBase: 700, farMax: 1000 }
  }
};

// 법제처 국가법령정보센터(law.go.kr) 원문과 직접 대조해 확인한 지자체만 여기 넣는다 — 이
// 목록에 없는 도(경기) 단위 참고치는 실제로는 존재하지 않는 "도 조례"를 대변하는 셈이라
// (건폐율·용적률은 도가 아니라 각 시·군이 자체 조례로 정한다 — 안산시 조례 제51조·
// 제56조가 '경기' 일반치와 다름을 이번에 실측 확인함) source 문구에서 명확히 구분한다.
const VERIFIED_CITIES = new Set(['안산', '서울', '울산', '부산', '대구', '인천', '광주', '대전']);

/**
 * 주소와 용도지역을 바탕으로 해당 지자체 조례 상한 수치를 반환
 */
function getOrdinanceLimits(address, zoneName) {
  const defaultZone = getZone(zoneName);
  if (!defaultZone) return null;

  let cityKey = null;
  if (address) {
    // 경기도 산하 시/군은 각자 자체 조례를 두므로(예: 안산시 도시계획 조례가 '경기'
    // 일반 기준과 다름 — 준주거지역 용적률 400%(경기 일반) vs 500%(안산시 실제 조례)),
    // 도(道) 단위 '경기' 매칭보다 먼저 시/군 단위 매칭을 시도해야 한다. 다른 경기도
    // 시·군(수원·성남·화성 등)도 안산시와 마찬가지로 자체 조례가 있을 가능성이 높지만
    // 아직 원문 대조가 안 됐으므로, 여기 추가되기 전까지는 '경기' 참고치로만 폴백한다
    // (VERIFIED_CITIES에서 제외해 화면에 "확인 필요"로 표시됨 — buildOrdinanceSearchUrl로
    // 사용자가 직접 원문을 확인해 조례 입력란에 채우도록 안내한다).
    if (address.includes('서울')) cityKey = '서울';
    else if (address.includes('울산')) cityKey = '울산';
    else if (address.includes('부산')) cityKey = '부산';
    else if (address.includes('안산')) cityKey = '안산';
    else if (address.includes('경기')) cityKey = '경기';
    else if (address.includes('대구')) cityKey = '대구';
    else if (address.includes('인천')) cityKey = '인천';
    else if (address.includes('광주')) cityKey = '광주';
    else if (address.includes('대전')) cityKey = '대전';
  }

  if (cityKey && ORDINANCES[cityKey] && ORDINANCES[cityKey][zoneName]) {
    const ord = ORDINANCES[cityKey][zoneName];
    // 경기는 광역시/특별시가 아니라 도(道) — "경기시"가 아니라 "경기도"가 맞다
    const cityLabel = cityKey === '경기' ? '경기도' : `${cityKey}시`;
    const verified = VERIFIED_CITIES.has(cityKey);
    return {
      bcrMax: ord.bcrMax,
      farMax: ord.farMax,
      farBase: ord.farBase || Math.round(ord.farMax * 0.7),
      source: verified ? `${cityLabel} 조례` : `${cityLabel} 참고치(시·군 조례 확인 필요)`,
      verified
    };
  }

  // 매칭되는 지자체가 없으면 기본 국계법 시행령 기준 적용
  return {
    bcrMax: defaultZone.bcrMax,
    farMax: defaultZone.farMax,
    farBase: defaultZone.farBase || Math.round(defaultZone.farMax * 0.7),
    source: '국계법 기준(지자체 조례 미반영 — 확인 필요)',
    verified: false
  };
}

// 특별시/광역시/특별자치시는 그 자체가 조례 제정 주체이고, 그 외(도 산하 일반시·군)는
// "{도} {시/군}" 형태에서 뒤쪽 시/군 이름이 실제 조례 제정 주체다 — 자치법규 검색에 넘길
// 지자체명을 주소 문자열에서 대략 추출한다(완벽한 행정구역 파서가 아니라, 사용자가 law.go.kr
// 검색창에서 스스로 미세조정할 수 있는 "출발점" 제공이 목적이다).
function extractOrdinanceSearchCity(address) {
  if (!address) return null;
  const tokens = address.split(/\s+/).filter(Boolean);
  const metro = tokens.find(t => /(특별시|광역시|특별자치시|특별자치도)$/.test(t));
  if (metro) return metro;
  const cityOrCounty = tokens.find(t => /(시|군)$/.test(t) && !/도$/.test(t));
  return cityOrCounty || tokens[0] || null;
}

// law.go.kr 자치법규 검색 결과 페이지로 바로 연결되는 URL — "다른 지자체에서 작업할 때도
// 그 지자체 조례를 직접 확인할 수 있게 해달라"는 요청에 따라, 앱이 아직 원문 대조를 못한
// 시·군이라도 사용자가 한 번의 클릭으로 실제 조례를 찾아볼 수 있게 한다(이번 세션에
// 안산시 도시계획/건축/주차장 조례를 실제로 찾을 때 쓴 것과 같은 URL 패턴).
function buildOrdinanceSearchUrl(address, kind) {
  const city = extractOrdinanceSearchCity(address);
  if (!city) return null;
  const suffix = kind === 'building' ? ' 건축 조례' : kind === 'parking' ? ' 주차장 조례' : ' 도시계획 조례';
  const query = encodeURIComponent(city + suffix);
  return `https://www.law.go.kr/ordinSc.do?menuId=3&subMenuId=27&tabMenuId=139&query=${query}`;
}
