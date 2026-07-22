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

/**
 * 주소와 용도지역을 바탕으로 해당 지자체 조례 상한 수치를 반환
 */
function getOrdinanceLimits(address, zoneName) {
  const defaultZone = getZone(zoneName);
  if (!defaultZone) return null;

  let cityKey = null;
  if (address) {
    if (address.includes('서울')) cityKey = '서울';
    else if (address.includes('울산')) cityKey = '울산';
    else if (address.includes('부산')) cityKey = '부산';
    else if (address.includes('경기')) cityKey = '경기';
    else if (address.includes('대구')) cityKey = '대구';
    else if (address.includes('인천')) cityKey = '인천';
    else if (address.includes('광주')) cityKey = '광주';
    else if (address.includes('대전')) cityKey = '대전';
  }

  if (cityKey && ORDINANCES[cityKey] && ORDINANCES[cityKey][zoneName]) {
    const ord = ORDINANCES[cityKey][zoneName];
    return {
      bcrMax: ord.bcrMax,
      farMax: ord.farMax,
      farBase: ord.farBase || Math.round(ord.farMax * 0.7),
      source: `${cityKey}시 조례`
    };
  }

  // 매칭되는 지자체가 없으면 기본 국계법 시행령 기준 적용
  return {
    bcrMax: defaultZone.bcrMax,
    farMax: defaultZone.farMax,
    farBase: defaultZone.farBase || Math.round(defaultZone.farMax * 0.7),
    source: '국계법 기준'
  };
}
