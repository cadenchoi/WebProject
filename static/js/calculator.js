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
    // 층수: 직접 입력값(수동) 또는 null이면 자동 추정
    aboveFloorsManual = null, underFloorsManual = null,
    // 주차: 법정대수의 배수로 계획
    parkingMultiplier = 1.0,   // 법정대수의 몇 배
    parkingAreaPerSpace = 36,  // 주차 1면당 면적 (㎡), 기본 36㎡
    unitTypes = [], exclusiveRatio = 0.748,
    areaOfficeGround = 0, areaSeniorGround = 0, areaKinderGround = 0,
    areaLibraryGround = 0, areaCareGround = 0, areaCommunityUnder = 0,
    areaGuardGround = 0, shopArea = 0,
    parkingUndergroundArea = 0, storageArea = 0,
    // 부대복리시설 가중치(조정 배수), 기본 1.0
    amenityMultiplier = 1.0
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

  // ── 법정 주차대수 계산 (주택건설기준 등에 관한 규정) ────
  let legalParkingCalc = 0;
  unitResults.forEach(t => {
    if (t.areaEx <= 85) {
      legalParkingCalc += (t.count * t.areaEx) / 85;
    } else {
      legalParkingCalc += (t.count * t.areaEx) / 70;
    }
  });
  const legalParkingCount = Math.ceil(legalParkingCalc);

  // ── 계획 주차대수 (법정대수 × 배수) ─────────────────
  const plannedParking = Math.ceil(legalParkingCount * num(parkingMultiplier || 1.0));
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

  // ── 법정 시설별 의무면적 ────────────────────────────
  const legalSeniorArea = totalHouseholds >= 150 ? 50 + totalHouseholds * 0.1 : 0;
  const legalKinderArea = totalHouseholds >= 300 ? 30 + totalHouseholds * 0.05 * 4.29 : 0;
  let legalPlaygroundArea = 0;
  if (totalHouseholds >= 50) legalPlaygroundArea = Math.max(200, totalHouseholds * 0.5);

  // ── 부대복리시설 면적: 사용자 입력 or 법정 의무 자동채움 ──
  // amenityMultiplier: 법정 대비 배수 (1.0=법정, 1.2=법정×1.2)
  const mult = num(amenityMultiplier) || 1.0;
  const actualSeniorArea  = num(areaSeniorGround)  > 0 ? num(areaSeniorGround)  : Math.round(legalSeniorArea * mult);
  const actualKinderArea  = num(areaKinderGround)  > 0 ? num(areaKinderGround)  : Math.round(legalKinderArea * mult);
  const actualOfficeArea  = num(areaOfficeGround)  > 0 ? num(areaOfficeGround)  :
    (totalHouseholds >= 50 ? Math.round(20 + totalHouseholds * 0.05) : 0);
  const actualGuardArea   = num(areaGuardGround)   > 0 ? num(areaGuardGround)   :
    (totalHouseholds >= 50 ? Math.ceil(totalHouseholds / 100) * 3 : 0);
  const actualLibraryArea = num(areaLibraryGround) > 0 ? num(areaLibraryGround) : 0;
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

  // ── 지상 연면적 계산 ──────────────────────────────────
  const groundAmenityTotal = actualOfficeArea + actualSeniorArea + actualKinderArea +
    actualLibraryArea + actualCareArea + actualGuardArea;
  const underAmenityTotal = actualCommunityUnder;

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
  if (localGreenRatioOverride !== null && localGreenRatioOverride !== undefined) {
    legalGreenRatio = num(localGreenRatioOverride);
  }
  const legalGreenArea = usableLandArea * legalGreenRatio;



  // ── 층수 자동 추정 ────────────────────────────────────
  // 지상층수: (용적률 한도 × 대지면적) / 1개층 바닥면적
  // 1개층 바닥면적 ≈ 지상 연면적 / 층수 (순환 문제이므로 역산)
  // 방법: 공동주택 동별 표준 층별 면적을 단순 가정 (동당 600~1200㎡)
  let aboveFloors, underFloors;
  if (num(aboveFloorsManual) > 0) {
    aboveFloors = num(aboveFloorsManual);
  } else if (landArea > 0 && groundSubtotal > 0) {
    // 건폐율로 최대 건축면적 추정 → 층수 = 지상 연면적 / 건축면적
    const maxFootprint = landArea * (legalBcrMax / 100) * 0.85; // 15% 여유
    aboveFloors = maxFootprint > 0 ? Math.ceil(groundSubtotal / maxFootprint) : 1;
    aboveFloors = Math.max(1, Math.min(aboveFloors, 70)); // 1~70층 범위 제한
  } else {
    aboveFloors = 1;
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

  // ── 단위세대 면적 상세 (기타공용 배분) ────────────────
  const unitDetails = unitResults.map(t => {
    const shareRatio = totalExclusiveArea > 0 ? (t.areaEx / totalExclusiveArea) : 0;
    const amenitySharePerUnit = totalHouseholds > 0
      ? (groundAmenityTotal + underAmenityTotal) * shareRatio : 0;
    const parkingSharePerUnit = totalHouseholds > 0 && parkingUnderArea > 0
      ? parkingUnderArea * shareRatio : 0;
    const machineSharePerUnit = machineRoomArea * shareRatio;
    const etcShare = amenitySharePerUnit + parkingSharePerUnit + machineSharePerUnit;
    const contractArea = t.supplyArea + etcShare;
    const contractPy = contractArea * 0.3025;
    return {
      ...t,
      amenitySharePerUnit,
      parkingSharePerUnit,
      machineSharePerUnit,
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

    // 제84조 복수 용도지역 산정 방식
    multiZoneMethod,       // 'single' | 'weighted' | 'independent'
    independentZones,      // 독립 적용 시 각 구역별 허용 면적 상세

    // 면적 결과
    totalExclusiveArea,
    housingGroundArea,
    groundAmenityTotal, underAmenityTotal,
    machineRoomArea,
    shopArea: num(shopArea),
    aboveGroundTotal, undergroundTotal, totalFloorArea, farBaseArea,

    // 주차
    legalParkingCount, totalInstParking, plannedParking,
    groundParking: 0, undergroundParking,
    parkingUnderArea,
    parkingOk, expandParking, evParking, disabledParking,

    // 건폐율·용적률
    estBuildingFootprint,
    calculatedBcr, bcrOk,
    calculatedFar, farOk,

    // 법정 의무 면적
    legalCommunityArea, actualCommunityArea, communityOk,
    legalSeniorArea, actualSeniorArea, seniorOk,
    legalKinderArea, actualKinderArea, kinderOk,
    legalPlaygroundArea,
    legalGreenArea, legalGreenRatio,

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

