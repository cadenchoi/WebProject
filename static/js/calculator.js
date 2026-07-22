/**
 * calculator.js
 * 건축개요 자동 계산 엔진
 * 모든 면적·비율·법적 의무 산출 로직을 담당
 */

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

/** 폴리곤의 x범위 폭 (개략 가용폭 추정용) */
function polygonWidthX(poly) {
  if (!poly || poly.length === 0) return 0;
  const xs = poly.map(p => p[0]);
  return Math.max(...xs) - Math.min(...xs);
}

/** 폴리곤 중심점(단순 정점 평균, 개략 클리핑 방향 판별용) */
function polygonCentroidApprox(poly) {
  const n = poly.length;
  const sx = poly.reduce((s, p) => s + p[0], 0);
  const sy = poly.reduce((s, p) => s + p[1], 0);
  return [sx / n, sy / n];
}

/** 미터 평면좌표 → 위경도(도), llToMeters의 역변환 */
function metersToLL([x, y], lat0) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  return [x / mLon, y / mLat];
}

/** 같은 행(밴드) 안에서 이웃 동 사이에 두는 개략 이격거리 (소방·통행 목적, m) */
const IN_ROW_BUILDING_GAP = 6;

/**
 * 세대타입 목록(세대수 비율)에서 다음에 배치할 동에 배정할 타입을 가중 라운드로빈으로 고른다.
 * assignedCounts는 호출할 때마다 누적 갱신되는 배열(타입별 이미 배정된 동 수).
 */
function pickNextUnitType(unitTypeList, assignedCounts) {
  if (!unitTypeList || unitTypeList.length === 0) return { name: '유닛', supplyArea: 0 };
  const total = unitTypeList.reduce((s, t) => s + t.count, 0) || 1;
  let bestIdx = 0, bestScore = Infinity;
  unitTypeList.forEach((t, idx) => {
    const ratio = t.count / total;
    const score = ratio > 0 ? assignedCounts[idx] / ratio : Infinity;
    if (score < bestScore) { bestScore = score; bestIdx = idx; }
  });
  assignedCounts[bestIdx] = (assignedCounts[bestIdx] || 0) + 1;
  return unitTypeList[bestIdx];
}

/**
 * 주어진 적층방향(stackDir)·폭방향(widthDir)으로 폴리곤을 밴드(행)로 슬라이싱해
 * 각 행의 가용폭에 N호 조합 동을 옆으로 나란히 채울 수 있는 만큼 채운다
 * (폭이 넓은데 동 1개만 중앙에 배치하고 나머지를 낭비하지 않도록 함).
 * 동마다 입력된 세대타입(평형) 중 하나를 세대수 비율에 맞춰 배정하고, 동 내부는
 * 코어 구분 없이 세대 수만큼 균등 분할한 유닛 박스로 표시한다(카카오맵 단지 표기 스타일).
 * estimatePolygonLayout이 장변/단변 두 후보를 비교할 때 재사용.
 */
function layoutInDirection(poly, lat0, stackDir, widthDir, { bldgDepth, buildingGap, unitWidth, core, combos, unitTypeList }) {
  const origin = polygonCentroidApprox(poly);
  const toLocal = p => [
    (p[0] - origin[0]) * widthDir[0] + (p[1] - origin[1]) * widthDir[1],
    (p[0] - origin[0]) * stackDir[0] + (p[1] - origin[1]) * stackDir[1]
  ];
  const toWorld = (lx, ly) => [
    origin[0] + lx * widthDir[0] + ly * stackDir[0],
    origin[1] + lx * widthDir[1] + ly * stackDir[1]
  ];
  const toPathLL = (x0, x1, y0, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    .map(([lx, ly]) => metersToLL(toWorld(lx, ly), lat0));

  const localPoly = poly.map(toLocal);
  const ys = localPoly.map(p => p[1]);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const types = (unitTypeList && unitTypeList.length > 0) ? unitTypeList : [{ name: '유닛', supplyArea: 0, count: 1 }];
  const assignedCounts = types.map(() => 0);

  const rows = [];
  let y = minY;
  let guard = 0;
  while (y + bldgDepth <= maxY && guard < 200) {
    guard++;
    const band = clipPolygonByHalfplane(
      clipPolygonByHalfplane(localPoly, [0, y], [0, 1]),
      [0, y + bldgDepth], [0, -1]
    );
    if (band.length >= 3) {
      const w = polygonWidthX(band);

      // 가용폭에 코어+N호 동을 옆으로 나란히 채울 수 있는 만큼 채운다 (동 사이 IN_ROW_BUILDING_GAP 이격)
      const buildings = [];
      let usedWidth = 0;
      while (true) {
        const gapNeeded = buildings.length > 0 ? IN_ROW_BUILDING_GAP : 0;
        const remaining = w - usedWidth - gapNeeded;
        let picked = null;
        for (const N of combos) {
          const need = core + N * unitWidth;
          if (need <= remaining) { picked = { N, need }; break; }
        }
        if (!picked) break;
        buildings.push(picked);
        usedWidth += gapNeeded + picked.need;
        if (buildings.length > 20) break; // 안전장치
      }

      if (buildings.length > 0) {
        const xs = band.map(p => p[0]);
        const bandMinX = Math.min(...xs);
        let bx = bandMinX + (w - usedWidth) / 2; // 채워진 동들 전체를 가용폭 중앙에 배치
        const segments = [];
        const buildingLabels = [];
        let unitsThisRow = 0;

        buildings.forEach((b, i) => {
          if (i > 0) bx += IN_ROW_BUILDING_GAP;
          const unitType = pickNextUnitType(types, assignedCounts);
          // 코어 구분 없이 세대수만큼 균등 분할해서 유닛 박스로 표시 (카카오맵 단지 표기 스타일)
          const unitBoxWidth = b.need / b.N;
          let cx = bx;
          for (let u = 0; u < b.N; u++) {
            segments.push({ type: 'unit', pathLL: toPathLL(cx, cx + unitBoxWidth, y, y + bldgDepth) });
            cx += unitBoxWidth;
          }
          const centerLocal = [bx + b.need / 2, y + bldgDepth / 2];
          const areaPy = unitType.supplyArea > 0 ? Math.round(unitType.supplyArea * 0.3025) : null;
          buildingLabels.push({
            text: areaPy ? `${unitType.name} ${areaPy}평` : unitType.name,
            positionLL: metersToLL(toWorld(centerLocal[0], centerLocal[1]), lat0)
          });
          bx += b.need;
          unitsThisRow += b.N;
        });

        const outerStart = bandMinX + (w - usedWidth) / 2;
        rows.push({
          width: Math.round(w * 10) / 10,
          combo: buildings.map(b => b.N).join('+'), // 예: "5" 또는 여러 동이면 "5+5+4"
          buildingCount: buildings.length,
          unitsThisRow,
          segments,
          buildingLabels,
          pathLL: toPathLL(outerStart, outerStart + usedWidth, y, y + bldgDepth) // 전체 외곽(폴백 렌더용)
        });
      }
    }
    y += bldgDepth + buildingGap;
  }

  const totalUnitsPerFloorAllRows = rows.reduce((s, r) => s + r.unitsThisRow, 0);
  return { rows, totalUnitsPerFloorAllRows };
}

/**
 * 건축가능영역 폴리곤(1차, 도로·인접대지 이격 적용됨) 위에
 * ① 정북변 높이비례 추가 클리핑(정북일조 면제 변은 건너뜀) →
 * ② 정면방향 후보 결정(가장 긴 도로변에 평행 vs 그 수직방향, 도로가 없으면 정남향 vs 정동서향) →
 *    두 후보 모두 실제로 배치해보고 층당 세대수가 더 많이(=필요층수가 더 적게) 나오는 쪽을 채택
 *    ("장변 배치가 항상 유리한 건 아니다" — 폭이 매우 넓은 대지는 단변 배치가 더 효율적일 수 있음) →
 * ③ 코어폭+N호 조합(2~5호) 중 가장 낭비 없이 들어맞는 조합을, 밴드 폭이 아니라
 *    실제 건물폭(코어+N×세대폭)만큼만 중앙 배치하고 코어/유닛 구간을 구분
 * 순서로 층당 배치 가능 세대수와 필요 층수를 근사 산정한다.
 * 실제 3D 매싱이 아닌 사각형 기반 개략 근사치.
 */
function estimatePolygonLayout({
  buildableEnvelope, envelopeEdges, totalHouseholds,
  assumedHeight, northSetbackRatio, buildingGapRatio,
  standardBuildingDepth, standardUnitWidth, coreWidth, unitComboMode,
  unitTypeList
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

  // ── ① 정북변 추가 클리핑 (높이비례 이격, 정북일조 면제 변은 건너뜀) ──
  const northSetback = Math.max(1.5, assumedHeight * num(northSetbackRatio || 0.5));
  (envelopeEdges || []).filter(e => e.isNorth && !e.northExempt).forEach(edge => {
    const p1 = llToMeters(edge.p1, lat0);
    const p2 = llToMeters(edge.p2, lat0);
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy);
    if (len < 0.01) return;
    let nx = -dy / len, ny = dx / len;
    const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    const centroid = polygonCentroidApprox(poly);
    const toCentroid = [centroid[0] - mid[0], centroid[1] - mid[1]];
    if (nx * toCentroid[0] + ny * toCentroid[1] < 0) { nx = -nx; ny = -ny; } // nx,ny를 안쪽 방향으로 정렬
    const linePoint = [mid[0] + nx * northSetback, mid[1] + ny * northSetback];
    poly = clipPolygonByHalfplane(poly, linePoint, [nx, ny]);
  });

  const bldgDepth = num(standardBuildingDepth) || 15;
  const buildingGap = assumedHeight * num(buildingGapRatio || 0.5);

  if (poly.length < 3) {
    return {
      maxRows: 0, unitsPerFloor: 0, totalUnitsPerFloorAllRows: 0, requiredFloors: null,
      rows: [], northSetback, buildingGap, bldgDepth, noFit: true,
      frontSource: 'south', frontLabel: '정남향(기본)'
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
  const core = num(coreWidth) || 10;
  const combos = unitComboMode === 'auto' ? [5, 4, 3, 2] : [num(unitComboMode) || 4];
  const bandParams = { bldgDepth, buildingGap, unitWidth, core, combos, unitTypeList };

  const resultA = layoutInDirection(poly, lat0, stackDirA, widthDirA, bandParams);
  const resultB = layoutInDirection(poly, lat0, stackDirB, widthDirB, bandParams);

  // 층당 세대수가 더 많이 나오는(=필요층수가 더 적어지는) 쪽을 채택. 동률이면 도로 정면(장변) 우선.
  const useB = resultB.totalUnitsPerFloorAllRows > resultA.totalUnitsPerFloorAllRows;
  const chosen = useB ? resultB : resultA;
  const frontSource = frontSourceA; // 도로 유무 자체는 A 기준(장변 후보)으로 판단
  const orientationLabel = frontSourceA === 'road' ? '주도로 방향' : '정남향';
  const frontLabel = useB
    ? `${orientationLabel}의 단변 배치(배치효율 우선 자동 선택)`
    : `${orientationLabel}(장변 배치)`;

  const { rows, totalUnitsPerFloorAllRows } = chosen;
  const requiredFloors = totalUnitsPerFloorAllRows > 0
    ? Math.max(1, Math.ceil(totalHouseholds / totalUnitsPerFloorAllRows))
    : null;

  return {
    maxRows: rows.length,
    unitsPerFloor: rows.length > 0 ? Math.round(totalUnitsPerFloorAllRows / rows.length) : 0,
    totalUnitsPerFloorAllRows,
    requiredFloors,
    rows,
    northSetback, buildingGap, bldgDepth,
    frontSource, frontLabel, orientationSwapped: useB
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
    standardBuildingDepth = 15,      // 표준 동 깊이 (m)
    standardUnitWidth = 9,           // 표준 세대 폭 (m)
    coreWidth = 10,                  // 코어(계단실+승강기) 폭 (m)
    unitComboMode = 'auto'           // 'auto' | 2 | 3 | 4 | 5 (한 개 층당 호수 조합)
  } = inputs;

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
    legalParkingCount = Math.ceil(legalParkingCalc);
    parkingLegalSource = '주택건설기준 등에 관한 규정';
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
  const actualCareArea    = num(areaCareGround)    > 0 ? num(areaCareGround)    : 0;
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
  const undergroundTotal = parkingUnderArea + underAmenityTotal + machineRoomArea + num(storageArea);

  // 지상층 연면적 총계
  const aboveGroundTotal = groundSubtotal;
  const totalFloorArea = aboveGroundTotal + undergroundTotal;
  const farBaseArea = aboveGroundTotal;

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
        category: z.category
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
        sumGreen   += w * (z.category === '주거' ? 0.20 : 0.15);
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
        sumGreen += z.area * (z.category === '주거' ? 0.20 : 0.15);
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
    rawGreenRatio = (zoneObj.category === '주거') ? 0.20 : 0.15;
    zoneBreakdown.push({ name: zName, area: num(area), bcr: lim.bcrMax, far: lim.farMax, source: lim.source, category: zoneObj.category });
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
    rawGreenRatio = (zone.category === '주거') ? 0.20 : 0.15;
    if (zoneName) zoneBreakdown.push({ name: zoneName, area: landArea, bcr: lim.bcrMax, far: lim.farMax, source: lim.source });
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

  // 채광사선(인동간격) 비율: 준주거·근린상업지역은 4배 완화(0.25H), 그 외는 2배(0.5H) — 조례 직접입력이 최우선
  const relaxedGapZone = (zoneBreakdown || []).some(z => z.name === '준주거지역' || z.name === '근린상업지역');
  const effectiveBuildingGapRatio = (buildingGapRatio !== null && buildingGapRatio !== undefined && buildingGapRatio !== '')
    ? num(buildingGapRatio)
    : (relaxedGapZone ? 0.25 : 0.5);

  if (num(aboveFloorsManual) > 0) {
    aboveFloors = num(aboveFloorsManual);
    if (aboveFloors > legalAboveFloors) legalAboveFloorsExceeded = true;
  } else {
    // 예상 높이(층고 3m 가정)로 이격거리 1회 보정
    const assumedHeight = Math.max(1, legalAboveFloors) * 3;

    if (buildableEnvelope && totalHouseholds > 0) {
      // ② 건축가능영역 폴리곤 기반 배치
      layoutInfo = estimatePolygonLayout({
        buildableEnvelope, envelopeEdges, totalHouseholds, assumedHeight,
        northSetbackRatio, buildingGapRatio: effectiveBuildingGapRatio, standardBuildingDepth,
        standardUnitWidth, coreWidth, unitComboMode,
        unitTypeList: unitResults.filter(t => t.count > 0).map(t => ({ name: t.name, supplyArea: t.supplyArea, count: t.count }))
      });
      if (layoutInfo) layoutInfo.legalAboveFloors = legalAboveFloors;
    } else if (siteDimensions && siteDimensions.widthEW > 0 && siteDimensions.depthNS > 0 && totalHouseholds > 0) {
      // ② 폴백: 바운딩박스 근사 (건축가능영역 폴리곤이 없을 때)
      const { widthEW, depthNS } = siteDimensions;
      const unitsPerFloor = Math.max(1, Math.floor(widthEW / (num(standardUnitWidth) || 9)));
      const northSetback = Math.max(1.5, assumedHeight * num(northSetbackRatio || 0.5));
      const buildingGap = assumedHeight * effectiveBuildingGapRatio;
      const usableDepth = depthNS - northSetback;
      const bldgDepth = num(standardBuildingDepth) || 15;
      const maxRows = usableDepth > bldgDepth
        ? Math.max(1, Math.floor((usableDepth + buildingGap) / (bldgDepth + buildingGap)))
        : 1;
      const unitsPerFloorAllRows = maxRows * unitsPerFloor;
      const requiredFloors = unitsPerFloorAllRows > 0
        ? Math.max(1, Math.ceil(totalHouseholds / unitsPerFloorAllRows))
        : null;
      layoutInfo = { maxRows, unitsPerFloor, totalUnitsPerFloorAllRows: unitsPerFloorAllRows, requiredFloors, northSetback, buildingGap, legalAboveFloors, bldgDepth };
    }

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
  const estBuildingFootprint = aboveFloors > 0 ? housingGroundArea / aboveFloors : housingGroundArea;
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
    const storageSharePerUnit = num(storageArea) * shareRatio;
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
    storageArea: num(storageArea),
    aboveGroundTotal, undergroundTotal, totalFloorArea, farBaseArea,

    // 주차
    legalParkingCount, totalInstParking, plannedParking,
    groundParking: 0, undergroundParking,
    parkingUnderArea,
    parkingOk, expandParking, evParking, disabledParking,
    parkingLegalSource, parkingMode,

    // 건폐율·용적률
    estBuildingFootprint,
    calculatedBcr, bcrOk,
    calculatedFar, farOk,

    // 법정 의무 면적
    legalCommunityArea, actualCommunityArea, communityOk,
    legalSeniorArea, actualSeniorArea, seniorOk,
    legalKinderArea, actualKinderArea, kinderOk, kinderCapacity,
    legalOfficeArea, actualOfficeArea, officeOk,
    legalLibraryArea, actualLibraryArea, libraryOk,
    actualGuardArea, actualCareArea, actualCommunityUnder,
    totalAmenityArea, amenityPerHouseholdPy,
    communityExerciseRequired,
    legalPlaygroundArea, legalPlaygroundText,
    legalGreenArea, legalGreenRatio,
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

