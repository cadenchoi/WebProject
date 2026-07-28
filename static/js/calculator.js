/**
 * calculator.js
 * 건축개요 자동 계산 엔진
 * 모든 면적·비율·법적 의무 산출 로직을 담당
 */

// 인동간격(동간 거리, 건축법 시행령 제86조③2호가목) 비율 — 채광사선(같은 조③1호, 대지경계선·
// 도로중심선 기준)과 달리 지역별 완화가 없다. 도시형 생활주택만 0.25배, 그 외(이 앱 대상인 일반
// 공동주택)는 준주거·근린상업이어도 항상 0.5배(사용자 법조문 확인, 2026-07-26).
const INTER_BUILDING_GAP_RATIO = 0.5;

// 정북일조(건축법 시행령 제86조①)가 적용되는 용도지역 — 전용주거·일반주거지역뿐이다. 그 외
// (준주거·상업·공업·녹지 등)는 이 조항 자체가 미적용이며, "완화"가 아니라 "정북 이격 자체가 없다".
const NORTH_SETBACK_APPLICABLE_ZONES = [
  '제1종전용주거지역', '제2종전용주거지역',
  '제1종일반주거지역', '제2종일반주거지역', '제3종일반주거지역'
];

/**
 * 숫자 파싱 (NaN 방지)
 */
function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

/**
 * 숫자 포맷 (소수점 자리수 지정, 천단위 콤마)
 */
function fmt(v, d = 2) {
  return num(v).toLocaleString('ko-KR', {
    minimumFractionDigits: d,
    maximumFractionDigits: d
  });
}

/**
 * ㎡ → 평 변환 텍스트
 */
function toPy(m2, d = 2) {
  const py = num(m2) * 0.3025;
  return `${py.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d })} 평`;
}

/* ═══════════════════════════════════════════════════
   폴리곤 기하 유틸 (개략 배치 시뮬레이션용, 위경도 → 미터 평면좌표)
   ═══════════════════════════════════════════════════ */

/** 위경도(도) 좌표를 기준위도 lat0의 등장방형 근사로 미터 평면좌표로 변환 */
function llToMeters([lon, lat], lat0) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  return [lon * mLon, lat * mLat];
}

/** GeoJSON Polygon/MultiPolygon의 외곽 링을 미터 좌표 점 배열로 변환 (첫 폴리곤만 사용) */
function geojsonToMeterRing(geojson, lat0) {
  if (!geojson) return null;
  let ring;
  if (geojson.type === 'Polygon') {
    ring = geojson.coordinates[0];
  } else if (geojson.type === 'MultiPolygon') {
    ring = geojson.coordinates[0][0];
  } else {
    return null;
  }
  const pts = ring.map(c => llToMeters(c, lat0));
  // 첫점=끝점 중복이면 제거
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) pts.pop();
  }
  return pts;
}

/**
 * Sutherland–Hodgman 단일 반평면 클리핑.
 * linePoint 지점을 지나고 normal이 가리키는 쪽(내적 >= 0)을 남긴다.
 */
function clipPolygonByHalfplane(poly, linePoint, normal) {
  if (!poly || poly.length < 3) return [];
  const dist = p => (p[0] - linePoint[0]) * normal[0] + (p[1] - linePoint[1]) * normal[1];
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const prev = poly[(i - 1 + n) % n];
    const dCur = dist(cur), dPrev = dist(prev);
    const curIn = dCur >= 0, prevIn = dPrev >= 0;
    if (curIn) {
      if (!prevIn) {
        const t = dPrev / (dPrev - dCur);
        out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
      }
      out.push(cur);
    } else if (prevIn) {
      const t = dPrev / (dPrev - dCur);
      out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
    }
  }
  return out;
}

/** 폴리곤 중심점(단순 정점 평균, 개략 클리핑 방향 판별용) */
function polygonCentroidApprox(poly) {
  const n = poly.length;
  const sx = poly.reduce((s, p) => s + p[0], 0);
  const sy = poly.reduce((s, p) => s + p[1], 0);
  return [sx / n, sy / n];
}

/**
 * 1층/2층/3층/기준층 층고(mm)를 받아 예상 층수만큼 합산한 총 예상높이(m)를 계산한다.
 * 미입력 층은 2900mm를 기본값으로 사용. 인동간격·채광사선·정북이격 산정의 "예상높이" 입력으로 쓰인다.
 */
function computeAssumedHeightM(floors, h1Mm, h2Mm, h3Mm, htypMm) {
  const toM = mm => (num(mm) > 0 ? num(mm) : 2900) / 1000;
  const H1 = toM(h1Mm), H2 = toM(h2Mm), H3 = toM(h3Mm), HT = toM(htypMm);
  const n = Math.max(1, Math.round(floors));
  let total = 0;
  for (let i = 1; i <= n; i++) {
    if (i === 1) total += H1;
    else if (i === 2) total += H2;
    else if (i === 3) total += H3;
    else total += HT;
  }
  return total;
}

/** 미터 평면좌표 → 위경도(도), llToMeters의 역변환 */
function metersToLL([x, y], lat0) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  return [x / mLon, y / mLat];
}

/**
 * 세대타입 목록(세대수 비율)에서 다음에 배치할 동에 배정할 타입을 가중 라운드로빈으로 고른다.
 * assignedCounts는 호출할 때마다 누적 갱신되는 배열(타입별 이미 배정된 동 수).
 */
function pickNextUnitType(unitTypeList, assignedCounts) {
  if (!unitTypeList || unitTypeList.length === 0) return { name: '유닛', supplyArea: 0 };
  const idx = peekNextUnitTypeIndex(unitTypeList, assignedCounts);
  assignedCounts[idx] = (assignedCounts[idx] || 0) + 1;
  return unitTypeList[idx];
}

/** pickNextUnitType과 동일한 가중 라운드로빈 선택이지만 assignedCounts를 바꾸지 않는다(사전 조회용). */
function peekNextUnitTypeIndex(unitTypeList, assignedCounts) {
  const total = unitTypeList.reduce((s, t) => s + t.count, 0) || 1;
  let bestIdx = 0, bestScore = Infinity;
  unitTypeList.forEach((t, idx) => {
    const ratio = t.count / total;
    const score = ratio > 0 ? assignedCounts[idx] / ratio : Infinity;
    if (score < bestScore) { bestScore = score; bestIdx = idx; }
  });
  return bestIdx;
}

/** pickNextUnitType과 동일하지만 상태를 바꾸지 않고 "다음에 배정될 타입"만 미리 확인한다(폭 계산용). */
function peekNextUnitType(unitTypeList, assignedCounts) {
  if (!unitTypeList || unitTypeList.length === 0) return { name: '유닛', supplyArea: 0 };
  return unitTypeList[peekNextUnitTypeIndex(unitTypeList, assignedCounts)];
}

/**
 * 세대타입별로 "공급면적 비례 세대 폭"을 계산해 붙인다. 표준 세대 폭(baseUnitWidth)은
 * 전체 세대의 평균 공급면적 기준으로 이미 스케일된 값이므로, 각 타입은 자신의 공급면적이
 * 평균보다 크면 더 넓게, 작으면 더 좁게 비례 배정한다 — 84타입과 59타입이 섞인 동에서
 * 실제 크기 차이가 시각적으로 드러나도록 한다(이전에는 모든 타입이 동일한 표준폭이었음).
 */
function attachPerTypeUnitWidths(unitTypeList, baseUnitWidth) {
  if (!unitTypeList || unitTypeList.length === 0) return unitTypeList;
  const totalCount = unitTypeList.reduce((s, t) => s + t.count, 0) || 1;
  const avgSupplyArea = unitTypeList.reduce((s, t) => s + t.count * t.supplyArea, 0) / totalCount;
  return unitTypeList.map(t => ({
    ...t,
    unitWidth: avgSupplyArea > 0 ? baseUnitWidth * (t.supplyArea / avgSupplyArea) : baseUnitWidth
  }));
}

/**
 * 표준 ray-casting 점-폴리곤 포함 판정(로컬 미터 좌표 기준).
 * estimateComboLayout에서 후보 조합의 유닛 꼭짓점들이 건축가능영역 내부에 있는지 확인하는 데 쓴다.
 */
function pointInPolygon([px, py], poly) {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/* ═══════════════════════════════════════════════════
   9종 주동 조합 카탈로그(2호~6호, massing.py의 UNIT_COMBO_BUILDERS와 동일 정의) —
   정사각형에 가까운 "유닛" 블록이 사슬처럼 이어지며(직선 연장, 직각 꺾임) 필요하면 45도
   회전된 마름모꼴 코너 유닛이 붙는 형태다. 개략 검토(이 파일)와 정밀 최적화(massing.py) 모두
   이 카탈로그만 배치 후보로 쓴다 — 판상형/L자형/타워형 같은 자유 형상은 쓰지 않는다.
   ═══════════════════════════════════════════════════ */

function rectUnit(cx, cy, sx, sy) {
  return { cx, cy, sx, sy, diamond: false, hhPerFloor: 1 };
}

function diamondUnit(cx, cy, s) {
  // 참조 이미지를 가로 스캔선으로 정밀 측정한 결과, 마름모는 인접 유닛 모서리에서 대각선
  // 오프셋을 주는 게 아니라 세로줄기(타워/스택)의 바깥쪽 x좌표와 기준 행(맨 아래 유닛들)의
  // 바닥 y좌표가 만나는 점에 중심이 그대로 온다(massing.py _diamond_unit 참고). 마름모
  // 내부에 대각선이 그어져 있는 것은 마름모 하나가 유닛 2개 몫임을 나타낸다 — s는 호출부에서
  // sqrt(2*uw*bd)로 넘겨받는다(massing.py와 동일).
  return { cx, cy, s, diamond: true, hhPerFloor: 2 };
}

// 아래 9개 조합의 유닛 위치는 참조 이미지를 픽셀 단위로 정밀 측정해 역산한 좌표다(massing.py의
// 동일 카탈로그와 정확히 같은 값 — 두 엔진이 같은 모양을 그려야 한다). 유닛이 이어지는 방식은
// "완전히 겹치는 변 공유"가 아니라 "모서리 한 점에서 다음 유닛이 직각(또는 마름모는 45도)으로
// 꺾여 붙는" 사슬 구조이며, 어느 모서리에서 어느 방향으로 꺾이는지는 조합마다 다르다.
const UNIT_COMBO_BUILDERS = {
  '2호': (uw, bd) => [rectUnit(uw * 0.5, bd * 0.5, uw, bd), rectUnit(uw * 1.5, bd * 0.5, uw, bd)],
  '3호': (uw, bd) => [
    rectUnit(uw * 0.5, bd * 0.5, uw, bd),
    rectUnit(uw * 1.5, bd * 0.5, uw, bd),
    rectUnit(uw - bd * 0.5, bd + uw * 0.5, bd, uw)
  ],
  '4호-a': (uw, bd) => [
    rectUnit(uw * 0.5, bd * 0.5, uw, bd),
    rectUnit(uw * 1.5, bd * 0.5, uw, bd),
    rectUnit(uw * 2.5, bd * 0.5, uw, bd),
    rectUnit(uw - bd * 0.5, bd + uw * 0.5, bd, uw)
  ],
  '4호-b': (uw, bd) => {
    const s = Math.sqrt(2 * uw * bd);
    return [
      rectUnit(uw * 0.5, bd * 0.5, uw, bd),
      rectUnit(uw + bd * 0.5, bd + uw * 0.5, bd, uw),
      diamondUnit(uw + bd, 0, s)
    ];
  },
  '4호-c': (uw, bd) => [0, 1, 2, 3].map(i => rectUnit(uw * (i + 0.5), bd * 0.5, uw, bd)),
  '4호-d': (uw, bd) => [
    rectUnit(uw * 0.5, bd * 0.5, uw, bd),
    rectUnit(uw * 1.5, bd * 0.5, uw, bd),
    rectUnit(uw * 2.0 + bd * 0.5, bd + uw * 0.5, bd, uw),
    rectUnit(uw * 2.0 + bd * 0.5, bd + uw * 1.5, bd, uw)
  ],
  '5호-a': (uw, bd) => [
    rectUnit(uw * 0.5, bd * 0.5, uw, bd),
    rectUnit(uw * 1.5, bd * 0.5, uw, bd),
    rectUnit(uw + bd * 0.5, bd + uw * 0.5, bd, uw),
    rectUnit(uw + bd * 0.5, bd + uw * 1.5, bd, uw),
    rectUnit(uw + bd * 0.5, bd + uw * 2.5, bd, uw)
  ],
  '5호-b': (uw, bd) => {
    const s = Math.sqrt(2 * uw * bd);
    return [
      rectUnit(uw * 0.5, bd * 0.5, uw, bd),
      rectUnit(uw + bd * 0.5, bd + uw * 0.5, bd, uw),
      rectUnit(uw + bd * 0.5, bd + uw * 1.5, bd, uw),
      diamondUnit(uw + bd, 0, s)
    ];
  },
  '6호': (uw, bd) => {
    const s = Math.sqrt(2 * uw * bd);
    return [
      rectUnit(uw * 0.5, bd * 0.5, uw, bd),
      rectUnit(uw * 1.5, bd * 0.5, uw, bd),
      rectUnit(uw * 2.0 + bd * 0.5, bd + uw * 0.5, bd, uw),
      rectUnit(uw * 2.0 + bd * 0.5, bd + uw * 1.5, bd, uw),
      diamondUnit(uw * 2.0 + bd, 0, s)
    ];
  }
};
const UNIT_COMBO_KEYS = Object.keys(UNIT_COMBO_BUILDERS);
// 요구된 9종 표기 그대로 — massing.py UNIT_COMBO_DISPLAY_NAMES와 동일해야 정밀 최적화 결과와 표기가 어긋나지 않는다.
const UNIT_COMBO_DISPLAY_NAMES = {
  '2호': '2호(판상형)', '3호': '3호(타워형)',
  '4호-a': '4호(L형)', '4호-b': '4호(타워형)', '4호-c': '4호(판상형)', '4호-d': '4호(ㄱ형)',
  '5호-a': '5호(L형)', '5호-b': '5호(타워형)',
  '6호': '6호(타워형)'
};

/** comboKey 조합의 로컬 유닛 배치를 uw/bd로 스케일하고, 조합 중심을 (cx,cy)로 옮기며
 * baseRotationDeg만큼 회전한다(massing.py build_combo_units와 동일 로직). 유닛별 world 꼭짓점을 반환. */
function buildComboUnits(comboKey, cx, cy, baseRotationDeg, uw, bd) {
  const localUnits = UNIT_COMBO_BUILDERS[comboKey](uw, bd);
  const ox = localUnits.reduce((s, u) => s + u.cx, 0) / localUnits.length;
  const oy = localUnits.reduce((s, u) => s + u.cy, 0) / localUnits.length;
  const rad = baseRotationDeg * Math.PI / 180;
  const cosA = Math.cos(rad), sinA = Math.sin(rad);
  const rot = (x, y) => [x * cosA - y * sinA, x * sinA + y * cosA];
  return localUnits.map(u => {
    const [rcx, rcy] = rot(u.cx - ox, u.cy - oy);
    const wcx = rcx + cx, wcy = rcy + cy;
    let corners;
    if (u.diamond) {
      const r = u.s / Math.SQRT2;
      corners = [0, 90, 180, 270].map(a => {
        const ang = a * Math.PI / 180 + rad;
        return [wcx + Math.cos(ang) * r, wcy + Math.sin(ang) * r];
      });
    } else {
      const hx = u.sx / 2, hy = u.sy / 2;
      corners = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([lcx, lcy]) => {
        const [dcx, dcy] = rot(lcx, lcy);
        return [wcx + dcx, wcy + dcy];
      });
    }
    return { corners, center: [wcx, wcy], hhPerFloor: u.hhPerFloor };
  });
}

/**
 * 주어진 적층방향(stackDir)·폭방향(widthDir)으로, allowedComboKeys(화면에서 도형을 보고
 * 다중선택한 조합 목록)만 후보로 삼아 행(row) 단위로 그리디하게 채워나간다(GA 없이 한
 * 번에 배치하는 빠른 근사). 행 안에서는 커서를 왼쪽부터 오른쪽으로 옮기며, allowedComboKeys
 * 안에서만 순서대로 시도해 그 커서 위치에 실제로 들어가는 조합을 채택한다 — 예전에는
 * primaryComboKey 하나를 먼저 시도하고 안 맞으면 선택 여부와 무관하게 나머지 8종까지
 * 전부 시도하는 "소프트 폴백"이었지만, 이제는 사용자가 고르지 않은 조합은 아예 후보에서
 * 빠지는 하드 제한이다(massing.py의 GA도 동일하게 allowedComboKeys로 제한된다 —
 * "선택한 조합들로 실제 배치를 만들어낸다"는 요구사항). 커서는 채택된 조합의 실측 폭만큼만
 * 전진하고(고정 격자 칸이 아니다), 다음 행은 이번 행에서 실제로 배치된 동들 중 가장
 * 깊이 뻗은 지점을 기준으로 시작한다.
 *
 * 이전 버전은 9종 중 가장 넓게 퍼지는 조합(주로 6호) 기준의 "고정 격자 칸"을 만들어 그 안에
 * 아무 조합이나 끼워 넣는 방식이었다 — 어떤 조합을 골라도 옆 칸과 겹치지 않는다는 안전은
 * 확보되지만, 여러 조합이 섞이는 경우에도 칸 크기 자체가 가장 큰 조합 기준으로 고정돼 있어
 * 같은 대지에 훨씬 적은 동수만 들어가는 것으로 계산됐다(실측: 150×100m 대지에서 실제로는
 * 20개 동이 들어가는데 4개 동으로 과소 산정 — 그 결과 목표 세대수를 채우기 위한 "필요층수"가
 * 5배 가까이 부풀려졌다). massing.py/universal_site_layout.py에서 이미 검증한 "실제 배치된
 * 크기만큼만 커서를 전진시키는" 그리디 패킹 방식으로 바꿔 이 낭비를 없앴다.
 */
function estimateComboLayout(poly, lat0, stackDir, widthDir, { bldgDepth, buildingGap, unitWidth, unitTypeList, allowedComboKeys, maxFootprintM2 }) {
  const origin = polygonCentroidApprox(poly);
  const toLocal = p => [
    (p[0] - origin[0]) * widthDir[0] + (p[1] - origin[1]) * widthDir[1],
    (p[0] - origin[0]) * stackDir[0] + (p[1] - origin[1]) * stackDir[1]
  ];
  const toWorld = (lx, ly) => [
    origin[0] + lx * widthDir[0] + ly * stackDir[0],
    origin[1] + lx * widthDir[1] + ly * stackDir[1]
  ];

  const localPoly = poly.map(toLocal);
  const xs = localPoly.map(p => p[0]), ys = localPoly.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const types = (unitTypeList && unitTypeList.length > 0) ? unitTypeList : [{ name: '유닛', supplyArea: 0, count: 1 }];
  const assignedCounts = types.map(() => 0);
  // allowedComboKeys가 이 커서 위치에서 실제로 시도할 조합의 전부다(하드 제한) — 사용자가
  // 고르지 않은 조합은 그 자리에 다른 후보가 하나도 안 맞아도 대신 채택되지 않는다.
  const filteredAllowed = (allowedComboKeys || []).filter(k => UNIT_COMBO_KEYS.includes(k));
  const tryOrder = filteredAllowed.length > 0 ? filteredAllowed : UNIT_COMBO_KEYS;

  // 채광창은 각 유닛의 긴 변(전면, 대지 전체가 공유하는 한 방향)에만 있다 — 다음 행(stackDir
  // 방향, 전면끼리 마주볼 수 있음)은 높이 비례 인동간격(buildingGap)을, 같은 행 안 동끼리
  // (widthDir 방향, 측벽이 나란함, 창 없음)는 최소 이격만 두면 된다.
  const IN_ROW_GAP = 6;
  // 후보가 하나도 안 맞을 때 커서를 얼마나 전진시킬지(고정 격자 칸 대신 세대폭 비례 소단위로
  // 스캔) — 너무 크면 좁은 틈을 건너뛰고, 너무 작으면 느려지므로 세대폭의 절반 정도로 잡는다.
  const minTypeWidth = Math.max(4, unitWidth * 0.5);
  const GRID_SCAN_STEP = Math.max(3, unitWidth * 0.5);

  const rows = [];
  let cy = minY;
  let guardRow = 0;
  let consecutiveEmptyRows = 0;
  let footprintSoFar = 0; // 지금까지 배치한 동들의 실제 바닥면적 누계 — 건폐율 상한 체크용
  while (cy + bldgDepth <= maxY && guardRow < 200) {
    guardRow++;
    let cx = minX;
    let guardCol = 0;
    let rowFarEdge = cy; // 이 행에서 실제 배치된 동들 중 stackDir(+) 방향으로 가장 멀리 뻗은 지점
    let anyPlacedThisRow = false;

    while (cx + minTypeWidth <= maxX && guardCol < 150) {
      guardCol++;
      const candidateType = peekNextUnitType(types, assignedCounts);
      const typeWidth = candidateType.unitWidth || unitWidth;

      let found = null;
      comboSearch:
      for (const comboKey of tryOrder) {
        // 90/270은 넣지 않는다 — 카탈로그 로컬 유닛은 +X축으로 이어붙는 형태(장변이 로컬 X와
        // 나란)라, 0/180(로컬 X를 그대로 두거나 반전만 함)에서는 장변이 widthDir(같은 행)에
        // 나란하고 채광창은 stackDir(행-행) 축을 보지만, 90/270으로 돌리면 장변이 stackDir에
        // 나란해져 버려 채광창이 오히려 좁은 이격 축을 보게 된다 — massing.py build_combo_units
        // 에서 발견된 것과 같은 문제(그쪽은 +90 보정으로 해결). 여기서는 애초에 그 축이 뒤집히는
        // 회전 후보 자체를 배제한다.
        for (const rotDeg of [0, 180]) {
          // 조합을 원점(0,0) 기준으로 먼저 그려 로컬 바운딩박스를 잰 뒤, 그 바운딩박스의 왼쪽
          // 끝이 현재 커서(cx,cy)에 오도록 중심좌표를 역산한다 — 격자 칸 중심이 아니라 실제
          // 조합 크기만큼만 커서를 전진시키기 위해 필요하다.
          const probe = buildComboUnits(comboKey, 0, 0, rotDeg, typeWidth, bldgDepth);
          const pxs = probe.flatMap(u => u.corners.map(c => c[0]));
          const pys = probe.flatMap(u => u.corners.map(c => c[1]));
          const localMinX = Math.min(...pxs), localMaxX = Math.max(...pxs);
          const localMinY = Math.min(...pys), localMaxY = Math.max(...pys);
          const centerX = cx - localMinX;
          const centerY = cy - localMinY;
          const units = buildComboUnits(comboKey, centerX, centerY, rotDeg, typeWidth, bldgDepth);
          if (units.every(u => u.corners.every(c => pointInPolygon(c, localPoly)))) {
            const hhTotalCandidate = units.reduce((s, u) => s + u.hhPerFloor, 0);
            const footprintCandidate = hhTotalCandidate * typeWidth * bldgDepth;
            // 건폐율 상한 체크 — 기하학적으로는 맞아도 이미 배치한 동들과 합쳐 법정 건폐율을
            // 넘기면 이 후보는 건너뛰고 tryOrder의 다음(대개 더 작은) 조합을 대신 시도한다.
            // 이 체크가 없으면 대지 전체를 기하학적 한계까지 채워버려(massing.py의 GA는
            // evaluate_genome에서 이미 bcr>legalBcrMax를 거부하지만 이쪽엔 그 대응이 없었다)
            // 필요층수가 실제보다 훨씬 낮게(비현실적으로) 산정된다.
            if (maxFootprintM2 > 0 && footprintSoFar + footprintCandidate > maxFootprintM2 + 0.5) continue;
            found = {
              comboKey, units, spanX: localMaxX - localMinX, farEdgeY: cy + (localMaxY - localMinY),
              hhTotal: hhTotalCandidate, footprintM2: footprintCandidate
            };
            break comboSearch;
          }
        }
      }
      if (!found) { cx += GRID_SCAN_STEP; continue; }

      const unitType = pickNextUnitType(types, assignedCounts); // 위에서 미리 본 타입과 동일(상태 불변 구간)
      const comboLabel = UNIT_COMBO_DISPLAY_NAMES[found.comboKey];
      const segments = found.units.map(u => ({
        type: 'unit',
        pathLL: u.corners.map(([lx, ly]) => metersToLL(toWorld(lx, ly), lat0))
      }));
      const areaPy = unitType.supplyArea > 0 ? Math.round(unitType.supplyArea * 0.3025) : null;
      const xsAll = found.units.flatMap(u => u.corners.map(c => c[0]));
      const ysAll = found.units.flatMap(u => u.corners.map(c => c[1]));
      const bboxMinX = Math.min(...xsAll), bboxMaxX = Math.max(...xsAll);
      const bboxMinY = Math.min(...ysAll), bboxMaxY = Math.max(...ysAll);
      // 라벨은 유닛 타입과 층수만 표시한다(조합 표기는 상단 요약의 "호수:" 목록에 이미 나옴) —
      // 층수는 이 시점엔 아직 모르므로(요구 세대수를 채울 때까지 필요층수를 바깥에서 반복 탐색)
      // stampFloorCountOnLabels(main.js)가 나중에 " · N층"을 붙인다.
      const buildingLabels = [{
        text: areaPy ? `${unitType.name} ${areaPy}평` : unitType.name,
        positionLL: metersToLL(toWorld((bboxMinX + bboxMaxX) / 2, (bboxMinY + bboxMaxY) / 2), lat0)
      }];
      const outlineLocal = [[bboxMinX, bboxMinY], [bboxMaxX, bboxMinY], [bboxMaxX, bboxMaxY], [bboxMinX, bboxMaxY]];
      // 호수 표기용 총 세대수 — 기하학적 유닛 개수(found.units.length)가 아니라 hhPerFloor 합이다
      // (마름모 유닛 하나가 층당 2세대이므로, 예: 4호-b는 유닛 3개뿐이지만 세대는 4호).
      // comboSearch에서 이미 계산해둔 값을 그대로 쓴다(건폐율 누계와 같은 기준이어야 하므로).
      const hhTotal = found.hhTotal;
      footprintSoFar += found.footprintM2;

      rows.push({
        width: Math.round((bboxMaxX - bboxMinX) * 10) / 10,
        combo: comboLabel,
        buildingCount: 1,
        unitsThisRow: hhTotal,
        segments,
        buildingLabels,
        pathLL: outlineLocal.map(([lx, ly]) => metersToLL(toWorld(lx, ly), lat0)),
        // 유닛 1세대분당 면적 근사(정사각 유닛·마름모 유닛 모두 uw×bd와 거의 같은 면적) × 세대수
        footprintAreaM2: found.footprintM2
      });

      anyPlacedThisRow = true;
      rowFarEdge = Math.max(rowFarEdge, found.farEdgeY);
      cx += found.spanX + IN_ROW_GAP;
    }

    if (anyPlacedThisRow) {
      consecutiveEmptyRows = 0;
      cy = rowFarEdge + buildingGap;
    } else {
      // 이 행에 아무것도 못 넣었으면(대지 폭이 좁아지는 구간 등) 큰 폭으로 다음 행을 시도해보고,
      // 그마저 연속으로 3번 실패하면 더 북쪽은 가망이 없다고 보고 그만둔다(무한 루프 방지).
      consecutiveEmptyRows++;
      cy += Math.max(bldgDepth * 2, 10);
      if (consecutiveEmptyRows >= 3) break;
    }
  }

  const totalUnitsPerFloorAllRows = rows.reduce((s, r) => s + r.unitsThisRow, 0);
  const footprintAreaM2 = rows.reduce((s, r) => s + (r.footprintAreaM2 || 0), 0);
  return { rows, totalUnitsPerFloorAllRows, footprintAreaM2 };
}

/**
 * 건축가능영역 폴리곤(1차, 도로·인접대지 이격 적용됨) 위에
 * ① 정북변 높이비례 추가 클리핑(정북일조 면제 변은 건너뜀) →
 * ② 정면방향 후보 결정(가장 긴 도로변에 평행 vs 그 수직방향, 도로가 없으면 정남향 vs 정동서향) →
 *    두 후보 모두 실제로 배치해보고 층당 세대수가 더 많이(=필요층수가 더 적게) 나오는 쪽을 채택
 *    ("장변 배치가 항상 유리한 건 아니다" — 폭이 매우 넓은 대지는 단변 배치가 더 효율적일 수 있음) →
 * ③ 9종 조합 카탈로그(estimateComboLayout)로 격자 앵커점을 채운다 — comboMode로 특정 조합을
 *    골랐으면 그 조합 위주로, 'auto'면 9종을 자유롭게 섞는다.
 * 순서로 층당 배치 가능 세대수와 필요 층수를 근사 산정한다.
 * 실제 3D 매싱이 아닌 개략 근사치(정밀 최적화는 massing.py의 유전 알고리즘이 담당).
 */
function estimatePolygonLayout({
  buildableEnvelope, envelopeEdges, totalHouseholds,
  assumedHeight, northSetbackRatio, buildingGapRatio,
  standardBuildingDepth, standardUnitWidth, comboModes,
  unitTypeList, landArea, legalBcrMax, applyNorthSetback
}) {
  if (!buildableEnvelope) return null;

  let ring;
  if (buildableEnvelope.type === 'Polygon') ring = buildableEnvelope.coordinates[0];
  else if (buildableEnvelope.type === 'MultiPolygon') ring = buildableEnvelope.coordinates[0][0];
  else return null;
  if (!ring || ring.length < 3) return null;

  const lat0 = ring.reduce((s, c) => s + c[1], 0) / ring.length;
  let poly = geojsonToMeterRing(buildableEnvelope, lat0);
  if (!poly || poly.length < 3) return null;

  // ── ① 높이비례 채광이격을 모든 변(정북·그 외 인접대지경계선·도로변)에 적용 ──
  // massing.py의 clip_daylight_setback_edges와 동일 로직 — 공동주택은 인접대지에 붙은 변은
  // 인접대지경계선에서, 도로에 붙은 변은 도로중심선에서, 정북변은 정북에서 각각 높이비례
  // 채광사선 이격을 적용해야 한다(정북만이 아니다 — 이전에는 이 블록이 정북변만 재클리핑해서
  // 동/서/남측·도로변은 건물이 아무리 높아져도 이격이 늘지 않았다; massing.py의 GA는 이미
  // 같은 문제를 겪고 고쳤으나 이 개략추정 쪽에는 이식되지 않아 GA와 결과가 어긋났었다).
  const buildingGapRatioNum = num(buildingGapRatio || 0.5);
  // 보고용 값 — applyNorthSetback===false(준주거 등 정북일조 미적용 지역)면 실제로 적용되는
  // 정북 이격이 없으므로 0으로 보고한다(아래 클리핑 루프도 같은 조건으로 건너뛴다).
  const northSetback = applyNorthSetback === false ? 0 : Math.max(1.5, assumedHeight * num(northSetbackRatio || 0.5));
  const setbackCentroid = polygonCentroidApprox(poly); // 원본 폴리곤 기준 1회만 산정(클리핑 도중 바뀌지 않게)
  (envelopeEdges || []).forEach(edge => {
    if (edge.type !== 'adjacent' && edge.type !== 'road') return;
    // 정북일조(건축법 시행령 제86조①)는 전용주거·일반주거지역에만 있는 규정이라, 그 외
    // 지역(준주거·상업·공업·녹지 등)은 애초에 이 조항 자체가 적용되지 않는다(면제가 아니라
    // 미적용) — applyNorthSetback===false. northExempt는 이와 별개로, 정북 방향의 "이웃 대지"가
    // 비주거용도라 정북일조가 면제되는 경우(같은 조항 안의 예외)다. 둘 중 하나만 해당해도 스킵.
    if (edge.type === 'adjacent' && edge.isNorth && (edge.northExempt || applyNorthSetback === false)) return;

    let setback;
    if (edge.type === 'road') {
      // 도로 건너편에도 건물이 있을 수 있다고 보고 도로중심선을 기준으로 삼는다 — 도로폭의
      // 절반은 이미 이격거리로 인정되므로 대지경계선에서 추가로 필요한 후퇴만 요구한다.
      const roadWidth = num(edge.roadWidthM);
      const requiredFromCenterline = assumedHeight * buildingGapRatioNum;
      setback = Math.max(0, requiredFromCenterline - roadWidth / 2);
      if (setback <= 0) return; // 도로폭 크레딧만으로 이미 충분
    } else {
      const ratio = edge.isNorth ? num(northSetbackRatio || 0.5) : buildingGapRatioNum;
      setback = Math.max(1.5, assumedHeight * ratio);
    }

    const p1 = llToMeters(edge.p1, lat0);
    const p2 = llToMeters(edge.p2, lat0);
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy);
    if (len < 0.01) return;
    let nx = -dy / len, ny = dx / len;
    const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    const toCentroid = [setbackCentroid[0] - mid[0], setbackCentroid[1] - mid[1]];
    if (nx * toCentroid[0] + ny * toCentroid[1] < 0) { nx = -nx; ny = -ny; } // nx,ny를 안쪽 방향으로 정렬
    const linePoint = [mid[0] + nx * setback, mid[1] + ny * setback];
    poly = clipPolygonByHalfplane(poly, linePoint, [nx, ny]);
  });

  const bldgDepth = num(standardBuildingDepth) || 15;
  // 인동간격(동간 거리, 건축법 시행령 제86조③2호가목)은 채광사선(같은 조③1호, 인접대지경계선·
  // 도로중심선 기준— buildingGapRatio가 담당)과 별개 조항이라 지역별 완화가 없다. 도시형
  // 생활주택만 0.25배이고, 그 외(이 앱이 다루는 일반 공동주택)는 지역 불문 항상 0.5배다 —
  // 사용자 확인(2026-07-26, 법조문 인용): 준주거지역이어도 동간 거리는 0.5배를 유지해야 한다.
  const buildingGap = assumedHeight * INTER_BUILDING_GAP_RATIO;
  // comboModes(화면에서 다중선택한 조합 목록)가 없거나 전부 무효하면 방어적으로 9종 전체를
  // 허용한다 — massing.py optimize_massing과 동일한 폴백 규칙.
  const allowedComboKeysFiltered = (Array.isArray(comboModes) ? comboModes : []).filter(k => UNIT_COMBO_KEYS.includes(k));
  const allowedComboKeys = allowedComboKeysFiltered.length > 0 ? allowedComboKeysFiltered : UNIT_COMBO_KEYS;
  const buildingShape = allowedComboKeys.length < UNIT_COMBO_KEYS.length
    ? allowedComboKeys.map(k => UNIT_COMBO_DISPLAY_NAMES[k]).join('/')
    : '9종 조합 자유 혼합';

  if (poly.length < 3) {
    return {
      maxRows: 0, unitsPerFloor: 0, totalUnitsPerFloorAllRows: 0, requiredFloors: null,
      rows: [], northSetback, buildingGap, bldgDepth, noFit: true,
      frontSource: 'south', frontLabel: '정남향(기본)',
      buildingShape, comboBreakdown: []
    };
  }

  // ── ② 정면방향 후보(장변 vs 단변) 결정 ──
  // stackDirA: 건물이 층/동으로 쌓여나가는 방향(단위벡터). 기본은 정북(0,1) = 정남향 건물이 장변으로 늘어섬.
  let stackDirA = [0, 1];
  let frontSourceA = 'south';
  let bestLen = 0, bestEdge = null;
  (envelopeEdges || []).forEach(e => {
    if (e.type !== 'road' || e.isNorth) return;
    const p1 = llToMeters(e.p1, lat0);
    const p2 = llToMeters(e.p2, lat0);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (len > bestLen) { bestLen = len; bestEdge = { p1, p2, len }; }
  });
  if (bestEdge && bestEdge.len >= bldgDepth) {
    const dx = bestEdge.p2[0] - bestEdge.p1[0], dy = bestEdge.p2[1] - bestEdge.p1[1];
    const roadDir = [dx / bestEdge.len, dy / bestEdge.len];
    let perp = [-roadDir[1], roadDir[0]];
    const mid = [(bestEdge.p1[0] + bestEdge.p2[0]) / 2, (bestEdge.p1[1] + bestEdge.p2[1]) / 2];
    const centroid = polygonCentroidApprox(poly);
    const toCentroid = [centroid[0] - mid[0], centroid[1] - mid[1]];
    if (perp[0] * toCentroid[0] + perp[1] * toCentroid[1] < 0) perp = [-perp[0], -perp[1]];
    stackDirA = perp;
    frontSourceA = 'road';
  }
  const widthDirA = [stackDirA[1], -stackDirA[0]];
  // 후보 B: A와 90도 회전(적층↔폭 방향을 맞바꿈) — "단변 배치"
  const stackDirB = widthDirA;
  const widthDirB = [-stackDirA[0], -stackDirA[1]];

  const unitWidth = num(standardUnitWidth) || 9;
  // 세대타입별 공급면적 비례 폭을 미리 붙여서 넘긴다 — 84/59 등 타입이 섞여도 실제 크기 차이가
  // 유닛 박스 폭에 반영되도록(이전에는 모든 타입이 동일한 표준폭이었음).
  const unitTypeListScaled = attachPerTypeUnitWidths(unitTypeList, unitWidth);
  // 건폐율 상한 — 없으면(구버전 호출부 등) 무제한으로 취급해 기존 동작을 유지한다.
  const maxFootprintM2 = (num(landArea) > 0 && num(legalBcrMax) > 0) ? num(landArea) * num(legalBcrMax) / 100 : Infinity;
  const bandParams = { bldgDepth, buildingGap, unitWidth, unitTypeList: unitTypeListScaled, allowedComboKeys, maxFootprintM2 };

  // ── ③ 9종 조합 카탈로그로 장변/단변 두 방향 후보를 모두 채워보고 층당 세대수가 더 많은 쪽 채택 ──
  const resultA = estimateComboLayout(poly, lat0, stackDirA, widthDirA, bandParams);
  const resultB = estimateComboLayout(poly, lat0, stackDirB, widthDirB, bandParams);
  const useB = resultB.totalUnitsPerFloorAllRows > resultA.totalUnitsPerFloorAllRows;
  const chosen = useB ? resultB : resultA;
  const orientationLabel = frontSourceA === 'road' ? '주도로 방향' : '정남향';
  const frontLabel = useB ? `${orientationLabel}의 단변 배치` : `${orientationLabel}(장변 배치)`;

  const { rows, totalUnitsPerFloorAllRows, footprintAreaM2 } = chosen;
  const requiredFloors = totalUnitsPerFloorAllRows > 0 ? Math.max(1, Math.ceil(totalHouseholds / totalUnitsPerFloorAllRows)) : null;

  const comboCounts = {};
  rows.forEach(r => { comboCounts[r.combo] = (comboCounts[r.combo] || 0) + 1; });

  return {
    maxRows: rows.length,
    unitsPerFloor: rows.length > 0 ? Math.round(totalUnitsPerFloorAllRows / rows.length) : 0,
    totalUnitsPerFloorAllRows,
    requiredFloors,
    rows,
    footprintAreaM2, // 실제 배치된 동들의 유닛면적 합산 — calculate()의 건폐율 산정에 사용(추정치 아님)
    northSetback, buildingGap, bldgDepth,
    frontSource: frontSourceA, frontLabel, orientationSwapped: useB,
    buildingShape,
    comboBreakdown: Object.entries(comboCounts).map(([combo, buildingCount]) => ({ combo, buildingCount }))
  };
}

/**
 * 핵심 건축 데이터 구조 계산
 *
 * @param {Object} inputs
 *   landArea           : 대지면적 (㎡)
 *   contributionArea   : 기부채납 도로면적 (㎡)
 *   zoneName           : 용도지역명
 *   localFarOverride   : 지자체 용적률 상한 수동 설정 (선택)
 *   localBcrOverride   : 지자체 건폐율 상한 수동 설정 (선택)
 *   aboveFloors        : 지상층수
 *   underFloors        : 지하층수
 *   unitTypes          : [{area: 전용㎡, count: 세대수}, ...]
 *   exclusiveRatio     : 전용률 (기본 0.748)
 *   totalParking       : 총 주차대수
 *   groundParking      : 지상 주차대수
 *   undergroundParking : 지하 주차대수
 *   areaOfficeGround   : 관리사무소 지상면적
 *   areaSeniorGround   : 경로당 지상면적
 *   areaKinderGround   : 어린이집 지상면적
 *   areaLibraryGround  : 작은도서관 지상면적
 *   areaCareGround     : 다함께돌봄센터 지상면적
 *   areaCommunityUnder : 기타 주민공동시설 지하면적
 *   areaGuardGround    : 경비실 지상면적
 *   shopArea           : 근린생활시설 면적
 *
 * @returns {Object} result - 모든 계산 결과
 */
function calculate(inputs) {
  const {
    landArea = 0, contributionArea = 0, zoneName = '',
    address = '',
    zonesMap = {},           // { '준주거지역': 1200, '일반상업지역': 800 }
    localFarOverride = null, localBcrOverride = null,
    localFarBaseOverride = null, localGreenRatioOverride = null,
    localParkingRatioOverride = null,
    openspaceTarget = false, localOpenspaceRatioOverride = null,
    // 층수: 직접 입력값(수동) 또는 null이면 자동 추정
    aboveFloorsManual = null, underFloorsManual = null,
    // 주차: 법정대수의 배수 또는 세대당 대수로 계획
    parkingMode = 'multiplier', // 'multiplier' | 'perUnit'
    parkingMultiplier = 1.0,   // 법정대수의 몇 배
    parkingPerUnit = 1.3,      // 세대당 계획 주차대수 (parkingMode='perUnit'일 때)
    parkingAreaPerSpace = 36,  // 주차 1면당 면적 (㎡), 기본 36㎡
    unitTypes = [], exclusiveRatio = 0.748,
    areaOfficeGround = 0, areaSeniorGround = 0, areaKinderGround = 0,
    areaLibraryGround = 0, areaCareGround = 0, areaCommunityUnder = 0,
    areaGuardGround = 0, shopArea = 0,
    parkingUndergroundArea = 0, storageArea = 0,
    // 부대복리시설 가중치(조정 배수), 기본 1.0
    amenityMultiplier = 1.0,
    // 개략 배치 시뮬레이션 (정북이격·인동간격 조례 반영, 대지 폴리곤 있을 때만 동작)
    siteDimensions = null,           // { widthEW, depthNS } (m, 대지 폴리곤 바운딩박스 — 건축가능영역 없을 때 폴백)
    buildableEnvelope = null,        // /api/buildable-envelope 응답의 1차 건축가능영역 GeoJSON (도로/인접대지 이격 적용됨)
    envelopeEdges = null,            // 변별 분류 [{index,type,isNorth,p1,p2}, ...] (정북변 추가 클리핑용)
    northSetbackRatio = 0.5,         // 조례 정북 이격 비율 (기본 0.5 = 높이×0.5, 국토계획법 시행령 제86조)
    buildingGapRatio = null,         // 조례 인동간격(채광사선) 비율 — 비워두면 준주거·근린상업 0.25, 그 외 0.5 자동 적용
    standardBuildingDepth = 10,      // 표준 동 깊이 (m, 전용 84㎡ 기준 — 실제 평균 전용면적 비율로 자동 스케일)
    standardUnitWidth = 15,          // 표준 세대 폭 (m, 전용 84㎡ 기준 — 실제 평균 전용면적 비율로 자동 스케일)
    coreWidth = 10,                  // 코어(계단실+승강기) 폭 (m) — 참고용, 9종 조합 배치에는 쓰이지 않음
    comboModes = null,                // 화면에서 다중선택한 조합 배열(2호/3호/4호-a/4호-b/4호-c/4호-d/
                                      // 5호-a/5호-b/6호 중 1개 이상) — 비어있거나 없으면 9종 전체 허용
    // 층별 층고 (mm) — 인동간격·채광사선·정북이격의 예상높이 산정에 사용, 미입력 시 2900mm
    floorHeight1Mm = null, floorHeight2Mm = null, floorHeight3Mm = null, floorHeightTypicalMm = null
  } = inputs;

  // 여러 조례 수치(조경비율·주차대수 근거 등)가 안산시인지에 따라 갈리므로 한 번만 판별해둔다.
  const cityIsAnsan = (address || '').includes('안산');

  // ── 세대 집계 ─────────────────────────────────────────
  const totalHouseholds = unitTypes.reduce((s, t) => s + num(t.count), 0);

  // ── 전용면적 합계 ─────────────────────────────────────
  const totalExclusiveArea = unitTypes.reduce((s, t) => s + num(t.count) * num(t.area), 0);

  // ── 타입별 면적 계산 ──────────────────────────────────
  const unitResults = unitTypes.map(t => {
    const count = num(t.count);
    const areaEx = num(t.area);
    const ratio = totalHouseholds > 0 ? count / totalHouseholds : 0;
    const supplyArea = exclusiveRatio > 0 ? areaEx / exclusiveRatio : areaEx;
    const supplyPy = supplyArea * 0.3025;
    const wallShare = areaEx * 0.09;
    const commonShare = supplyArea - areaEx - wallShare;
    return {
      name: t.name || `${areaEx}㎡형`,
      count, areaEx, ratio,
      wallShare, commonShare,
      supplyArea, supplyPy
    };
  });

  // ── 법정 주차대수 계산 ────────────────────────────────
  // 조례에 세대당 주차대수 기준이 있으면 우선 적용, 없으면 주택건설기준 등에 관한 규정(전용면적 기준)
  let legalParkingCount, parkingLegalSource;
  if (num(localParkingRatioOverride) > 0) {
    legalParkingCount = Math.ceil(totalHouseholds * num(localParkingRatioOverride));
    parkingLegalSource = '지자체 조례';
  } else {
    let legalParkingCalc = 0;
    unitResults.forEach(t => {
      if (t.areaEx <= 85) {
        legalParkingCalc += (t.count * t.areaEx) / 85;
      } else {
        legalParkingCalc += (t.count * t.areaEx) / 70;
      }
    });
    // 전용면적 비례 산식만 적용하면 소형평형(예: 59㎡ → 0.69대) 비중이 높을 때
    // 세대수보다 적게 나올 수 있다 — 안산시 주차장 조례 별표5(제15조 관련) 5호는
    // "세대당 주차대수가 1대 이상이 되도록 하여야 한다"는 최소기준을 별도로 두고
    // 있으므로(전국 공통인 주택건설기준 등에 관한 규정과 동일한 산식·문구), 면적
    // 비례 산정치와 세대수 중 큰 쪽을 법정대수로 한다.
    legalParkingCount = Math.max(Math.ceil(legalParkingCalc), totalHouseholds);
    parkingLegalSource = cityIsAnsan ? '안산시 주차장 조례 별표5' : '주택건설기준 등에 관한 규정';
  }

  // ── 계획 주차대수 (배수 방식 또는 세대당 대수 방식) ────
  const plannedParking = parkingMode === 'perUnit'
    ? Math.ceil(totalHouseholds * num(parkingPerUnit || 1.0))
    : Math.ceil(legalParkingCount * num(parkingMultiplier || 1.0));
  const groundParking = 0; // 지상 주차는 기본 0 (필요시 별도 입력)
  const undergroundParking = plannedParking;
  const totalInstParking = plannedParking;
  const parkingOk = totalInstParking >= legalParkingCount;

  // 확장형/EV/장애인 주차
  const expandParking = Math.ceil(totalInstParking * 0.3);
  const evParking = Math.ceil(totalInstParking * 0.05);
  const disabledParking = Math.ceil(totalInstParking * 0.03);

  // ── 주민공동시설 의무면적 ─────────────────────────────
  let legalCommunityArea = 0;
  if (totalHouseholds >= 1000) {
    legalCommunityArea = 500 + totalHouseholds * 2.0;
  } else if (totalHouseholds >= 100) {
    legalCommunityArea = totalHouseholds * 2.5;
  }

  // ── 법정 시설별 의무면적 (주택건설기준 등에 관한 규정) ──
  // 경로당: 150세대 이상 50+(세대수*0.1)
  const legalSeniorArea = totalHouseholds >= 150 ? 50 + totalHouseholds * 0.1 : 0;

  // 어린이집: 세대수 구간별 정원(명) × 4.29㎡
  let kinderCapacity = 0, legalKinderArea = 0;
  if (totalHouseholds >= 1000) {
    kinderCapacity = 80; // 80인 이상 (최소 기준)
    legalKinderArea = kinderCapacity * 4.29;
  } else if (totalHouseholds >= 600) {
    kinderCapacity = 30 + totalHouseholds * 0.05;
    legalKinderArea = kinderCapacity * 4.29;
  } else if (totalHouseholds >= 300) {
    kinderCapacity = totalHouseholds * 0.1;
    legalKinderArea = kinderCapacity * 4.29;
  }

  // 관리사무소: 10+(세대수-50)*0.05, 최소 10㎡
  const legalOfficeArea = totalHouseholds > 0 ? Math.max(10, 10 + (totalHouseholds - 50) * 0.05) : 0;

  // 작은도서관: 500세대 이상 33㎡ 이상
  const legalLibraryArea = totalHouseholds >= 500 ? 33 : 0;

  // 세대창고: 전용면적 50㎡ 이상인 세대는 1세대당 1㎡ 이상(주택건설기준 등에 관한 규정 제37조)
  // — 지하층 등 공용공간에 설치하는 것이 일반적이라 지하 연면적에 산입.
  const legalStorageArea = unitResults.reduce((s, t) => s + (t.areaEx >= 50 ? t.count * 1 : 0), 0);

  // 다함께돌봄센터(키즈라운지): 500세대 이상 66㎡ 이상 (주택건설기준 등에 관한 규정)
  const legalCareArea = totalHouseholds >= 500 ? 66 : 0;

  // 주민운동시설: 500세대 이상 의무(고정 산식 없음 — "종목별 규격에 따른 면적")
  const communityExerciseRequired = totalHouseholds >= 500;

  // 어린이놀이터: 세대수 구간별 (150~300 적정면적, 300~1000 200+세대수, 1000~ 500+세대수*0.7)
  let legalPlaygroundArea = 0, legalPlaygroundText = null;
  if (totalHouseholds >= 1000) {
    legalPlaygroundArea = 500 + totalHouseholds * 0.7;
  } else if (totalHouseholds >= 300) {
    legalPlaygroundArea = 200 + totalHouseholds;
  } else if (totalHouseholds >= 150) {
    legalPlaygroundText = '적정면적 확보 (고정 산식 없음)';
  }

  // ── 부대복리시설 면적: 사용자 입력 or 법정 의무 자동채움 ──
  // amenityMultiplier: 법정 대비 배수 (1.0=법정, 1.2=법정×1.2)
  const mult = num(amenityMultiplier) || 1.0;
  const actualSeniorArea  = num(areaSeniorGround)  > 0 ? num(areaSeniorGround)  : Math.round(legalSeniorArea * mult);
  const actualKinderArea  = num(areaKinderGround)  > 0 ? num(areaKinderGround)  : Math.round(legalKinderArea * mult);
  const actualOfficeArea  = num(areaOfficeGround)  > 0 ? num(areaOfficeGround)  : Math.round(legalOfficeArea * mult);
  const actualGuardArea   = num(areaGuardGround)   > 0 ? num(areaGuardGround)   :
    (totalHouseholds >= 50 ? Math.ceil(totalHouseholds / 100) * 3 : 0);
  const actualLibraryArea = num(areaLibraryGround) > 0 ? num(areaLibraryGround) : Math.round(legalLibraryArea * mult);
  const actualCareArea    = num(areaCareGround)    > 0 ? num(areaCareGround)    : Math.round(legalCareArea * mult);
  const actualStorageArea = num(storageArea)       > 0 ? num(storageArea)       : Math.round(legalStorageArea * mult);
  const storageOk = actualStorageArea >= legalStorageArea;
  // 주민공동시설(지하): 나머지 의무면적을 지하에 배분
  const sumGroundAmenity = actualSeniorArea + actualKinderArea + actualOfficeArea +
    actualGuardArea + actualLibraryArea + actualCareArea;
  const autoCommUnder = legalCommunityArea > sumGroundAmenity
    ? Math.round((legalCommunityArea - sumGroundAmenity) * mult)
    : 0;
  const actualCommunityUnder = num(areaCommunityUnder) > 0 ? num(areaCommunityUnder) : autoCommUnder;

  const actualCommunityArea = actualSeniorArea + actualKinderArea + actualLibraryArea +
    actualCareArea + actualCommunityUnder;
  const communityOk = actualCommunityArea >= legalCommunityArea;
  const seniorOk = actualSeniorArea >= legalSeniorArea;
  const kinderOk = actualKinderArea >= legalKinderArea;
  const officeOk = actualOfficeArea >= legalOfficeArea;
  const libraryOk = actualLibraryArea >= legalLibraryArea;
  const careOk = actualCareArea >= legalCareArea;

  // ── 법적 근거 텍스트 ("연면적 세부 내역" 표의 "법적 근거" 열에 그대로 표시) ──
  // 부대복리시설은 세대수 구간에 따라 적용되는 산식 자체가 달라지므로(예: 어린이집은
  // 300/600/1000세대 경계마다 다른 식), 가능한 모든 구간을 나열하지 않고 지금 입력된
  // totalHouseholds에 실제로 해당하는 구간의 산식 하나만 보여준다 — 세대수를 바꾸면
  // 이 텍스트도 그 즉시 다른 구간으로 바뀐다.
  const officeLegalBasis = totalHouseholds > 0
    ? '10㎡+(세대수-50)×0.05㎡ 이상 (최소 10㎡)'
    : '—';
  const seniorLegalBasis = totalHouseholds >= 150
    ? '50㎡+(세대수×0.1㎡) 이상 (150세대 이상)'
    : '150세대 미만 — 설치의무 없음';
  const kinderLegalBasis = totalHouseholds >= 1000
    ? '정원 80명 이상 × 4.29㎡ (1,000세대 이상)'
    : totalHouseholds >= 600
      ? '정원 [30+세대수×0.05]명 × 4.29㎡ (600~999세대)'
      : totalHouseholds >= 300
        ? '정원 [세대수×0.1]명 × 4.29㎡ (300~599세대)'
        : '300세대 미만 — 설치의무 없음';
  const libraryLegalBasis = totalHouseholds >= 500
    ? '33㎡ 이상, 6석 이상 (500세대 이상)'
    : '500세대 미만 — 설치의무 없음';
  const careLegalBasis = totalHouseholds >= 500
    ? '66㎡ 이상 (500세대 이상)'
    : '500세대 미만 — 설치의무 없음';
  const guardLegalBasis = totalHouseholds >= 50
    ? 'ceil(세대수/100)×3㎡ (50세대 이상, 참고 산식)'
    : '—';
  const communityLegalBasis = totalHouseholds >= 1000
    ? '500㎡+(세대수×2.0㎡) 이상 (1,000세대 이상)'
    : totalHouseholds >= 100
      ? '세대수×2.5㎡ 이상 (100~999세대)'
      : '100세대 미만 — 설치의무 없음';
  const storageLegalBasis = '전용 50㎡ 이상 세대당 1㎡ 이상 (주택건설기준 등에 관한 규정 제37조)';
  const machineRoomLegalBasis = '지상연면적 × 4% (관행 산정기준)';
  const playgroundLegalBasis = totalHouseholds >= 1000
    ? '500㎡+(세대수×0.7㎡) 이상 (1,000세대 이상)'
    : totalHouseholds >= 300
      ? '200㎡+(세대수×1.0㎡) 이상 (300~999세대)'
      : totalHouseholds >= 150
        ? '적정면적 확보 (150~299세대, 고정 산식 없음)'
        : '150세대 미만 — 설치의무 없음';
  const exerciseLegalBasis = totalHouseholds >= 500
    ? '종목별 규격에 따른 면적 (500세대 이상, 고정 산식 없음)'
    : '500세대 미만 — 설치의무 없음';

  // ── 지상 연면적 계산 ──────────────────────────────────
  const groundAmenityTotal = actualOfficeArea + actualSeniorArea + actualKinderArea +
    actualLibraryArea + actualCareArea + actualGuardArea;
  const underAmenityTotal = actualCommunityUnder;

  // ── 부대복리시설 세대당 평 (핵심지표 요약 및 "세대당 평" 조절 기능용) ──
  const totalAmenityArea = groundAmenityTotal + underAmenityTotal;
  const amenityPerHouseholdPy = totalHouseholds > 0 ? (totalAmenityArea / totalHouseholds) * 0.3025 : 0;

  const housingGroundArea = unitResults.reduce((s, t) => s + t.count * t.supplyArea, 0);
  const groundSubtotal = housingGroundArea + groundAmenityTotal + num(shopArea);

  // 기전실 (지상층 연면적의 4%, 지하에 산입)
  const machineRoomArea = groundSubtotal * 0.04;

  // 지하 주차장 면적: 주차대수 × 단위면적 (or 직접 입력값)
  const parkingUnderArea = num(parkingUndergroundArea) > 0
    ? num(parkingUndergroundArea)
    : undergroundParking * num(parkingAreaPerSpace || 36);

  // 지하 연면적
  const undergroundTotal = parkingUnderArea + underAmenityTotal + machineRoomArea + actualStorageArea;

  // 지상층 연면적 총계
  const aboveGroundTotal = groundSubtotal;
  const totalFloorArea = aboveGroundTotal + undergroundTotal;
  const farBaseArea = aboveGroundTotal;

  // ── 조경면적 비율 산정기준 ────────────────────────────────────────
  // 기본값(용도지역 주거/상업 구분에 따른 20%/15%)은 여러 지자체에 흔한 방식이지만,
  // 안산시는 안산시 건축 조례 제25조에 따라 용도지역과 무관하게 "연면적 합계"
  // 구간별로 비율이 달라진다(2,000㎡ 이상 15%, 1,000㎡ 이상 2,000㎡ 미만 10%,
  // 1,000㎡ 미만 5%) — 실제 안산시 초지동 604-4 프로젝트 검토 중 확인됨(사용자
  // 피드백: 기존 주거/상업 구분 로직이 안산시 실제 조례와 다르다).
  const ansanGreenRatio = totalFloorArea >= 2000 ? 0.15 : (totalFloorArea >= 1000 ? 0.10 : 0.05);
  const greenRatioFor = (category) => cityIsAnsan ? ansanGreenRatio : ((category === '주거') ? 0.20 : 0.15);

  // ─────────────────────────────────────────────────────────────────
  // ── 국토의 계획 및 이용에 관한 법률 제84조 구현 ──────────────────
  //   둘 이상의 용도지역에 걸치는 대지에 대한 적용 기준
  //
  // [원문 취지]
  //   ① 가장 작은 부분의 면적이 330㎡ 이하(노선상업지역은 660㎡ 이하)인 경우
  //      → 전체 대지에 대해 각 용도지역별 면적비율의 가중평균 용적률·건폐율 적용
  //   ② 모든 구역의 면적이 기준 초과인 경우
  //      → 각 용도지역에 속하는 부분에 대해 해당 지역의 기준을 독립적으로 적용
  // ─────────────────────────────────────────────────────────────────

  const activeZones = Object.entries(zonesMap).filter(
    ([z]) => z && z !== '미지정' && z !== 'null'
  );

  // 각 용도지역에 대해 조례 한도를 가져옴
  function getZoneLimits(zName) {
    const zoneObj = getZone(zName) || { bcrMax: 60, farMax: 250, farBase: 150, category: '주거' };
    const lim = getOrdinanceLimits(address, zName) || {
      bcrMax: zoneObj.bcrMax,
      farMax: zoneObj.farMax,
      farBase: zoneObj.farBase || Math.round(zoneObj.farMax * 0.7),
      source: '국계법 기준'
    };
    return { ...lim, category: zoneObj.category, desc: zoneObj.desc || '' };
  }

  // 노선상업지역 여부 판별 (상업지역 중 도로변 띠 형태로 지정되는 근린/노선상업)
  function isRoadsideCommercial(zName) {
    return zName.includes('근린상업') || zName.includes('노선상업') || zName.includes('유통상업');
  }

  let rawBcrMax, rawFarMax, rawFarBase, rawGreenRatio;
  let zoneBreakdown = [];
  let multiZoneMethod = 'single'; // 'single' | 'weighted' | 'independent'
  let independentZones = [];       // 독립 적용 시 각 구역별 상세

  if (activeZones.length > 1) {
    // ── 복수 용도지역 처리 ──────────────────────────────────────
    const totalZoneArea = activeZones.reduce((s, [, a]) => s + num(a), 0);

    // 각 구역의 면적과 기준값 계산
    const zoneEntries = activeZones.map(([zName, area]) => {
      const lim = getZoneLimits(zName);
      // 노선상업지역이 포함된 경우 해당 구역 기준면적 660㎡ 적용
      const threshold = isRoadsideCommercial(zName) ? 660 : 330;
      return { name: zName, area: num(area), threshold, ...lim };
    });

    // 가장 작은 구역 면적
    const minZoneArea = Math.min(...zoneEntries.map(z => z.area));
    // 해당 가장 작은 구역의 기준면적 (노선상업 여부 반영)
    const minZoneEntry = zoneEntries.find(z => z.area === minZoneArea);
    const minThreshold = minZoneEntry ? minZoneEntry.threshold : 330;

    // 법 제84조 판단: 가장 좁은 구역 면적 ≤ 기준면적 → 가중평균, 아니면 독립 적용
    const useWeightedAvg = minZoneArea <= minThreshold;

    zoneEntries.forEach(z => {
      zoneBreakdown.push({
        name: z.name,
        area: z.area,
        bcr: z.bcrMax,
        far: z.farMax,
        source: z.source,
        category: z.category,
        verified: z.verified
      });
    });

    if (useWeightedAvg) {
      // ── ① 가중평균 방식 (제84조 1항) ─────────────────────────
      multiZoneMethod = 'weighted';
      let sumBcr = 0, sumFar = 0, sumFarBase = 0, sumGreen = 0;
      zoneEntries.forEach(z => {
        const w = totalZoneArea > 0 ? z.area / totalZoneArea : 0;
        sumBcr     += w * z.bcrMax;
        sumFar     += w * z.farMax;
        sumFarBase += w * z.farBase;
        sumGreen   += w * greenRatioFor(z.category);
      });
      rawBcrMax    = Math.round(sumBcr * 100) / 100;
      rawFarMax    = Math.round(sumFar * 100) / 100;
      rawFarBase   = Math.round(sumFarBase * 100) / 100;
      rawGreenRatio = Math.round(sumGreen * 1000) / 1000;

    } else {
      // ── ② 독립 적용 방식 (제84조 2항) ────────────────────────
      // 각 구역별 허용 연면적 = 해당 구역 면적 × 해당 용적률
      // 각 구역별 허용 건축면적 = 해당 구역 면적 × 해당 건폐율
      // 건폐율 = Σ(각 구역 허용 건축면적) / 전체 대지면적
      // 용적률 = Σ(각 구역 허용 연면적) / 전체 대지면적
      multiZoneMethod = 'independent';

      let sumAllowedFootprint = 0;
      let sumAllowedFloorArea = 0;
      let sumFarBase = 0;
      let sumGreen = 0;

      zoneEntries.forEach(z => {
        const allowedFootprint = z.area * (z.bcrMax / 100);
        const allowedFloorArea = z.area * (z.farMax / 100);
        const allowedFarBase   = z.area * (z.farBase / 100);
        sumAllowedFootprint += allowedFootprint;
        sumAllowedFloorArea += allowedFloorArea;
        sumFarBase += allowedFarBase;
        sumGreen += z.area * greenRatioFor(z.category);
        independentZones.push({
          name: z.name,
          area: z.area,
          bcr: z.bcrMax,
          far: z.farMax,
          allowedFootprint,
          allowedFloorArea,
          source: z.source
        });
      });

      // 대지 전체에 대한 등가 건폐율/용적률 (적합 여부 판단용)
      rawBcrMax    = totalZoneArea > 0 ? Math.round((sumAllowedFootprint / totalZoneArea) * 10000) / 100 : 60;
      rawFarMax    = totalZoneArea > 0 ? Math.round((sumAllowedFloorArea / totalZoneArea) * 10000) / 100 : 250;
      rawFarBase   = totalZoneArea > 0 ? Math.round((sumFarBase / totalZoneArea) * 10000) / 100 : 150;
      rawGreenRatio = totalZoneArea > 0 ? sumGreen / totalZoneArea : 0.20;
    }

  } else if (activeZones.length === 1) {
    // ── 단일 용도지역 ──────────────────────────────────────────
    multiZoneMethod = 'single';
    const [[zName, area]] = activeZones;
    const lim = getZoneLimits(zName);
    const zoneObj = getZone(zName) || { category: '주거' };
    rawBcrMax    = lim.bcrMax;
    rawFarMax    = lim.farMax;
    rawFarBase   = lim.farBase;
    rawGreenRatio = greenRatioFor(zoneObj.category);
    zoneBreakdown.push({ name: zName, area: num(area), bcr: lim.bcrMax, far: lim.farMax, source: lim.source, category: zoneObj.category, verified: lim.verified });
  } else {
    // ── 용도지역 미지정 (zoneName fallback) ────────────────────
    multiZoneMethod = 'single';
    const zone = getZone(zoneName) || { bcrMax: 60, farMax: 250, farBase: 150, category: '주거' };
    const lim = getOrdinanceLimits(address, zoneName) || {
      bcrMax: zone.bcrMax, farMax: zone.farMax,
      farBase: zone.farBase || Math.round(zone.farMax * 0.7), source: '국계법 기준'
    };
    rawBcrMax    = lim.bcrMax;
    rawFarMax    = lim.farMax;
    rawFarBase   = lim.farBase;
    rawGreenRatio = greenRatioFor(zone.category);
    if (zoneName) zoneBreakdown.push({ name: zoneName, area: landArea, bcr: lim.bcrMax, far: lim.farMax, source: lim.source, verified: lim.verified });
  }

  // ── 법적 상한 (수동 덮어쓰기 우선) ─────────────────
  const legalBcrMax = num(localBcrOverride) || rawBcrMax;
  const legalFarMax = num(localFarOverride) || rawFarMax;

  // ── 대지면적 ─────────────────────────────────────────
  const usableLandArea = Math.max(landArea - contributionArea, 0);

  // ── 완화 용적률 (기부채납) ─────────────────────────
  let relaxedFarLimit = legalFarMax;
  if (contributionArea > 0 && usableLandArea > 0) {
    const farBase = num(localFarBaseOverride) || rawFarBase;
    relaxedFarLimit = farBase + (1.5 * contributionArea * farBase) / usableLandArea;
  }

  // ── 조경면적 기준 ────────────────────────────────────
  let legalGreenRatio = rawGreenRatio;
  if (localGreenRatioOverride !== null && localGreenRatioOverride !== undefined && num(localGreenRatioOverride) > 0) {
    legalGreenRatio = num(localGreenRatioOverride) / 100; // 입력은 %(예: 20), 내부적으로는 비율(0.20)로 환산
  }
  const legalGreenArea = usableLandArea * legalGreenRatio;
  const greenLegalBasis = (num(localGreenRatioOverride) > 0)
    ? `대지면적×${(legalGreenRatio * 100).toFixed(0)}% 이상 (조례 직접입력)`
    : cityIsAnsan
      ? (totalFloorArea >= 2000
          ? '연면적 합계 2,000㎡ 이상 — 대지면적×15% 이상 (안산시 건축 조례 제25조)'
          : totalFloorArea >= 1000
            ? '연면적 합계 1,000㎡ 이상 2,000㎡ 미만 — 대지면적×10% 이상 (안산시 건축 조례 제25조)'
            : '연면적 합계 1,000㎡ 미만 — 대지면적×5% 이상 (안산시 건축 조례 제25조)')
      : `대지면적×${(legalGreenRatio * 100).toFixed(0)}% 이상 (용도지역 주거/상업 구분 기준)`;

  // ── 공개공지 (사용자가 대상으로 지정한 경우만) ──────────
  const openspaceRatio = num(localOpenspaceRatioOverride) > 0 ? num(localOpenspaceRatioOverride) : 5;
  const legalOpenspaceArea = openspaceTarget ? usableLandArea * (openspaceRatio / 100) : 0;

  // ── 지하저수조 (세대당 0.5톤 이상) ──────────────────────
  const legalWaterTankVolume = totalHouseholds * 0.5;

  // ── 층수 자동 추정 ────────────────────────────────────
  // ① 법규(용적률/건폐율) 기반 상한 층수: 지상 연면적 / 건폐율 기준 최대 건축면적 역산
  // ② 배치 기반 필요 층수: 대지경계선을 도로/인접대지로 구분해 각각 이격 적용한 건축가능영역
  //    (buildableEnvelope, /api/buildable-envelope 결과) 위에서 코어+N호 조합 배치를 시뮬레이션.
  //    건축가능영역이 없으면(폴리곤 미확정 등) 바운딩박스 근사(siteDimensions)로 폴백.
  //    실제 3D 일영·매싱 설계가 아닌 개략 근사치 — 실시설계 시 재검토 필요.
  let aboveFloors, underFloors;
  let layoutConstraint = 'manual';
  let layoutInfo = null;
  let legalAboveFloorsExceeded = false;

  // 법규(건폐율) 기반 최고층수 상한 — 수동입력 여부와 무관하게 항상 계산해서 화면에 명시한다
  let legalAboveFloors = 1;
  if (landArea > 0 && groundSubtotal > 0) {
    const maxFootprint = landArea * (legalBcrMax / 100) * 0.85; // 15% 여유
    legalAboveFloors = maxFootprint > 0 ? Math.ceil(groundSubtotal / maxFootprint) : 1;
    legalAboveFloors = Math.max(1, Math.min(legalAboveFloors, 70)); // 1~70층 범위 제한
  }

  // 채광사선(인접대지경계선·도로중심선 기준, 건축법 시행령 제86조③1호) 비율: 준주거·근린상업지역은
  // 4배 완화(0.25H), 그 외는 2배(0.5H) — 조례 직접입력이 최우선. 인동간격(동간 거리, 같은 조③2호)은
  // 이 완화 대상이 아니다 — INTER_BUILDING_GAP_RATIO(고정 0.5) 참고.
  const relaxedGapZone = (zoneBreakdown || []).some(z => z.name === '준주거지역' || z.name === '근린상업지역');
  const effectiveBuildingGapRatio = (buildingGapRatio !== null && buildingGapRatio !== undefined && buildingGapRatio !== '')
    ? num(buildingGapRatio)
    : (relaxedGapZone ? 0.25 : 0.5);

  // 정북일조(제86조①)는 전용주거·일반주거지역에만 있는 규정 — 그 외 지역(이 대지처럼 준주거 등)은
  // 정북 방향 이격 자체가 적용되지 않는다(사용자 법조문 확인, 2026-07-26).
  const applyNorthSetback = (zoneBreakdown || []).some(z => NORTH_SETBACK_APPLICABLE_ZONES.includes(z.name));

  // 표준 동깊이/세대폭은 전용 84㎡ 기준값 — 실제 평균 전용면적 비율로 비례 스케일
  const avgAreaEx = totalHouseholds > 0 ? totalExclusiveArea / totalHouseholds : 84;
  const areaScale = avgAreaEx / 84;
  const scaledBuildingDepth = (num(standardBuildingDepth) || 10) * areaScale;
  const scaledUnitWidth = (num(standardUnitWidth) || 15) * areaScale;

  if (num(aboveFloorsManual) > 0) {
    aboveFloors = num(aboveFloorsManual);
    if (aboveFloors > legalAboveFloors) legalAboveFloorsExceeded = true;
  } else {
    // 예상높이(인동간격·정북이격 산정용)와 필요층수는 서로가 서로를 결정하는 순환 관계다:
    // 예상높이가 커질수록 인동간격·정북이격이 커져 같은 대지에 덜 들어차므로 필요층수가
    // 늘고, 필요층수가 바뀌면 그 층수 기준 예상높이도 달라진다. 법정 상한(legalAboveFloors,
    // 보통 건폐율 역산 기준이라 실제 목표세대수에 필요한 층수보다 훨씬 높다)을 그대로 예상
    // 높이 산정에 고정해버리면, 실제로는 훨씬 낮은 층수로 충분한 자리에도 그 낮은 층수라면
    // 필요 없을 만큼 큰 간격을 가정해 배치를 시뮬레이션하게 되어 필요층수가 실제보다 과대
    // 산정된다("몇 층이 필요한지 알아야 간격을 알 수 있고, 간격을 알아야 몇 층이 필요한지
    // 안다"는 순환을 법정 상한으로 어림잡아 끊었던 것). 이를 "가정한 층수 → 그 층수 기준
    // 높이로 재시뮬레이션 → 새 필요층수" 를 고정점에 수렴(또는 두 값 사이를 오가는 진동
    // 감지)할 때까지 반복해 끊는다 — 실무에서 "가층수 가정 후 반복 검토"하는 방식과 같다.
    const runLayoutSim = (floorsForHeight) => {
      const h = computeAssumedHeightM(floorsForHeight, floorHeight1Mm, floorHeight2Mm, floorHeight3Mm, floorHeightTypicalMm);
      let info = null;
      if (buildableEnvelope && totalHouseholds > 0) {
        // ② 건축가능영역 폴리곤 기반 배치
        info = estimatePolygonLayout({
          buildableEnvelope, envelopeEdges, totalHouseholds, assumedHeight: h,
          northSetbackRatio, buildingGapRatio: effectiveBuildingGapRatio, applyNorthSetback,
          standardBuildingDepth: scaledBuildingDepth, standardUnitWidth: scaledUnitWidth,
          comboModes, landArea, legalBcrMax,
          unitTypeList: unitResults.filter(t => t.count > 0).map(t => ({ name: t.name, supplyArea: t.supplyArea, count: t.count }))
        });
      } else if (siteDimensions && siteDimensions.widthEW > 0 && siteDimensions.depthNS > 0 && totalHouseholds > 0) {
        // ② 폴백: 바운딩박스 근사 (건축가능영역 폴리곤이 없을 때)
        const { widthEW, depthNS } = siteDimensions;
        const unitsPerFloor = Math.max(1, Math.floor(widthEW / scaledUnitWidth));
        // 정북일조가 미적용 지역(준주거 등)이면 정북 이격 자체가 없다 — 폴리곤 경로와 동일 규칙.
        const northSetback = applyNorthSetback ? Math.max(1.5, h * num(northSetbackRatio || 0.5)) : 0;
        // 인동간격은 채광사선(effectiveBuildingGapRatio)과 별개로 지역 불문 고정 0.5배.
        const buildingGap = h * INTER_BUILDING_GAP_RATIO;
        const usableDepth = depthNS - northSetback;
        const bldgDepth = scaledBuildingDepth;
        const geometricMaxRows = usableDepth > bldgDepth
          ? Math.max(1, Math.floor((usableDepth + buildingGap) / (bldgDepth + buildingGap)))
          : 1;
        // 폴리곤 기반 경로(estimateComboLayout)와 동일하게, 기하학적으로 들어가도 법정 건폐율을
        // 넘기는 행 수는 배제한다(대략 행 하나당 widthEW×bldgDepth 바닥면적으로 근사).
        const maxRowsByBcr = (num(landArea) > 0 && num(legalBcrMax) > 0 && widthEW > 0 && bldgDepth > 0)
          ? Math.max(1, Math.floor((num(landArea) * num(legalBcrMax) / 100) / (widthEW * bldgDepth)))
          : Infinity;
        const maxRows = Math.min(geometricMaxRows, maxRowsByBcr);
        const unitsPerFloorAllRows = maxRows * unitsPerFloor;
        const requiredFloors = unitsPerFloorAllRows > 0
          ? Math.max(1, Math.ceil(totalHouseholds / unitsPerFloorAllRows))
          : null;
        info = { maxRows, unitsPerFloor, totalUnitsPerFloorAllRows: unitsPerFloorAllRows, requiredFloors, northSetback, buildingGap, bldgDepth };
      }
      if (info) info.assumedHeight = h;
      return info;
    };

    const MAX_HEIGHT_SIM_ITERS = 6; // 정수 층수 기반 이산 수렴이라 보통 2~3회면 고정점에 닿는다
    let floorsGuess = legalAboveFloors; // 1회차는 기존 동작과 동일(법정 상한 기준)해 첫 결과가 어긋나지 않는다
    const seenGuesses = new Set();
    let heightIterations = 0;
    for (let iter = 0; iter < MAX_HEIGHT_SIM_ITERS; iter++) {
      heightIterations = iter + 1;
      const info = runLayoutSim(floorsGuess);
      if (!info || !info.requiredFloors) break; // 직전까지의 유효한 layoutInfo를 덮어쓰지 않고 유지
      layoutInfo = info;
      const nextGuess = Math.max(1, Math.min(info.requiredFloors, legalAboveFloors));
      if (nextGuess === floorsGuess || seenGuesses.has(nextGuess)) break; // 고정점 도달 또는 진동 감지
      seenGuesses.add(floorsGuess);
      floorsGuess = nextGuess;
    }

    if (layoutInfo) { layoutInfo.legalAboveFloors = legalAboveFloors; layoutInfo.areaScale = areaScale; layoutInfo.heightIterations = heightIterations; }

    if (layoutInfo && layoutInfo.requiredFloors) {
      if (layoutInfo.requiredFloors > legalAboveFloors) {
        // 배치상 필요한 층수가 법규 상한을 초과 → 법규가 governing, 배치 초과 경고
        aboveFloors = legalAboveFloors;
        layoutConstraint = 'legal';
        layoutInfo.exceedsLegal = true;
      } else {
        aboveFloors = layoutInfo.requiredFloors;
        layoutConstraint = 'placement';
      }
    } else {
      aboveFloors = legalAboveFloors;
      layoutConstraint = 'legal';
    }
  }
  if (num(underFloorsManual) > 0) {
    underFloors = num(underFloorsManual);
  } else {
    // 지하층수: 지하주차면적 기반 추정 (층당 주차공간)
    const parkingPerFloor = Math.max(20, Math.round(parkingUnderArea / (parkingAreaPerSpace || 36)));
    underFloors = parkingUnderArea > 0
      ? Math.ceil(undergroundParking / parkingPerFloor)
      : 1;
    underFloors = Math.max(1, Math.min(underFloors, 10));
  }

  // ── 건폐율 계산 ─────────────────────────────────────
  // 개략 배치 시뮬레이션(layoutInfo)이 실제로 동을 배치해서 폭×깊이를 합산해뒀으면 그 실측값을
  // 쓰고, 배치 정보가 없을 때만(대지 미확정 등) 총 지상연면적을 층수로 나눈 산술 추정치로 대체한다.
  // 추정치는 "층마다 면적이 균등하다"고 가정할 뿐 실제 동 개수·크기와 무관해 배치 결과와 어긋날 수 있다.
  const estBuildingFootprint = (layoutInfo && layoutInfo.footprintAreaM2 > 0)
    ? layoutInfo.footprintAreaM2
    : (aboveFloors > 0 ? housingGroundArea / aboveFloors : housingGroundArea);
  const bcrIsGeometric = !!(layoutInfo && layoutInfo.footprintAreaM2 > 0);
  const calculatedBcr = landArea > 0 ? (estBuildingFootprint / landArea) * 100 : 0;

  // ── 용적률 계산 ─────────────────────────────────────
  const calculatedFar = landArea > 0 ? (farBaseArea / landArea) * 100 : 0;

  // ── 법적 적합 여부 ───────────────────────────────────
  const farOk = calculatedFar <= (relaxedFarLimit + 0.01);
  const bcrOk = calculatedBcr <= (legalBcrMax + 0.01);

  // ── 단위세대 면적 상세 (기타공용면적 = 주차장 + 기전실 + 세대창고 분담) ──
  const unitDetails = unitResults.map(t => {
    const shareRatio = totalExclusiveArea > 0 ? (t.areaEx / totalExclusiveArea) : 0;
    const amenitySharePerUnit = totalHouseholds > 0
      ? (groundAmenityTotal + underAmenityTotal) * shareRatio : 0;
    const parkingSharePerUnit = parkingUnderArea > 0 ? parkingUnderArea * shareRatio : 0;
    const machineSharePerUnit = machineRoomArea * shareRatio;
    const storageSharePerUnit = actualStorageArea * shareRatio;
    // 기타공용면적 = 주차장분담 + 기전실분담 + 세대창고분담 (부대복리시설 분담 제외)
    const etcShare = parkingSharePerUnit + machineSharePerUnit + storageSharePerUnit;
    const contractArea = t.supplyArea + etcShare;
    const contractPy = contractArea * 0.3025;
    return {
      ...t,
      amenitySharePerUnit,
      parkingSharePerUnit,
      machineSharePerUnit,
      storageSharePerUnit,
      etcShare,
      contractArea,
      contractPy
    };
  });

  return {
    // 입력값 요약
    landArea, contributionArea, usableLandArea,
    zoneName, zoneBreakdown,
    legalBcrMax, legalFarMax, relaxedFarLimit,
    aboveFloors, underFloors, totalHouseholds, exclusiveRatio,
    layoutConstraint, layoutInfo, legalAboveFloors, legalAboveFloorsExceeded,

    // 제84조 복수 용도지역 산정 방식
    multiZoneMethod,       // 'single' | 'weighted' | 'independent'
    independentZones,      // 독립 적용 시 각 구역별 허용 면적 상세

    // 면적 결과
    totalExclusiveArea,
    housingGroundArea,
    groundAmenityTotal, underAmenityTotal,
    machineRoomArea,
    shopArea: num(shopArea),
    storageArea: actualStorageArea,
    aboveGroundTotal, undergroundTotal, totalFloorArea, farBaseArea,

    // 주차
    legalParkingCount, totalInstParking, plannedParking,
    groundParking: 0, undergroundParking,
    parkingUnderArea,
    parkingOk, expandParking, evParking, disabledParking,
    parkingLegalSource, parkingMode,

    // 건폐율·용적률
    estBuildingFootprint, bcrIsGeometric,
    calculatedBcr, bcrOk,
    calculatedFar, farOk,

    // 법정 의무 면적
    legalCommunityArea, actualCommunityArea, communityOk, communityLegalBasis,
    legalSeniorArea, actualSeniorArea, seniorOk, seniorLegalBasis,
    legalKinderArea, actualKinderArea, kinderOk, kinderCapacity, kinderLegalBasis,
    legalOfficeArea, actualOfficeArea, officeOk, officeLegalBasis,
    legalLibraryArea, actualLibraryArea, libraryOk, libraryLegalBasis,
    legalStorageArea, actualStorageArea, storageOk, storageLegalBasis,
    legalCareArea, actualCareArea, careOk, careLegalBasis,
    actualGuardArea, guardLegalBasis, actualCommunityUnder,
    machineRoomLegalBasis,
    totalAmenityArea, amenityPerHouseholdPy,
    communityExerciseRequired, exerciseLegalBasis,
    legalPlaygroundArea, legalPlaygroundText, playgroundLegalBasis,
    legalGreenArea, legalGreenRatio, greenLegalBasis,
    openspaceTarget, legalOpenspaceArea, openspaceRatio,
    legalWaterTankVolume,

    // 부대복리 자동 계산 결과 (UI에 피드백용)
    autoOfficeArea: actualOfficeArea,
    autoGuardArea: actualGuardArea,
    autoSeniorArea: actualSeniorArea,
    autoKinderArea: actualKinderArea,
    autoCommunityUnder: actualCommunityUnder,

    // 단위세대 상세
    unitDetails,

    // 포맷 헬퍼
    fmt, toPy
  };

}

