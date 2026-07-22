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

/** 같은 행(밴드) 안에서 이웃 동 사이에 두는 개략 이격거리 (소방·통행 목적, m) */
const IN_ROW_BUILDING_GAP = 6;

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
 * L자형·타워형 전략에서 후보 동의 외곽 꼭짓점들이 건축가능영역 내부에 있는지 확인하는 데 쓴다.
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

      // 가용폭에 코어+N호 동을 옆으로 나란히 채울 수 있는 만큼 채운다 (동 사이 IN_ROW_BUILDING_GAP 이격).
      // 동 하나는 세대타입 하나로 채워지므로(아래 pickNextUnitType 1회/동), 폭 적합 여부를 판단할 때부터
      // 그 동에 배정될 타입의 공급면적 비례 폭(unitWidth)을 미리 조회해서 써야 실제 그려지는 폭과
      // 어긋나지 않는다 — 그래서 맞는 조합을 찾는 즉시 타입 배정도 함께 확정(mutate)한다.
      const buildings = [];
      let usedWidth = 0;
      while (true) {
        const gapNeeded = buildings.length > 0 ? IN_ROW_BUILDING_GAP : 0;
        const remaining = w - usedWidth - gapNeeded;
        const candidateType = peekNextUnitType(types, assignedCounts);
        const typeWidth = candidateType.unitWidth || unitWidth;
        let picked = null;
        for (const N of combos) {
          const need = core + N * typeWidth;
          if (need <= remaining) { picked = { N, need, typeWidth }; break; }
        }
        if (!picked) break;
        picked.unitType = pickNextUnitType(types, assignedCounts); // 위에서 미리 본 타입과 동일(상태 불변 구간)
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
        let footprintAreaM2 = 0;

        buildings.forEach((b, i) => {
          if (i > 0) bx += IN_ROW_BUILDING_GAP;
          const unitType = b.unitType;
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
          footprintAreaM2 += bldgDepth * b.need;
        });

        const outerStart = bandMinX + (w - usedWidth) / 2;
        rows.push({
          width: Math.round(w * 10) / 10,
          combo: buildings.map(b => b.N).join('+'), // 예: "5" 또는 여러 동이면 "5+5+4"
          buildingCount: buildings.length,
          unitsThisRow,
          segments,
          buildingLabels,
          pathLL: toPathLL(outerStart, outerStart + usedWidth, y, y + bldgDepth), // 전체 외곽(폴백 렌더용)
          footprintAreaM2
        });
      }
    }
    y += bldgDepth + buildingGap;
  }

  const totalUnitsPerFloorAllRows = rows.reduce((s, r) => s + r.unitsThisRow, 0);
  const footprintAreaM2 = rows.reduce((s, r) => s + (r.footprintAreaM2 || 0), 0);
  return { rows, totalUnitsPerFloorAllRows, footprintAreaM2 };
}

/**
 * 목표 총 세대수 N을 두 날개(N1+N2=N, 각 날개 최소 1세대)로 나누는 분할 후보들을
 * 균형 분할(반반에 가까운 순서)부터 반환한다. "2호"를 고르면 두 날개를 합쳐 정확히
 * 2세대(1+1)가 되도록 하기 위한 것 — 날개마다 독립적으로 2세대씩 배정해 결과적으로
 * 4세대(2+2)가 되어버리는 일이 없게 한다.
 */
function splitTotalIntoWings(N) {
  const candidates = [];
  for (let n1 = 1; n1 <= N - 1; n1++) candidates.push([n1, N - n1]);
  candidates.sort((a, b) => Math.abs(a[0] - a[1]) - Math.abs(b[0] - b[1]));
  return candidates;
}

/**
 * L자형 전략: 두 날개(날개A=폭 방향, 날개B=적층 방향)가 직각으로 꺾인 동을
 * 격자 형태의 후보 앵커점마다 시도한다. 호수 조합(예: 2/3/4/5호)은 "그 동의 총 세대수"를
 * 의미하므로, 큰 호수부터 순서대로 시도하되 각 호수는 반드시 N1+N2=N으로 분할해
 * (균형 분할 우선) 외곽 6개 꼭짓점이 건축가능영역 내부에 들어가는 첫 조합을 채택한다.
 * layoutInDirection과 동일한 rows 스키마(segments/buildingLabels/pathLL)로 반환해
 * drawLayoutPreview가 별도 처리 없이 그대로 그릴 수 있게 한다.
 */
function estimateLShapeLayout(poly, lat0, stackDir, widthDir, { bldgDepth, buildingGap, unitWidth, core, combos, unitTypeList }) {
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
  const xs = localPoly.map(p => p[0]), ys = localPoly.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const types = (unitTypeList && unitTypeList.length > 0) ? unitTypeList : [{ name: '유닛', supplyArea: 0, count: 1 }];
  const assignedCounts = types.map(() => 0);
  const targetTotals = [...combos].sort((a, b) => b - a); // 세대수 많은 호수부터 시도

  // 그리드 셀 크기(안전 여백)는 실제 배정될 수 있는 타입 중 가장 넓은 타입 기준으로 잡아야
  // 한다 — 공급면적 비례 폭 도입으로 타입별 폭이 균일하지 않으므로, 평균(unitWidth)보다
  // 넓은 타입이 배정돼도 다음 앵커와 겹치지 않도록 보수적으로 계산한다.
  const maxTypeWidth = Math.max(unitWidth, ...types.map(t => t.unitWidth || unitWidth));
  // 그리드 셀 크기는 "한 날개가 가질 수 있는 최대 길이"(가장 큰 호수를 [N-1, 1]로 나눴을 때) 기준
  const maxWingUnits = Math.max(1, Math.max(...targetTotals) - 1);
  const maxWing = core + maxWingUnits * maxTypeWidth;
  const cellSize = maxWing + buildingGap; // 다음 동과의 간격 = 장변(채광창) 간 인동간격

  const rows = [];
  let guardY = 0;
  for (let ay = minY; ay + bldgDepth <= maxY && guardY < 100; ay += cellSize, guardY++) {
    let guardX = 0;
    for (let ax = minX; ax + bldgDepth <= maxX && guardX < 100; ax += cellSize, guardX++) {
      // 이 동 전체가 세대타입 하나로 채워지므로(아래 pickNextUnitType 1회), 배정될 타입을
      // 미리 조회해 그 타입의 공급면적 비례 폭으로 L1/L2를 계산한다 — 실제 그려지는 폭과 일치시키기 위함.
      const candidateType = peekNextUnitType(types, assignedCounts);
      const typeWidth = candidateType.unitWidth || unitWidth;
      let best = null;
      for (const N of targetTotals) {
        for (const [N1, N2] of splitTotalIntoWings(N)) {
          const L1 = core + N1 * typeWidth;
          const L2 = core + N2 * typeWidth;
          const verts = [
            [ax, ay], [ax + L1, ay], [ax + L1, ay + bldgDepth],
            [ax + bldgDepth, ay + bldgDepth], [ax + bldgDepth, ay + L2], [ax, ay + L2]
          ];
          if (verts.every(v => pointInPolygon(v, localPoly))) { best = { N, N1, N2, L1, L2 }; break; }
        }
        if (best) break;
      }
      if (!best) continue;
      const { N, N1, N2, L1, L2 } = best;
      const segments = [];
      const unitType = pickNextUnitType(types, assignedCounts); // 위에서 미리 본 타입과 동일(상태 불변 구간)

      // 날개A: 폭 방향으로 N1개 균등분할
      const boxA = L1 / N1;
      for (let u = 0; u < N1; u++) {
        segments.push({ type: 'unit', pathLL: toPathLL(ax + u * boxA, ax + (u + 1) * boxA, ay, ay + bldgDepth) });
      }
      // 날개B: 코너(모서리 정사각형)는 날개A가 이미 표현하므로 그 이후 구간만 N2개로 분할
      const boxB = (L2 - bldgDepth) / N2;
      for (let u = 0; u < N2; u++) {
        segments.push({ type: 'unit', pathLL: toPathLL(ax, ax + bldgDepth, ay + bldgDepth + u * boxB, ay + bldgDepth + (u + 1) * boxB) });
      }

      const areaPy = unitType.supplyArea > 0 ? Math.round(unitType.supplyArea * 0.3025) : null;
      const buildingLabels = [{
        text: areaPy ? `${unitType.name} ${areaPy}평 (L자 ${N}호)` : `${unitType.name} (L자 ${N}호)`,
        positionLL: metersToLL(toWorld(ax + L1 / 2, ay + bldgDepth / 2), lat0)
      }];

      rows.push({
        width: Math.round(Math.max(L1, L2) * 10) / 10,
        combo: `L${N}(${N1}+${N2})`,
        buildingCount: 1,
        unitsThisRow: N1 + N2,
        segments,
        buildingLabels,
        pathLL: toPathLL(ax, ax + Math.max(L1, bldgDepth), ay, ay + Math.max(L2, bldgDepth)),
        footprintAreaM2: bldgDepth * (L1 + L2 - bldgDepth) // 코너(모서리 정사각형) 중복 제외
      });
    }
  }

  const totalUnitsPerFloorAllRows = rows.reduce((s, r) => s + r.unitsThisRow, 0);
  const footprintAreaM2 = rows.reduce((s, r) => s + (r.footprintAreaM2 || 0), 0);
  return { rows, totalUnitsPerFloorAllRows, footprintAreaM2 };
}

/**
 * 타워형 전략: 코어 1개를 세대들이 감싸는 컴팩트한 점형 배치.
 * 판상형의 "여러 행"을 코어 하나 옆으로 바짝 압축한 것과 같은 방식으로, 선택된 호수 조합
 * (2~5호 = 그 동의 총 세대수)만큼을 앞줄(ceil(N/2))·뒷줄(floor(N/2)) 두 줄로 나눠 배치한다.
 * 앞줄·뒷줄은 서로 반대 방향을 바라보는 장변(채광창)이므로 다음 타워와는 판상형의 행간
 * 인동간격과 동일하게 buildingGap만큼 이격하고, 같은 타워 내부의 세대끼리는 측벽(단변)으로
 * 맞붙어 간격 없이 배치한다. 호수 조합을 반영하지 않고 늘 4세대(2×2)로 고정하던 이전 로직을
 * 대체해, "호수 조합" 설정이 판상형·L자형과 동일하게 타워형에도 적용되도록 한다.
 */
function estimateTowerLayout(poly, lat0, stackDir, widthDir, { bldgDepth, buildingGap, unitWidth, core, combos, unitTypeList }) {
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
  const xs = localPoly.map(p => p[0]), ys = localPoly.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const types = (unitTypeList && unitTypeList.length > 0) ? unitTypeList : [{ name: '유닛', supplyArea: 0, count: 1 }];
  const assignedCounts = types.map(() => 0);
  const targetTotals = [...combos].sort((a, b) => b - a); // 세대수 많은 호수부터 시도

  // 타워 풋프린트는 "폭 방향 최대 ceil(N/2)세대 + 코어" x "적층 방향 2줄(건물 깊이 기준)".
  // 실제 세대 프로포션(세대폭 >> 건물깊이)을 반영해 폭은 넓고 깊이는 얕게 잡는다.
  // 그리드 안전 여백은 L자형과 동일한 이유로 가장 넓은 타입 기준으로 잡는다.
  const maxTypeWidth = Math.max(unitWidth, ...types.map(t => t.unitWidth || unitWidth));
  const maxFrontUnits = Math.ceil(Math.max(...targetTotals) / 2);
  const towerWidthMax = core + maxFrontUnits * maxTypeWidth;
  const towerDepth = 2 * bldgDepth;
  const stepX = towerWidthMax + buildingGap;
  const stepY = towerDepth + buildingGap;

  const rows = [];
  let guardY = 0;
  for (let cy = minY; cy + towerDepth <= maxY && guardY < 200; cy += stepY, guardY++) {
    let guardX = 0;
    for (let cx = minX; cx + towerWidthMax <= maxX && guardX < 200; cx += stepX, guardX++) {
      // 이 타워 전체가 세대타입 하나로 채워지므로(아래 pickNextUnitType 1회), 배정될 타입을
      // 미리 조회해 그 타입의 공급면적 비례 폭으로 towerWidth를 계산한다.
      const candidateType = peekNextUnitType(types, assignedCounts);
      const typeWidth = candidateType.unitWidth || unitWidth;
      let best = null;
      for (const N of targetTotals) {
        const front = Math.ceil(N / 2), back = Math.floor(N / 2);
        const towerWidth = core + Math.max(front, back) * typeWidth;
        const corners = [[cx, cy], [cx + towerWidth, cy], [cx + towerWidth, cy + towerDepth], [cx, cy + towerDepth]];
        if (corners.every(c => pointInPolygon(c, localPoly))) { best = { N, front, back, towerWidth }; break; }
      }
      if (!best) continue;
      const { N, front, back, towerWidth } = best;

      const unitType = pickNextUnitType(types, assignedCounts); // 위에서 미리 본 타입과 동일(상태 불변 구간)
      const segments = [];
      const boxFront = towerWidth / front;
      for (let u = 0; u < front; u++) {
        segments.push({ type: 'unit', pathLL: toPathLL(cx + u * boxFront, cx + (u + 1) * boxFront, cy + bldgDepth, cy + towerDepth) });
      }
      if (back > 0) {
        const boxBack = towerWidth / back;
        for (let u = 0; u < back; u++) {
          segments.push({ type: 'unit', pathLL: toPathLL(cx + u * boxBack, cx + (u + 1) * boxBack, cy, cy + bldgDepth) });
        }
      }

      const areaPy = unitType.supplyArea > 0 ? Math.round(unitType.supplyArea * 0.3025) : null;
      const buildingLabels = [{
        text: areaPy ? `${unitType.name} ${areaPy}평 (타워 ${N}호)` : `${unitType.name} (타워 ${N}호)`,
        positionLL: metersToLL(toWorld(cx + towerWidth / 2, cy + towerDepth / 2), lat0)
      }];

      rows.push({
        width: Math.round(towerWidth * 10) / 10,
        combo: `${N}(타워${front}+${back})`,
        buildingCount: 1,
        unitsThisRow: N,
        segments,
        buildingLabels,
        pathLL: toPathLL(cx, cx + towerWidth, cy, cy + towerDepth),
        footprintAreaM2: towerWidth * towerDepth
      });
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
 * ③ 코어폭+N호 조합(2~5호) 중 가장 낭비 없이 들어맞는 조합을, 밴드 폭이 아니라
 *    실제 건물폭(코어+N×세대폭)만큼만 중앙 배치하고 코어/유닛 구간을 구분
 * 순서로 층당 배치 가능 세대수와 필요 층수를 근사 산정한다.
 * 실제 3D 매싱이 아닌 사각형 기반 개략 근사치.
 */
function estimatePolygonLayout({
  buildableEnvelope, envelopeEdges, totalHouseholds,
  assumedHeight, northSetbackRatio, buildingGapRatio,
  standardBuildingDepth, standardUnitWidth, coreWidth, unitComboMode,
  unitTypeList, buildingShapeMode
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
      frontSource: 'south', frontLabel: '정남향(기본)',
      buildingShape: null, strategyComparison: []
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
  // 세대타입별 공급면적 비례 폭을 미리 붙여서 넘긴다 — 84/59 등 타입이 섞여도 실제 크기 차이가
  // 유닛 박스 폭에 반영되도록(이전에는 모든 타입이 동일한 표준폭이었음).
  const unitTypeListScaled = attachPerTypeUnitWidths(unitTypeList, unitWidth);
  const bandParams = { bldgDepth, buildingGap, unitWidth, core, combos, unitTypeList: unitTypeListScaled };

  const resultA = layoutInDirection(poly, lat0, stackDirA, widthDirA, bandParams);
  const resultB = layoutInDirection(poly, lat0, stackDirB, widthDirB, bandParams);

  // 층당 세대수가 더 많이 나오는(=필요층수가 더 적어지는) 쪽을 채택. 동률이면 도로 정면(장변) 우선.
  const useB = resultB.totalUnitsPerFloorAllRows > resultA.totalUnitsPerFloorAllRows;
  const rectResult = useB ? resultB : resultA;
  const frontSource = frontSourceA; // 도로 유무 자체는 A 기준(장변 후보)으로 판단
  const orientationLabel = frontSourceA === 'road' ? '주도로 방향' : '정남향';
  const rectLabel = useB
    ? `${orientationLabel}의 단변 배치`
    : `${orientationLabel}(장변 배치)`;

  // ── ③ 판상형/L자형/타워형 세 전략을 모두 계산해 층당 세대수(=밀도)가 가장 높은 형상을 채택 ──
  // L자형·타워형도 판상형과 동일하게 장변/단변 두 방향 후보를 모두 계산해 더 나은 쪽을 채택한다
  // (장변=세대 채광창이 있는 면=인동간격 buildingGap이 적용되는 방향, 단변=측벽=동 사이 최소
  // 이격만 있으면 되는 방향 — 어느 쪽으로 돌렸을 때 이 조건을 만족하며 더 조밀하게 들어가는지 비교).
  const lShapeResultA = estimateLShapeLayout(poly, lat0, stackDirA, widthDirA, bandParams);
  const lShapeResultB = estimateLShapeLayout(poly, lat0, stackDirB, widthDirB, bandParams);
  const lShapeSwapped = lShapeResultB.totalUnitsPerFloorAllRows > lShapeResultA.totalUnitsPerFloorAllRows;
  const lShapeResult = lShapeSwapped ? lShapeResultB : lShapeResultA;

  const towerResultA = estimateTowerLayout(poly, lat0, stackDirA, widthDirA, bandParams);
  const towerResultB = estimateTowerLayout(poly, lat0, stackDirB, widthDirB, bandParams);
  const towerSwapped = towerResultB.totalUnitsPerFloorAllRows > towerResultA.totalUnitsPerFloorAllRows;
  const towerResult = towerSwapped ? towerResultB : towerResultA;

  const floorsFor = units => units > 0 ? Math.max(1, Math.ceil(totalHouseholds / units)) : null;
  const strategies = [
    { shape: '판상형', label: rectLabel, rows: rectResult.rows, totalUnitsPerFloorAllRows: rectResult.totalUnitsPerFloorAllRows, footprintAreaM2: rectResult.footprintAreaM2, orientationSwapped: useB },
    { shape: 'L자형', label: 'L자형 배치', rows: lShapeResult.rows, totalUnitsPerFloorAllRows: lShapeResult.totalUnitsPerFloorAllRows, footprintAreaM2: lShapeResult.footprintAreaM2, orientationSwapped: lShapeSwapped },
    { shape: '타워형', label: '타워형 배치', rows: towerResult.rows, totalUnitsPerFloorAllRows: towerResult.totalUnitsPerFloorAllRows, footprintAreaM2: towerResult.footprintAreaM2, orientationSwapped: towerSwapped }
  ].map(s => ({ ...s, requiredFloors: floorsFor(s.totalUnitsPerFloorAllRows) }));

  let chosenStrategy;
  if (buildingShapeMode && buildingShapeMode !== 'auto') {
    chosenStrategy = strategies.find(s => s.shape === buildingShapeMode) || strategies[0];
  } else {
    // 필요층수가 가장 적은(=층당 세대를 가장 밀도 높게 채우는=용적률 활용도가 가장 높은) 전략을 채택. 동률/전부 미배치면 판상형 우선.
    chosenStrategy = strategies.reduce((best, s) => {
      if (s.totalUnitsPerFloorAllRows <= 0) return best;
      if (!best) return s;
      return s.requiredFloors < best.requiredFloors ? s : best;
    }, null) || strategies[0];
  }

  const frontLabel = chosenStrategy.shape === '판상형'
    ? (chosenStrategy.orientationSwapped ? `${rectLabel}(배치효율 우선 자동 선택)` : rectLabel)
    : `${chosenStrategy.label}(배치효율 우선 자동 선택)`;

  const { rows, totalUnitsPerFloorAllRows, requiredFloors, footprintAreaM2 } = chosenStrategy;

  return {
    maxRows: rows.length,
    unitsPerFloor: rows.length > 0 ? Math.round(totalUnitsPerFloorAllRows / rows.length) : 0,
    totalUnitsPerFloorAllRows,
    requiredFloors,
    rows,
    footprintAreaM2, // 실제 배치된 동들의 폭×깊이 합산 — calculate()의 건폐율 산정에 사용(추정치 아님)
    northSetback, buildingGap, bldgDepth,
    frontSource, frontLabel, orientationSwapped: chosenStrategy.orientationSwapped,
    buildingShape: chosenStrategy.shape,
    strategyComparison: strategies.map(s => ({
      shape: s.shape, unitsPerFloor: s.totalUnitsPerFloorAllRows, requiredFloors: s.requiredFloors
    }))
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
    coreWidth = 10,                  // 코어(계단실+승강기) 폭 (m)
    unitComboMode = 'auto',          // 'auto' | 2 | 3 | 4 | 5 (한 개 층당 호수 조합)
    buildingShapeMode = 'auto',      // 'auto' | '판상형' | 'L자형' | '타워형' (자동=용적률 활용도 최대 전략 채택)
    // 층별 층고 (mm) — 인동간격·채광사선·정북이격의 예상높이 산정에 사용, 미입력 시 2900mm
    floorHeight1Mm = null, floorHeight2Mm = null, floorHeight3Mm = null, floorHeightTypicalMm = null
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

  // 표준 동깊이/세대폭은 전용 84㎡ 기준값 — 실제 평균 전용면적 비율로 비례 스케일
  const avgAreaEx = totalHouseholds > 0 ? totalExclusiveArea / totalHouseholds : 84;
  const areaScale = avgAreaEx / 84;
  const scaledBuildingDepth = (num(standardBuildingDepth) || 10) * areaScale;
  const scaledUnitWidth = (num(standardUnitWidth) || 15) * areaScale;

  if (num(aboveFloorsManual) > 0) {
    aboveFloors = num(aboveFloorsManual);
    if (aboveFloors > legalAboveFloors) legalAboveFloorsExceeded = true;
  } else {
    // 예상 높이: 1~3층 및 기준층 층고(입력 없으면 2900mm)를 실제 층수만큼 합산해 이격거리 산정에 사용
    const assumedHeight = computeAssumedHeightM(legalAboveFloors, floorHeight1Mm, floorHeight2Mm, floorHeight3Mm, floorHeightTypicalMm);

    if (buildableEnvelope && totalHouseholds > 0) {
      // ② 건축가능영역 폴리곤 기반 배치
      layoutInfo = estimatePolygonLayout({
        buildableEnvelope, envelopeEdges, totalHouseholds, assumedHeight,
        northSetbackRatio, buildingGapRatio: effectiveBuildingGapRatio,
        standardBuildingDepth: scaledBuildingDepth, standardUnitWidth: scaledUnitWidth,
        coreWidth, unitComboMode, buildingShapeMode,
        unitTypeList: unitResults.filter(t => t.count > 0).map(t => ({ name: t.name, supplyArea: t.supplyArea, count: t.count }))
      });
      if (layoutInfo) layoutInfo.legalAboveFloors = legalAboveFloors;
    } else if (siteDimensions && siteDimensions.widthEW > 0 && siteDimensions.depthNS > 0 && totalHouseholds > 0) {
      // ② 폴백: 바운딩박스 근사 (건축가능영역 폴리곤이 없을 때)
      const { widthEW, depthNS } = siteDimensions;
      const unitsPerFloor = Math.max(1, Math.floor(widthEW / scaledUnitWidth));
      const northSetback = Math.max(1.5, assumedHeight * num(northSetbackRatio || 0.5));
      const buildingGap = assumedHeight * effectiveBuildingGapRatio;
      const usableDepth = depthNS - northSetback;
      const bldgDepth = scaledBuildingDepth;
      const maxRows = usableDepth > bldgDepth
        ? Math.max(1, Math.floor((usableDepth + buildingGap) / (bldgDepth + buildingGap)))
        : 1;
      const unitsPerFloorAllRows = maxRows * unitsPerFloor;
      const requiredFloors = unitsPerFloorAllRows > 0
        ? Math.max(1, Math.ceil(totalHouseholds / unitsPerFloorAllRows))
        : null;
      layoutInfo = { maxRows, unitsPerFloor, totalUnitsPerFloorAllRows: unitsPerFloorAllRows, requiredFloors, northSetback, buildingGap, legalAboveFloors, bldgDepth };
    }

    if (layoutInfo) { layoutInfo.assumedHeight = assumedHeight; layoutInfo.areaScale = areaScale; }

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
    estBuildingFootprint, bcrIsGeometric,
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

