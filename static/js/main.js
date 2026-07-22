/**
 * main.js
 * ArchOverview 앱 코디네이터
 * 위자드 폼 ↔ 계산 엔진 ↔ 지도 ↔ 리포트 렌더링을 연결
 */

/* ═══════════════════════════════════════════════════
   1. 앱 상태 & 초기화
   ═══════════════════════════════════════════════════ */
const state = {
  unitTypes: [
    { name: '84타입', area: 84.99, count: 0 },
    { name: '102타입', area: 102.99, count: 0 }
  ],
  siteDimensions: null,     // 구역계 확정 시 대지 폴리곤에서 추출한 { widthEW, depthNS } (건축가능영역 조회 실패 시 폴백용)
  mergedGeom: null,         // 선택된 필지들을 합친 GeoJSON (도로/인접대지 후퇴거리 변경 시 재조회용)
  buildableEnvelope: null,  // /api/buildable-envelope 응답의 1차 건축가능영역 GeoJSON
  envelopeEdges: null       // 변별 도로/인접대지 분류 [{index,type,isNorth,p1,p2}, ...]
};

let lastResult = null; // 가장 최근 calculate() 결과 (세대당 목표 평 조절 기능의 역산용)

document.addEventListener('DOMContentLoaded', () => {
  initZoneDropdown();
  renderUnitTypes();
  initMap('kakao-map', onMapLocationSelect);
  bindEvents();
  setTodayDate();
  recalculate();
});

/* ═══════════════════════════════════════════════════
   2. 용도지역 드롭다운 초기화
   ═══════════════════════════════════════════════════ */
function initZoneDropdown() {
  const sel = document.getElementById('zone-select');
  if (sel) sel.addEventListener('change', onZoneChange);
}

function onZoneChange() {
  recalculate();
}

/* ═══════════════════════════════════════════════════
   3. 세대 타입 UI 렌더링
   ═══════════════════════════════════════════════════ */
function renderUnitTypes() {
  const container = document.getElementById('unit-types-container');
  container.innerHTML = '';

  state.unitTypes.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'unit-type-row';
    row.innerHTML = `
      <div class="field-group">
        <label class="field-label" style="font-size:0.7rem;">타입명</label>
        <input type="text" class="field-input type-name-input" data-idx="${i}" data-key="name"
               value="${t.name}" placeholder="예: 84타입">
      </div>
      <div class="field-group">
        <label class="field-label" style="font-size:0.7rem;">전용면적 (㎡)</label>
        <input type="number" class="field-input" data-idx="${i}" data-key="area"
               value="${t.area}" step="0.01" min="0" placeholder="84.99">
      </div>
      <div class="field-group">
        <label class="field-label" style="font-size:0.7rem;">세대수</label>
        <input type="number" class="field-input" data-idx="${i}" data-key="count"
               value="${t.count}" min="0" placeholder="0">
      </div>
      <button class="btn-remove-type" data-idx="${i}" title="삭제">
        <i class="fa-solid fa-xmark"></i>
      </button>
    `;
    container.appendChild(row);
  });

  // 이벤트 재바인딩
  container.querySelectorAll('.field-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.idx);
      const key = e.target.dataset.key;
      const raw = e.target.value;
      state.unitTypes[idx][key] = (key === 'name') ? raw : parseFloat(raw) || 0;
      recalculate();
    });
  });
  container.querySelectorAll('.btn-remove-type').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.currentTarget.dataset.idx);
      if (state.unitTypes.length <= 1) return;
      state.unitTypes.splice(idx, 1);
      renderUnitTypes();
      recalculate();
    });
  });
}

/* ═══════════════════════════════════════════════════
   4. 지도 클릭 → 주소 자동 입력 콜백 (다중 필지 선택 대응)
   ═══════════════════════════════════════════════════ */
function onMapLocationSelect({ lat, lng, displayName, address, parcel }) {
  // 주소는 카카오 Geocoder 결과를 폼에 입력해두되,
  // 대지면적 합산은 '구역계 확정' 버튼 클릭 시 수행합니다.
  const locInput = document.getElementById('location-text');
  const fullAddress = address?.address?.address_name || address?.road_address?.address_name || displayName;
  if (fullAddress) {
    locInput.value = fullAddress;
  }
}

/**
 * state.mergedGeom(선택된 필지 합친 폴리곤)이 있으면 현재 폼의 도로/인접대지 후퇴거리로
 * /api/buildable-envelope를 (재)조회해 state.buildableEnvelope/envelopeEdges를 갱신하고 재계산한다.
 * 구역계 확정 시, 그리고 후퇴거리 입력값이 바뀔 때 호출된다.
 */
function refetchBuildableEnvelope() {
  if (!state.mergedGeom || typeof fetchBuildableEnvelope !== 'function') return;
  // 도로 후퇴거리를 사용자가 직접 입력하지 않았으면 null로 보내 서버가 실제 도로폭 실측 기반으로 자동계산하게 한다
  const roadSetbackRaw = document.getElementById('local-road-setback')?.value;
  const roadSetback = roadSetbackRaw ? parseFloat(roadSetbackRaw) : null;
  const adjacentSetback = parseFloat(document.getElementById('local-adjacent-setback')?.value) || 1.5;
  fetchBuildableEnvelope(state.mergedGeom, roadSetback, adjacentSetback, (envelope, edges) => {
    state.buildableEnvelope = envelope;
    state.envelopeEdges = edges;
    recalculate();
  });
}

/** 자동 입력 시 파란 점멸 효과 */
function flashInput(el) {
  el.classList.add('auto-filled');
  setTimeout(() => el.classList.remove('auto-filled'), 2500);
}

/* ═══════════════════════════════════════════════════
   5. 주소 검색 기능
   ═══════════════════════════════════════════════════ */
let searchDebounce = null;

function bindSearchEvents() {
  const input = document.getElementById('search-input');
  const btn = document.getElementById('btn-search');
  const results = document.getElementById('search-results');

  async function doSearch() {
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; return; }

    showLoading(true);
    const data = await searchAddress(q);
    showLoading(false);

    results.innerHTML = '';
    if (!data || data.length === 0) {
      results.innerHTML = '<div class="search-result-item" style="color:var(--text-muted);">검색 결과가 없습니다</div>';
      return;
    }

    data.forEach(item => {
      const el = document.createElement('div');
      el.className = 'search-result-item';
      const name = item.name || item.display_name.split(',')[0];
      const addr = item.display_name;
      el.innerHTML = `<div class="result-name">${name}</div><div class="result-addr">${addr}</div>`;
      el.addEventListener('click', () => {
        const lat = parseFloat(item.lat);
        const lon = parseFloat(item.lon);
        flyToLocation(lat, lon, name);
        document.getElementById('location-text').value = item.display_name;
        results.innerHTML = '';
        input.value = '';

        // 탭을 지도 탭으로 전환
        switchTab('map');
        recalculate();
      });
      results.appendChild(el);
    });
  }

  btn.addEventListener('click', doSearch);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });
  input.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(doSearch, 500);
  });

  // 외부 클릭 시 결과 닫기
  document.addEventListener('click', e => {
    if (!e.target.closest('.field-group')) {
      results.innerHTML = '';
    }
  });
}

/* ═══════════════════════════════════════════════════
   6. 이벤트 전체 바인딩
   ═══════════════════════════════════════════════════ */
function bindEvents() {
  // 주소 검색
  bindSearchEvents();

  // 구역계 확정 버튼 (다중 필지 대지면적 합산 + 용도지역 조회)
  const btnConfirm = document.getElementById('btn-confirm-boundary');
  if (btnConfirm) {
    btnConfirm.addEventListener('click', () => {
      const data = getSelectedParcelsData();
      if (!data) {
        alert('선택된 필지가 없습니다. 지도에서 필지를 클릭해주세요.');
        return;
      }
      
      // 대지면적 입력
      const landAreaInput = document.getElementById('land-area');
      landAreaInput.value = data.totalAreaM2;
      flashInput(landAreaInput);

      // 대지 치수(개략 배치 시뮬레이션 폴백용) 저장
      state.siteDimensions = data.siteDimensions || null;
      state.mergedGeom = data.mergedGeom || null;
      state.buildableEnvelope = null;
      state.envelopeEdges = null;

      // 주소 입력
      if (data.jibuns) {
        document.getElementById('location-text').value = data.jibuns;
      }

      // 용도지역 자동 지정 및 혼합지역 처리
      if (data.zonesMap) {
        const zoneSelect = document.getElementById('zone-select');
        const zoneDisplay = document.getElementById('zone-display');
        
        const activeZones = Object.keys(data.zonesMap).filter(z => z !== '미지정' && z !== 'null' && z !== null && z !== '');
        
        if (activeZones.length > 0) {
          // zone-display에 모든 용도지역 표시
          zoneDisplay.value = activeZones.join(', ');
          zoneDisplay.dataset.zonesMap = JSON.stringify(data.zonesMap);
          
          if (activeZones.length > 1) {
            zoneSelect.value = '혼합지역';
          } else {
            zoneSelect.value = activeZones[0];
          }
          
          // 조례 입력값 초기화하여 자동 계산값이 바인딩되도록 유도
          document.getElementById('local-bcr').value = '';
          document.getElementById('local-far').value = '';
          flashInput(zoneDisplay);
        } else {
          zoneDisplay.value = '';
          zoneDisplay.dataset.zonesMap = '{}';
          zoneSelect.value = '';
        }
      }

      recalculate();
      flashOverviewBanner();

      // 대지경계선(도로/인접대지) 분류 + 1차 건축가능영역 조회 (비동기, 도착하면 재계산)
      refetchBuildableEnvelope();
    });
  }

  // 구역계 취소 버튼
  const btnClearBoundary = document.getElementById('btn-clear-boundary');
  if (btnClearBoundary) {
    btnClearBoundary.addEventListener('click', () => {
      if (confirm('선택된 구역계(필지)를 모두 취소하시겠습니까?')) {
        clearParcelBoundary();
        state.siteDimensions = null;
        state.buildableEnvelope = null;
        state.envelopeEdges = null;
        if (typeof clearBuildableEnvelopeState === 'function') clearBuildableEnvelopeState();
        recalculate();
      }
    });
  }

  // 세대 타입 추가
  document.getElementById('btn-add-type').addEventListener('click', () => {
    if (state.unitTypes.length >= 5) return; // 최대 5가지
    state.unitTypes.push({ name: `신규타입`, area: 0, count: 0 });
    renderUnitTypes();
  });

  // 스텝 헤더 토글 (accordion)
  document.querySelectorAll('.step-header').forEach(header => {
    header.addEventListener('click', () => {
      const stepNum = header.dataset.toggle;
      const body = document.getElementById(`step-body-${stepNum}`);
      const step = header.closest('.wizard-step');
      const isActive = step.classList.contains('active');

      // 모두 닫기
      document.querySelectorAll('.wizard-step').forEach(s => {
        s.classList.remove('active');
        s.querySelector('.step-body').classList.add('collapsed');
      });

      if (!isActive) {
        step.classList.add('active');
        body.classList.remove('collapsed');
      }
    });
  });

  // 탭 전환
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 설계개요 배너 → "설계개요 보기" 버튼 (사용자가 직접 클릭할 때만 탭 이동)
  const obViewBtn = document.getElementById('ob-view-btn');
  if (obViewBtn) {
    obViewBtn.addEventListener('click', () => switchTab('overview'));
  }

  // 모든 입력 필드 → 실시간 재계산
  const allInputs = [
    'land-area', 'contrib-area', 'local-bcr', 'local-far',
    'local-green-ratio', 'local-parking-ratio', 'local-openspace-ratio',
    'local-north-setback-ratio', 'local-building-gap-ratio',
    'standard-building-depth', 'standard-unit-width', 'core-width',
    'floor-height-1', 'floor-height-2', 'floor-height-3', 'floor-height-typical',
    'above-floors', 'under-floors', 'exclusive-ratio',
    'parking-multiplier', 'parking-per-unit', 'parking-area-per-space', 'storage-area',
    'amenity-multiplier',
    'area-office', 'area-senior', 'area-kinder', 'area-library',
    'area-care', 'area-community', 'area-guard', 'area-shop',
    'project-name', 'location-text'
  ];
  allInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', recalculate);
  });
  document.getElementById('structure-type').addEventListener('change', recalculate);
  document.getElementById('building-use').addEventListener('change', recalculate);

  // 주차대수 산정 방식 토글 → 해당 입력란만 노출
  const parkingModeMultiplierFields = document.getElementById('parking-mode-multiplier-fields');
  const parkingModePerunitFields = document.getElementById('parking-mode-perunit-fields');
  document.querySelectorAll('input[name="parking-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isPerUnit = radio.value === 'perUnit' && radio.checked;
      if (radio.checked) {
        if (parkingModeMultiplierFields) parkingModeMultiplierFields.style.display = radio.value === 'multiplier' ? '' : 'none';
        if (parkingModePerunitFields) parkingModePerunitFields.style.display = radio.value === 'perUnit' ? '' : 'none';
        recalculate();
      }
    });
  });

  // 세대당 목표 부대복리시설(평) → 부대복리시설 확장 배수로 역산
  // (관리사무소/경비실이 지하 주민공동시설 잔여량 계산에 얽혀있어 배수와 세대당 면적이
  //  선형 관계가 아니므로, calculate()를 실제로 재실행하는 이진탐색으로 정확한 배수를 찾는다)
  const amenityTargetPy = document.getElementById('amenity-target-py');
  if (amenityTargetPy) {
    amenityTargetPy.addEventListener('input', () => {
      const targetPy = parseFloat(amenityTargetPy.value);
      if (!targetPy || !lastResult || lastResult.totalHouseholds <= 0) return;

      const targetTotalArea = (targetPy / 0.3025) * lastResult.totalHouseholds;
      const baseInputs = buildCalcInputs();

      let lo = 1.0, hi = 3.0, bestMult = 1.0;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        const testR = calculate({ ...baseInputs, amenityMultiplier: mid });
        bestMult = mid;
        if (testR.totalAmenityArea < targetTotalArea) lo = mid; else hi = mid;
      }

      const clampedMult = Math.max(1.0, Math.min(3.0, bestMult));
      document.getElementById('amenity-multiplier').value = clampedMult.toFixed(2);
      document.getElementById('amenity-multiplier-range').value = Math.max(1.0, Math.min(2.0, clampedMult)).toFixed(1);
      recalculate();
    });
  }

  // 정밀 최적화(Python) 실행 버튼
  const btnOptimize = document.getElementById('btn-optimize-massing');
  if (btnOptimize) btnOptimize.addEventListener('click', runOptimizeMassing);

  // 호수 조합 선택 → 재계산
  const unitComboMode = document.getElementById('unit-combo-mode');
  if (unitComboMode) unitComboMode.addEventListener('change', recalculate);

  // 주동 형상 선택(자동/판상형/L자형/타워형) → 재계산
  const buildingShapeMode = document.getElementById('building-shape-mode');
  if (buildingShapeMode) buildingShapeMode.addEventListener('change', recalculate);

  // 도로 후퇴거리 / 대지안의 공지 이격거리 변경 → 건축가능영역 재조회
  ['local-road-setback', 'local-adjacent-setback'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', refetchBuildableEnvelope);
  });

  // 공개공지 대상 체크박스 → 세부 입력란 토글
  const openspaceTarget = document.getElementById('openspace-target');
  const openspaceFields = document.getElementById('openspace-fields');
  if (openspaceTarget) {
    openspaceTarget.addEventListener('change', () => {
      if (openspaceFields) openspaceFields.style.display = openspaceTarget.checked ? 'grid' : 'none';
      recalculate();
    });
  }

  // 초기화 버튼
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (confirm('모든 입력값을 초기화하시겠습니까?')) location.reload();
  });

  // PDF 인쇄
  document.getElementById('btn-print').addEventListener('click', () => {
    // 인쇄 전에 미리보기 탭 활성화
    switchTab('overview');
    setTimeout(() => window.print(), 200);
  });
}

/* ═══════════════════════════════════════════════════
   7. 탭 전환
   ═══════════════════════════════════════════════════ */
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('active', c.id === `tab-${tabName}`);
  });

  // 지도 탭으로 돌아올 때 Kakao Map 크기 재조정
  if (tabName === 'map' && typeof kakaoMap !== 'undefined' && kakaoMap) {
    setTimeout(() => kakaoMap.relayout(), 50);
  }
}

/* ═══════════════════════════════════════════════════
   8. 핵심 재계산 함수
   ═══════════════════════════════════════════════════ */
/** 현재 폼 상태로부터 calculate() 입력 객체를 구성한다 (recalculate()와 "세대당 목표 평" 이진탐색에서 공용) */
function buildCalcInputs() {
  const g = id => document.getElementById(id);
  const v = id => parseFloat(g(id)?.value) || 0;
  const vn = id => { const val = parseFloat(g(id)?.value); return isNaN(val) ? null : val; };
  const t = id => g(id)?.value || '';

  const zoneSelect = g('zone-select');
  const zoneDisplay = g('zone-display');
  const zonesMap = zoneDisplay && zoneDisplay.dataset.zonesMap 
    ? JSON.parse(zoneDisplay.dataset.zonesMap) 
    : {};

  const inputs = {
    landArea:             v('land-area'),
    contributionArea:     v('contrib-area'),
    zoneName:             zoneSelect?.value || '',
    address:              t('location-text'),
    zonesMap:             zonesMap,
    localBcrOverride:     vn('local-bcr'),
    localFarOverride:     vn('local-far'),
    localGreenRatioOverride:   vn('local-green-ratio'),
    localParkingRatioOverride: vn('local-parking-ratio'),
    openspaceTarget:      g('openspace-target')?.checked || false,
    localOpenspaceRatioOverride: vn('local-openspace-ratio'),
    // 층수 (비워두면 자동 추정)
    aboveFloorsManual:    vn('above-floors'),
    underFloorsManual:    vn('under-floors'),
    // 주차: 배수 방식 또는 세대당 대수 방식
    parkingMode:          document.querySelector('input[name="parking-mode"]:checked')?.value || 'multiplier',
    parkingMultiplier:    v('parking-multiplier') || 1.2,
    parkingPerUnit:       v('parking-per-unit') || 1.3,
    parkingAreaPerSpace:  v('parking-area-per-space') || 36,
    storageArea:          v('storage-area'),
    // 부대복리: 법정 배수 방식
    amenityMultiplier:    v('amenity-multiplier') || 1.0,
    // 직접 입력 (비워두면 자동 적용)
    areaOfficeGround:     vn('area-office'),
    areaSeniorGround:     vn('area-senior'),
    areaKinderGround:     vn('area-kinder'),
    areaLibraryGround:    vn('area-library'),
    areaCareGround:       vn('area-care'),
    areaCommunityUnder:   vn('area-community'),
    areaGuardGround:      vn('area-guard'),
    shopArea:             v('area-shop'),
    unitTypes:            state.unitTypes,
    exclusiveRatio:       (v('exclusive-ratio') || 74.8) / 100,
    // 개략 배치 시뮬레이션
    siteDimensions:       state.siteDimensions,
    buildableEnvelope:    state.buildableEnvelope,
    envelopeEdges:        state.envelopeEdges,
    northSetbackRatio:    v('local-north-setback-ratio') || 0.5,
    buildingGapRatio:     vn('local-building-gap-ratio'), // 비워두면 준주거/근린상업은 0.25, 그 외는 0.5 자동 적용
    standardBuildingDepth: vn('standard-building-depth'), // 비워두면 전용84 기준 10m을 실제 평균 전용면적 비율로 스케일
    standardUnitWidth:    vn('standard-unit-width'),      // 비워두면 전용84 기준 15m을 실제 평균 전용면적 비율로 스케일
    coreWidth:            v('core-width') || 10,
    unitComboMode:        (() => {
      const sel = g('unit-combo-mode')?.value;
      return sel && sel !== 'auto' ? parseInt(sel, 10) : 'auto';
    })(),
    buildingShapeMode:    g('building-shape-mode')?.value || 'auto', // auto=판상형/L자형/타워형 비교 후 용적률 최대 형상 채택
    // 층별 층고 (mm) — 비워두면 calculator.js에서 2900mm 기본 적용
    floorHeight1Mm:       vn('floor-height-1'),
    floorHeight2Mm:       vn('floor-height-2'),
    floorHeight3Mm:       vn('floor-height-3'),
    floorHeightTypicalMm: vn('floor-height-typical')
  };

  return inputs;
}

function recalculate() {
  const g = id => document.getElementById(id);
  const t = id => g(id)?.value || '';
  const inputs = buildCalcInputs();

  const r = calculate(inputs);
  lastResult = r; // "세대당 목표 평" 조절 기능에서 참조 (역산용)

  // ── 자동 추정 층수 라벨 표시 ─────────────────────────
  const abFlAuto = g('above-floors-auto');
  const unFlAuto = g('under-floors-auto');
  if (abFlAuto) abFlAuto.textContent = inputs.aboveFloorsManual ? '' : `추정: 지상${r.aboveFloors}층`;
  if (unFlAuto) unFlAuto.textContent = inputs.underFloorsManual ? '' : `추정: 지하${r.underFloors}층`;

  // ── 조례 수치 플레이스홀더 업데이트 ─────────────────
  const localBcr = g('local-bcr');
  const localFar = g('local-far');
  if (localBcr) localBcr.placeholder = `조례: ${r.legalBcrMax.toFixed(2)}% 이하`;
  if (localFar) localFar.placeholder = `조례: ${r.legalFarMax.toFixed(2)}% 이하`;

  // ── 용도지역 정보 배지 동적 업데이트 ─────────────────
  const badge = g('zone-info-badge');
  if (badge) {
    if (!r.zoneBreakdown || r.zoneBreakdown.length === 0) {
      badge.style.display = 'none';
    } else if (r.zoneBreakdown.length > 1) {
      const methodLabel = r.multiZoneMethod === 'weighted'
        ? '⚖️ 제84조①: 가중평균 적용'
        : '📐 제84조②: 구역별 독립 적용';
      const methodColor = r.multiZoneMethod === 'weighted' ? 'var(--accent)' : '#f59e0b';

      let detailRows = '';
      if (r.multiZoneMethod === 'independent' && r.independentZones && r.independentZones.length > 0) {
        detailRows = r.independentZones.map(z => `
          <div style="display:flex;justify-content:space-between;font-size:0.72rem;padding:2px 0;">
            <span style="color:var(--text-muted);">${z.name}</span>
            <span>${z.area.toLocaleString()}㎡ × BCR ${z.bcr}% / FAR ${z.far}%</span>
          </div>`).join('');
      } else {
        const totalA = r.zoneBreakdown.reduce((s, z) => s + z.area, 0);
        detailRows = r.zoneBreakdown.map(z => `
          <div style="display:flex;justify-content:space-between;font-size:0.72rem;padding:2px 0;">
            <span style="color:var(--text-muted);">${z.name}</span>
            <span>${z.area.toLocaleString()}㎡ (${totalA > 0 ? Math.round(z.area/totalA*100) : 0}%) BCR ${z.bcr}% FAR ${z.far}%</span>
          </div>`).join('');
      }

      const breakdown = r.zoneBreakdown.map(z => `${z.name.slice(0,4)}: ${z.area.toLocaleString()}㎡`).join(', ');
      badge.innerHTML = `
        <div class="zone-badge-item">
          <span class="zone-badge-val">${r.legalBcrMax.toFixed(2)}%</span>
          <span class="zone-badge-lbl">${r.multiZoneMethod === 'weighted' ? '가중평균' : '등가'} 건폐율</span>
        </div>
        <div class="zone-badge-item">
          <span class="zone-badge-val">${r.legalFarMax.toFixed(2)}%</span>
          <span class="zone-badge-lbl">${r.multiZoneMethod === 'weighted' ? '가중평균' : '등가'} 용적률</span>
        </div>
        <div class="zone-badge-item">
          <span class="zone-badge-val" style="font-size:0.7rem; color:${methodColor};">${r.zoneBreakdown.length}개구역</span>
          <span class="zone-badge-lbl">혼합 용도지역</span>
        </div>
        <div style="grid-column:1/span 3;border-top:1px dashed var(--border);padding-top:6px;margin-top:2px;">
          <div style="font-size:0.72rem;color:${methodColor};font-weight:600;margin-bottom:4px;">${methodLabel}</div>
          ${detailRows}
        </div>
      `;
      badge.style.display = 'grid';
    } else {
      const z = r.zoneBreakdown[0];
      const zoneObj = getZone(z.name) || { category: '기타', desc: '' };
      badge.innerHTML = `
        <div class="zone-badge-item">
          <span class="zone-badge-val">${r.legalBcrMax}%</span>
          <span class="zone-badge-lbl">건폐율 (${z.source})</span>
        </div>
        <div class="zone-badge-item">
          <span class="zone-badge-val">${r.legalFarMax}%</span>
          <span class="zone-badge-lbl">용적률 (${z.source})</span>
        </div>
        <div class="zone-badge-item">
          <span class="zone-badge-val" style="font-size:0.75rem; color:var(--accent);">${zoneObj.category}</span>
          <span class="zone-badge-lbl">${(zoneObj.desc || '').slice(0, 12)}…</span>
        </div>
      `;
      badge.style.display = 'grid';
    }
  }

  // ── 부대복리시설 자동 계산 결과 피드백 ──────────────
  const sf0 = v => v > 0 ? `${Math.round(v)} ㎡` : '해당없음';
  const sfAuto = (manual, auto) => manual ? `${Math.round(auto)} ㎡ (직접입력: ${Math.round(manual)} ㎡)` : `${Math.round(auto)} ㎡`;
  if (g('auto-office-val'))    g('auto-office-val').textContent    = `${Math.round(r.autoOfficeArea)} ㎡ (법정: ${Math.round(r.legalOfficeArea)}㎡)`;
  if (g('auto-guard-val'))     g('auto-guard-val').textContent     = sf0(r.autoGuardArea);
  if (g('auto-senior-val'))    g('auto-senior-val').textContent    = r.legalSeniorArea > 0 ? `${Math.round(r.autoSeniorArea)} ㎡ (법정: ${Math.round(r.legalSeniorArea)}㎡)` : '해당없음';
  if (g('auto-kinder-val'))    g('auto-kinder-val').textContent    = r.legalKinderArea > 0 ? `${Math.round(r.autoKinderArea)} ㎡ (법정: ${Math.round(r.legalKinderArea)}㎡, 정원 ${Math.round(r.kinderCapacity)}명)` : '해당없음';
  if (g('auto-community-val')) g('auto-community-val').textContent = r.legalCommunityArea > 0 ? `${Math.round(r.autoCommunityUnder)} ㎡` : '해당없음';
  if (g('auto-library-val'))   g('auto-library-val').textContent   = r.legalLibraryArea > 0 ? `${Math.round(r.actualLibraryArea)} ㎡ (법정: ${Math.round(r.legalLibraryArea)}㎡)` : '해당없음';

  // ── 주차 계획 배지 업데이트 ──────────────────────────
  const pmDisplay = g('parking-mult-display');
  if (pmDisplay) pmDisplay.textContent = (inputs.parkingMultiplier).toFixed(1);
  const parkAreaEst = g('parking-area-est');
  if (parkAreaEst) parkAreaEst.textContent = r.parkingUnderArea > 0 ? `${Math.round(r.parkingUnderArea).toLocaleString()} ㎡` : '— ㎡';
  const amenMultLabel = g('amenity-mult-label');
  if (amenMultLabel) amenMultLabel.textContent = `법정면적 ×${(inputs.amenityMultiplier).toFixed(1)}`;

  // ── 계산 결과 반영 ────────────────────────────────────
  updateSummaryPanel(r);
  updateOverviewBanner(r);
  updateLayoutSimCard(r);
  renderOverviewTable(r, t);
  renderAreaTable(r);
  renderUnitTable(r);
  renderLegalTab(r);
  updateParkingMiniCard(r);
  updateCalcBadges(r);
}

/* ═══════════════════════════════════════════════════
   9. 요약 패널 업데이트
   ═══════════════════════════════════════════════════ */
function updateSummaryPanel(r) {
  const g = id => document.getElementById(id);

  // 건폐율 (배치 시뮬레이션이 있으면 실측 배치 기반, 없으면 지상연면적/층수 추정치)
  const bcrPct = r.calculatedBcr.toFixed(1) + '%';
  g('sum-val-bcr').textContent = bcrPct;
  g('sum-limit-bcr').textContent = `법정: ${r.legalBcrMax}% 이하` + (r.bcrIsGeometric ? ' (배치 실측)' : ' (추정치)');
  const bcrRatio = Math.min(r.calculatedBcr / r.legalBcrMax, 1);
  g('sum-bar-bcr').style.width = (bcrRatio * 100) + '%';
  g('sum-bcr').className = 'summary-item ' + (r.bcrOk ? 'ok' : 'ng');

  // 용적률
  const farPct = r.calculatedFar.toFixed(1) + '%';
  g('sum-val-far').textContent = farPct;
  g('sum-limit-far').textContent = r.contributionArea > 0
    ? `완화: ${r.relaxedFarLimit.toFixed(1)}%`
    : `법정: ${r.legalFarMax}% 이하`;
  const farLimit = r.contributionArea > 0 ? r.relaxedFarLimit : r.legalFarMax;
  const farRatio = Math.min(r.calculatedFar / farLimit, 1);
  g('sum-bar-far').style.width = (farRatio * 100) + '%';
  g('sum-far').className = 'summary-item ' + (r.farOk ? 'ok' : 'ng');

  // 주차
  if (r.totalHouseholds > 0) {
    g('sum-val-parking').textContent = `${r.totalInstParking} / ${r.legalParkingCount} 대`;
    g('sum-limit-parking').textContent = `법정: ${r.legalParkingCount}대 이상`;
    g('sum-parking').className = 'summary-item ' + (r.parkingOk ? 'ok' : 'ng');
  } else {
    g('sum-val-parking').textContent = '—';
    g('sum-limit-parking').textContent = '세대 정보 필요';
    g('sum-parking').className = 'summary-item';
  }

  // 주민공동시설
  if (r.legalCommunityArea > 0) {
    g('sum-val-community').textContent = `${r.actualCommunityArea.toFixed(0)} / ${r.legalCommunityArea.toFixed(0)} ㎡`;
    g('sum-limit-community').textContent = `의무: ${r.legalCommunityArea.toFixed(0)}㎡`;
    g('sum-community').className = 'summary-item ' + (r.communityOk ? 'ok' : 'ng');
  } else {
    g('sum-val-community').textContent = '—';
    g('sum-limit-community').textContent = '100세대 이상 적용';
    g('sum-community').className = 'summary-item';
  }

  // 부대복리시설 세대당 평 (관리사무소·경비실 포함 전체)
  const amenityPyEl = g('sum-amenity-py');
  if (amenityPyEl) {
    amenityPyEl.textContent = r.totalHouseholds > 0
      ? `부대복리시설 세대당 ${r.amenityPerHouseholdPy.toFixed(2)}평`
      : '부대복리시설 세대당 — 평';
  }
  const amenityCurrentPyEl = g('amenity-current-py');
  if (amenityCurrentPyEl) {
    amenityCurrentPyEl.textContent = r.totalHouseholds > 0 ? r.amenityPerHouseholdPy.toFixed(2) : '—';
  }
}

/* ═══════════════════════════════════════════════════
   8-1. 개략 배치 검토 카드 (STEP 2, 정북이격·인동간격 기반)
   ═══════════════════════════════════════════════════ */
function updateLayoutSimCard(r) {
  const g = id => document.getElementById(id);
  const dimEl = g('layout-site-dim');
  const shapeEl = g('layout-building-shape');
  const frontEl = g('layout-front-direction');
  const setbackEl = g('layout-setback-values');
  const rowsEl = g('layout-rows');
  const floorsEl = g('layout-required-floors');
  const legalMaxEl = g('layout-legal-max-floors');
  const statusEl = g('layout-status');
  const compareWrap = g('layout-shape-compare-wrap');
  const compareBody = g('layout-shape-compare-body');
  if (!dimEl || !rowsEl || !floorsEl || !statusEl) return;

  const renderCompareTable = comparison => {
    if (!compareWrap || !compareBody) return;
    if (!comparison || comparison.length === 0) {
      compareWrap.style.display = 'none';
      compareBody.innerHTML = '';
      return;
    }
    compareWrap.style.display = 'block';
    compareBody.innerHTML = comparison.map(s => {
      const noFit = !s.unitsPerFloor || s.unitsPerFloor <= 0;
      const rowClass = noFit ? 'no-fit' : (s.shape === r.layoutInfo.buildingShape ? 'adopted' : '');
      const mark = s.shape === r.layoutInfo.buildingShape ? ' ✔' : '';
      return `<tr class="${rowClass}"><td>${s.shape}${mark}</td><td>${noFit ? '배치불가' : s.unitsPerFloor + '세대'}</td><td>${s.requiredFloors ? s.requiredFloors + '층' : '—'}</td></tr>`;
    }).join('');
  };

  // 법정 최고층수 상한은 대지가 확정되지 않아도(건폐율만 있어도) 항상 표시
  if (legalMaxEl) {
    if (r.landArea > 0) {
      legalMaxEl.textContent = `${r.legalAboveFloors}층 이하`;
      legalMaxEl.style.color = r.legalAboveFloorsExceeded ? 'var(--danger)' : '';
      legalMaxEl.style.fontWeight = r.legalAboveFloorsExceeded ? '700' : '';
      if (r.legalAboveFloorsExceeded) legalMaxEl.textContent += ` — ⚠ 지상층수 입력값(${r.aboveFloors}층)이 이를 초과합니다`;
    } else {
      legalMaxEl.textContent = '—';
    }
  }

  const dims = state.siteDimensions;
  if (!dims) {
    dimEl.textContent = '필지 확정 대기';
    if (shapeEl) shapeEl.textContent = '—';
    if (frontEl) frontEl.textContent = '—';
    if (setbackEl) setbackEl.textContent = '—';
    rowsEl.textContent = '—';
    floorsEl.textContent = '—';
    statusEl.textContent = '구역계를 확정하면 자동 산정됩니다 (개략 근사치, 실시설계 시 재검토 필요)';
    statusEl.className = 'legal-status';
    renderCompareTable(null);
    if (typeof clearLayoutPreview === 'function') clearLayoutPreview();
    return;
  }

  dimEl.textContent = `${dims.widthEW.toLocaleString()}m × ${dims.depthNS.toLocaleString()}m`;

  if (!r.layoutInfo) {
    if (shapeEl) shapeEl.textContent = '—';
    if (frontEl) frontEl.textContent = '—';
    if (setbackEl) setbackEl.textContent = '—';
    rowsEl.textContent = '—';
    floorsEl.textContent = '—';
    statusEl.textContent = '세대 타입·세대수를 입력하면 자동 산정됩니다';
    statusEl.className = 'legal-status';
    renderCompareTable(null);
    if (typeof clearLayoutPreview === 'function') clearLayoutPreview();
    return;
  }

  if (shapeEl) shapeEl.textContent = r.layoutInfo.buildingShape || '—';
  if (frontEl) frontEl.textContent = r.layoutInfo.frontLabel || '정남향(기본)';
  if (setbackEl) {
    const heightText = r.layoutInfo.assumedHeight ? `, 예상높이 ${r.layoutInfo.assumedHeight.toFixed(1)}m` : '';
    setbackEl.textContent = `${r.layoutInfo.northSetback.toFixed(1)}m / ${r.layoutInfo.buildingGap.toFixed(1)}m (지상 ${r.aboveFloors}층${heightText})`;
  }

  const usedEnvelope = !!state.buildableEnvelope;
  const totalBuildingCount = (r.layoutInfo.rows || []).reduce((s, row) => s + (row.buildingCount || 1), 0);
  const comboText = usedEnvelope && r.layoutInfo.rows && r.layoutInfo.rows.length > 0
    ? ` (호수: ${r.layoutInfo.rows.map(row => row.combo).join(' / ')})`
    : '';
  rowsEl.textContent = r.layoutInfo.maxRows > 0
    ? `총 ${totalBuildingCount}개 동 (${r.layoutInfo.maxRows}개 열, 층당 ${r.layoutInfo.totalUnitsPerFloorAllRows}세대)${comboText}`
    : '배치 불가 (가용폭 부족)';
  floorsEl.textContent = r.layoutInfo.requiredFloors ? `${r.layoutInfo.requiredFloors}층` : '—';
  renderCompareTable(r.layoutInfo.strategyComparison);

  if (typeof drawLayoutPreview === 'function') {
    stampFloorCountOnLabels(r.layoutInfo, r.aboveFloors);
    drawLayoutPreview(dims.bbox, r.layoutInfo);
  }

  if (!r.layoutInfo.requiredFloors) {
    statusEl.textContent = '⚠ 건축가능영역 폭이 좁아 코어+호 조합이 들어가지 않습니다 — 코어폭/세대폭/이격거리를 조정해보세요';
    statusEl.className = 'legal-status ng';
  } else if (r.layoutInfo.exceedsLegal) {
    statusEl.textContent = `⚠ 배치상 필요층수(${r.layoutInfo.requiredFloors}층)가 법규 상한(${r.layoutInfo.legalAboveFloors}층)을 초과 — 세대수 조정 또는 동수 재검토 필요`;
    statusEl.className = 'legal-status ng';
  } else {
    const source = usedEnvelope ? '대지경계선(도로/인접대지 이격 반영)' : '대지 바운딩박스(근사)';
    statusEl.textContent = `✔ ${source} 기반 산정 적용됨 (지상 ${r.aboveFloors}층) — 지도의 변을 클릭하면 도로/인접대지 분류를 수동보정할 수 있습니다. 개략 근사치, 실시설계 시 재검토 필요`;
    statusEl.className = 'legal-status ok';
  }
}

/** 지도에 그리기 직전, 각 동 라벨 끝에 "· N층"을 붙인다(JS 개략/Python 최적화 결과 공통 사용). */
function stampFloorCountOnLabels(layoutInfo, floors) {
  if (!layoutInfo || !floors || !Array.isArray(layoutInfo.rows)) return;
  const suffix = ` · ${floors}층`;
  layoutInfo.rows.forEach(row => {
    (row.buildingLabels || []).forEach(bl => {
      if (!bl.text.endsWith(suffix)) bl.text += suffix;
    });
  });
}

/* ═══════════════════════════════════════════════════
   8-2. 정밀 최적화(Python/Shapely) 실행 — 회전각·층수 전수 탐색으로
   목표 세대수는 참고하지 않고 이 대지의 법정 최대 수용력을 산출한다.
   기존 실시간 개략 계산(JS)은 그대로 두고, 버튼을 눌렀을 때만 opt-in으로 호출한다
   (연산이 수십ms~2초 걸릴 수 있어 매 입력마다 자동 실행하지 않음).
   ═══════════════════════════════════════════════════ */
async function runOptimizeMassing() {
  const btn = document.getElementById('btn-optimize-massing');
  const resultBox = document.getElementById('optimize-massing-result');
  const statusEl = document.getElementById('opt-status');
  if (!btn || !resultBox || !statusEl) return;

  if (!state.buildableEnvelope || !state.envelopeEdges) {
    alert('먼저 지도에서 대지를 선택하고 "구역계 확정"을 눌러주세요.');
    return;
  }
  if (!lastResult || !lastResult.totalHouseholds) {
    alert('세대 타입과 세대수를 먼저 입력해주세요 (평균 전용면적 산정에 필요합니다).');
    return;
  }

  const r = lastResult;
  const inputs = buildCalcInputs();
  const areaScale = (r.layoutInfo && r.layoutInfo.areaScale) || 1;
  const avgFarAreaPerHousehold = r.totalHouseholds > 0 ? r.farBaseArea / r.totalHouseholds : 0;

  const payload = {
    buildableEnvelope: state.buildableEnvelope,
    envelopeEdges: state.envelopeEdges,
    unitTypeList: (r.unitDetails || []).filter(t => t.count > 0).map(t => ({ name: t.name, supplyArea: t.supplyArea, count: t.count })),
    standardBuildingDepth: (inputs.standardBuildingDepth || 10) * areaScale,
    standardUnitWidth: (inputs.standardUnitWidth || 15) * areaScale,
    coreWidth: inputs.coreWidth,
    unitComboMode: inputs.unitComboMode,
    buildingShapeMode: inputs.buildingShapeMode,
    northSetbackRatio: inputs.northSetbackRatio,
    buildingGapRatio: inputs.buildingGapRatio,
    floorHeight1Mm: inputs.floorHeight1Mm,
    floorHeight2Mm: inputs.floorHeight2Mm,
    floorHeight3Mm: inputs.floorHeight3Mm,
    floorHeightTypicalMm: inputs.floorHeightTypicalMm,
    landArea: r.landArea,
    legalBcrMax: r.legalBcrMax,
    legalFarMax: r.legalFarMax,
    relaxedFarLimit: r.relaxedFarLimit,
    avgFarAreaPerHousehold,
    allowOver50Floors: document.getElementById('allow-over-50-floors')?.checked || false
  };

  const originalBtnHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 탐색 중...';
  resultBox.style.display = 'none';

  const result = await fetchOptimizedMassing(payload);

  btn.disabled = false;
  btn.innerHTML = originalBtnHtml;
  resultBox.style.display = 'block';

  const hEl = document.getElementById('opt-households');
  const frEl = document.getElementById('opt-floors-rot');
  const farEl = document.getElementById('opt-far');
  const bcrEl = document.getElementById('opt-bcr');
  const heightEl = document.getElementById('opt-assumed-height');
  const setbackWrap = document.getElementById('opt-setback-wrap');
  const setbackBody = document.getElementById('opt-setback-body');

  if (result.error || result.noFit) {
    if (hEl) hEl.textContent = '—';
    if (frEl) frEl.textContent = '—';
    if (farEl) farEl.textContent = '—';
    if (bcrEl) bcrEl.textContent = '—';
    if (heightEl) heightEl.textContent = '—';
    if (setbackWrap) setbackWrap.style.display = 'none';
    if (result.noFit && result.searchStats && result.searchStats.candidatesRejectedByValidation > 0) {
      statusEl.textContent = `⚠ 용적률·건폐율 조건은 만족하는 배치가 ${result.searchStats.candidatesRejectedByValidation}건 있었지만, 인동간격·채광사선·정북일조 이격을 만족하지 못해 모두 제외됐습니다 — 조례 이격거리·세대폭·코어폭을 조정해보세요`;
    } else {
      statusEl.textContent = result.error ? `⚠ 오류: ${result.error}` : '⚠ 이 대지/조건에서는 배치 가능한 조합을 찾지 못했습니다 — 조례 이격거리·세대폭·코어폭을 조정해보세요';
    }
    statusEl.className = 'legal-status ng';
    return;
  }

  if (hEl) hEl.textContent = `${result.achievedHouseholds.toLocaleString()} 세대`;
  if (frEl) frEl.textContent = `${result.chosenFloors}층 / 회전 ${result.rotationDeg}도`;
  if (farEl) farEl.textContent = `${result.achievedFar}% (목표 ${result.farCapTarget}%)`;
  if (bcrEl) bcrEl.textContent = `${result.achievedBcr}% (법정 ${r.legalBcrMax}% 이하)`;
  if (heightEl) heightEl.textContent = result.assumedHeightM ? `${result.assumedHeightM}m (${result.chosenFloors}층 기준)` : '—';

  if (setbackWrap && setbackBody) {
    const details = result.setbackReport || [];
    if (details.length === 0) {
      setbackWrap.style.display = 'none';
    } else {
      setbackWrap.style.display = 'block';
      setbackBody.innerHTML = details.map(d => {
        let refLabel = d.referenceLine;
        if (d.type === 'road') refLabel += ` (도로폭 ${d.roadWidthM}m, 절반 크레딧 ${d.roadCenterlineCreditM}m)`;
        if (d.exempted) return `<tr><td>${refLabel}</td><td colspan="3">면제 (북측 비주거지역)</td></tr>`;
        const ratioText = `${d.ratio}배`;
        const requiredText = `${d.requiredSetbackM}m`;
        const actualText = d.actualDistanceM != null ? `${d.actualDistanceM}m` : '—';
        return `<tr><td>${refLabel}</td><td>${ratioText}</td><td>${requiredText}</td><td>${actualText}</td></tr>`;
      }).join('');
    }
  }

  // 인동간격·채광사선(도로중심선 기준 포함)·정북일조 이격에 저촉하는 후보는 탐색 단계에서
  // 이미 제외되므로(massing.py), 여기 도달한 best는 항상 검증을 통과한 배치다.
  const cappedNote = result.cappedAt50 ? ' — 50층 제한에 도달했습니다. 더 높은 층수도 탐색하려면 위 체크박스를 켜고 다시 실행해보세요.' : '';
  statusEl.textContent = `✔ 인동간격·채광사선·정북일조 이격 기준을 만족하는 배치만 채택 (회전각·층수 조합 ${result.searchStats.candidatesEvaluated}개 탐색, ${result.searchStats.elapsedMs}ms)${cappedNote}`;
  statusEl.className = 'legal-status ok';

  if (typeof drawLayoutPreview === 'function' && state.siteDimensions) {
    stampFloorCountOnLabels(result, result.chosenFloors);
    drawLayoutPreview(state.siteDimensions.bbox, result);
  }

  applyOptimizedMassingToSummary(result, r);
}

/**
 * 정밀 최적화 결과를 화면 상단 "핵심 지표 요약"(건폐율/용적률) 패널에도 반영한다.
 * 최적화 전에는 이 패널이 calculate()의 목표 세대수 기반 개략 계산값을 보여주는데,
 * 최적화는 목표 세대수를 참고하지 않고 이 대지의 법정 최대 수용력을 새로 산출하므로
 * 두 값이 서로 다를 수 있다 — 최적화를 실행한 뒤에는 위/아래 숫자가 일치하도록
 * 상단 패널도 최적화 결과 기준으로 갱신한다(다른 입력을 바꿔 재계산하면 다시 원래
 * 목표 기반 계산으로 돌아간다).
 */
function applyOptimizedMassingToSummary(result, r) {
  const g = id => document.getElementById(id);
  const bcrEl2 = g('sum-val-bcr'), bcrLimitEl = g('sum-limit-bcr'), bcrBarEl = g('sum-bar-bcr'), bcrItemEl = g('sum-bcr');
  const farEl2 = g('sum-val-far'), farLimitEl = g('sum-limit-far'), farBarEl = g('sum-bar-far'), farItemEl = g('sum-far');
  if (!bcrEl2 || !farEl2) return;

  if (bcrEl2) bcrEl2.textContent = result.achievedBcr.toFixed(1) + '%';
  if (bcrLimitEl) bcrLimitEl.textContent = `법정: ${r.legalBcrMax}% 이하 (정밀 최적화 결과)`;
  if (bcrBarEl) bcrBarEl.style.width = Math.min(result.achievedBcr / r.legalBcrMax, 1) * 100 + '%';
  if (bcrItemEl) bcrItemEl.className = 'summary-item ' + (result.achievedBcr <= r.legalBcrMax + 0.01 ? 'ok' : 'ng');

  if (farEl2) farEl2.textContent = result.achievedFar.toFixed(1) + '%';
  if (farLimitEl) farLimitEl.textContent = `목표: ${result.farCapTarget}% (정밀 최적화 결과)`;
  if (farBarEl) farBarEl.style.width = Math.min(result.achievedFar / result.farCapTarget, 1) * 100 + '%';
  if (farItemEl) farItemEl.className = 'summary-item ' + (result.achievedFar <= result.farCapTarget + 0.01 ? 'ok' : 'ng');
}

/* ═══════════════════════════════════════════════════
   9-1. 설계개요 배너 (상단, 구역계 확정 시 표시)
   ═══════════════════════════════════════════════════ */
function updateOverviewBanner(r) {
  const g = id => document.getElementById(id);
  const banner = g('overview-banner');
  if (!banner) return;

  if (r.landArea > 0) banner.classList.add('show');

  g('ob-location').textContent = document.getElementById('location-text')?.value || '—';
  g('ob-zone').textContent = r.zoneName || '—';
  g('ob-land-area').textContent = r.landArea > 0 ? `${r.landArea.toLocaleString()} ㎡` : '—';
  g('ob-bcr').textContent = r.landArea > 0 ? `${r.calculatedBcr.toFixed(1)}%` : '—';
  g('ob-far').textContent = r.landArea > 0 ? `${r.calculatedFar.toFixed(1)}%` : '—';
  g('ob-households').textContent = r.totalHouseholds > 0 ? `${r.totalHouseholds.toLocaleString()} 세대` : '—';
}

/** 구역계 확정 시 배너를 열고 살짝 강조(flash)한다 (탭 강제 이동 없이) */
function flashOverviewBanner() {
  const banner = document.getElementById('overview-banner');
  if (!banner) return;
  banner.classList.add('show');
  banner.classList.remove('flash');
  void banner.offsetWidth; // 애니메이션 재시작을 위한 강제 리플로우
  banner.classList.add('flash');
}

/* ═══════════════════════════════════════════════════
   10. 건축개요 표 렌더링
   ═══════════════════════════════════════════════════ */
function renderOverviewTable(r, t) {
  const g = id => document.getElementById(id);
  const sf = (v, d = 2) => v > 0 ? fmt(v, d) : '0.00';

  const projectName = t('project-name') || '(사업명 미입력)';
  const location = t('location-text') || '—';
  const structure = document.getElementById('structure-type')?.value || '—';
  const use = document.getElementById('building-use')?.value || '—';

  const aboveF = parseInt(document.getElementById('above-floors')?.value) || 0;
  const underF = parseInt(document.getElementById('under-floors')?.value) || 0;
  const scale = aboveF > 0
    ? `지하${underF}층 / 지상${aboveF}층`
    : '—';

  g('t-project-name').textContent = projectName;
  g('doc-project-name-display').textContent = projectName;
  g('t-location').textContent = location;
  g('t-zone').textContent = r.zoneName || '—';
  g('t-structure').textContent = structure;
  g('t-use').textContent = use;
  g('t-scale').textContent = scale;

  if (r.landArea > 0) {
    g('t-land-area').textContent = sf(r.landArea) + ' ㎡';
    g('t-land-area-py').textContent = toPy(r.landArea);
    g('t-contrib-area').textContent = sf(r.contributionArea) + ' ㎡';
    g('t-contrib-area-py').textContent = toPy(r.contributionArea);
    g('t-total-area').textContent = sf(r.landArea + r.contributionArea) + ' ㎡';
    g('t-total-area-py').textContent = toPy(r.landArea + r.contributionArea);

    g('t-build-footprint').textContent = sf(r.estBuildingFootprint) + ' ㎡ (추정)';
    g('t-build-footprint-py').textContent = toPy(r.estBuildingFootprint);

    g('t-bcr').textContent = r.calculatedBcr.toFixed(2) + '%';
    g('t-bcr-legal').textContent = `법정: ${r.legalBcrMax}% 이하 ${r.bcrOk ? '✔ 적합' : '✘ 초과'}`;

    g('t-far').textContent = r.calculatedFar.toFixed(2) + '%';
    const farLimitLabel = r.contributionArea > 0
      ? `완화 상한: ${r.relaxedFarLimit.toFixed(2)}% ${r.farOk ? '✔ 적합' : '✘ 초과'}`
      : `법정: ${r.legalFarMax}% 이하 ${r.farOk ? '✔ 적합' : '✘ 초과'}`;
    g('t-far-legal').textContent = farLimitLabel;
  }

  g('t-households').textContent = r.totalHouseholds > 0
    ? `${r.totalHouseholds.toLocaleString()} 세대`
    : '—';
}

/* ═══════════════════════════════════════════════════
   11. 연면적 세부 내역 테이블 렌더링
   ═══════════════════════════════════════════════════ */
function renderAreaTable(r) {
  const tbody = document.getElementById('area-table-body');
  const sf = (v, d = 2) => fmt(v, d);

  const shopGround = r.shopArea > 0 ? r.shopArea : 0;
  const amenityUnder = r.underAmenityTotal;
  const parkingUnder = r.parkingUnderArea;
  const storageUnder = r.storageArea;
  const machineUnder = r.machineRoomArea;

  const underTotal = parkingUnder + amenityUnder + machineUnder + storageUnder;
  const grandTotal = r.aboveGroundTotal + underTotal;

  let html = '';
  // 공동주택
  html += `<tr><th rowspan="1">공동주택</th><td>주거 합계</td><td class="n-r">${sf(r.housingGroundArea)}</td><td class="n-r">0.00</td><td class="n-r font-bold">${sf(r.housingGroundArea)}</td></tr>`;
  // 부대복리시설
  html += `<tr><th rowspan="7">부대복리<br>시설</th><td>관리사무소</td><td class="n-r">${sf(r.actualOfficeArea)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>경로당</td><td class="n-r">${sf(r.actualSeniorArea)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>어린이집</td><td class="n-r">${sf(r.actualKinderArea)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>작은도서관</td><td class="n-r">${sf(r.actualLibraryArea)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>다함께돌봄센터</td><td class="n-r">${sf(r.actualCareArea)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>경비실</td><td class="n-r">${sf(r.actualGuardArea)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>주민공동시설 (지하)</td><td class="n-r">—</td><td class="n-r">${sf(amenityUnder)}</td><td class="n-r">—</td></tr>`;
  // 지하
  html += `<tr><th rowspan="3">지하시설</th><td>주차장</td><td class="n-r">—</td><td class="n-r">${sf(parkingUnder)}</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>세대창고</td><td class="n-r">—</td><td class="n-r">${sf(storageUnder)}</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>기전실 (지상연면적×4%)</td><td class="n-r">—</td><td class="n-r">${sf(machineUnder)}</td><td class="n-r">—</td></tr>`;
  // 근린생활시설
  if (shopGround > 0) {
    html += `<tr><th>근린생활</th><td>근린생활시설</td><td class="n-r">${sf(shopGround)}</td><td class="n-r">—</td><td class="n-r">${sf(shopGround)}</td></tr>`;
  }
  // 소계
  html += `<tr class="row-highlight"><th colspan="2">소 계</th><td class="n-r font-bold">${sf(r.aboveGroundTotal)}</td><td class="n-r font-bold">${sf(underTotal)}</td><td class="n-r font-bold">${sf(grandTotal)}</td></tr>`;
  html += `<tr><th colspan="2" style="color:#2563eb;">용적률 산정용 연면적</th><td class="n-r font-bold" colspan="2" style="color:#2563eb;">${sf(r.farBaseArea)}</td><td class="n-c t-muted">${toPy(r.farBaseArea)}</td></tr>`;

  tbody.innerHTML = html;
}

/* ═══════════════════════════════════════════════════
   12. 단위세대 면적표 렌더링
   ═══════════════════════════════════════════════════ */
function renderUnitTable(r) {
  const tbody = document.getElementById('unit-table-body');
  const tfoot = document.getElementById('unit-table-foot');
  const sf = (v, d = 4) => fmt(v, d);

  if (r.totalHouseholds === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="align-center t-muted" style="padding:20px;">세대수를 입력하면 자동으로 계산됩니다</td></tr>';
    tfoot.innerHTML = '';
    return;
  }

  let html = '';
  let totCount = 0, totEx = 0, totWall = 0, totCommon = 0, totSupply = 0, totSupplyPy = 0, totEtc = 0, totContract = 0;

  r.unitDetails.forEach(t => {
    if (t.count === 0) return;
    html += `
      <tr>
        <td class="align-center font-bold">${t.name}</td>
        <td class="n-r">${t.count}</td>
        <td class="n-c">${(t.ratio * 100).toFixed(1)}%</td>
        <td class="n-r">${sf(t.areaEx)}</td>
        <td class="n-r">${sf(t.wallShare)}</td>
        <td class="n-r">${sf(t.commonShare)}</td>
        <td class="n-r font-bold">${sf(t.supplyArea)}</td>
        <td class="n-r t-muted">${fmt(t.supplyPy, 2)}</td>
        <td class="n-r">${sf(t.etcShare)}</td>
        <td class="n-r font-bold">${sf(t.contractArea)}</td>
        <td class="n-c">${((r.exclusiveRatio)*100).toFixed(1)}%</td>
      </tr>
    `;
    totCount += t.count;
    totEx += t.count * t.areaEx;
    totWall += t.count * t.wallShare;
    totCommon += t.count * t.commonShare;
    totSupply += t.count * t.supplyArea;
    totSupplyPy += t.count * t.supplyPy;
    totEtc += t.count * t.etcShare;
    totContract += t.count * t.contractArea;
  });

  tbody.innerHTML = html;
  tfoot.innerHTML = `
    <tr class="row-total">
      <td class="align-center font-bold">합계</td>
      <td class="n-r font-bold">${totCount}</td>
      <td class="n-c">100%</td>
      <td class="n-r font-bold">${sf(totEx)}</td>
      <td class="n-r">${sf(totWall)}</td>
      <td class="n-r">${sf(totCommon)}</td>
      <td class="n-r font-bold">${sf(totSupply)}</td>
      <td class="n-r">${fmt(totSupplyPy, 2)}</td>
      <td class="n-r">${sf(totEtc)}</td>
      <td class="n-r font-bold">${sf(totContract)}</td>
      <td class="n-c">${((r.exclusiveRatio)*100).toFixed(1)}%</td>
    </tr>
  `;
}

/* ═══════════════════════════════════════════════════
   13. 법적 검토 탭 렌더링
   ═══════════════════════════════════════════════════ */
function renderLegalTab(r) {
  const g = id => document.getElementById(id);
  const sf = v => fmt(v, 0);
  const badge = (ok) => ok
    ? '<span class="badge-ok">✔ 적합</span>'
    : '<span class="badge-ng">✘ 부적합</span>';

  // 건폐율/용적률 카드 — 제84조 산정방식 표시
  g('lc-bcr-calc').textContent = r.calculatedBcr.toFixed(2) + '%';
  // 복수 용도지역 방식 주석 표시
  let bcrLegalLabel = `법정 ${r.legalBcrMax.toFixed(2)}% 이하`;
  let farLegalBase = `법정 ${r.legalFarMax.toFixed(2)}% 이하`;
  if (r.multiZoneMethod === 'weighted') {
    bcrLegalLabel += ' [제84조①가중평균]';
    farLegalBase += ' [제84조①가중평균]';
  } else if (r.multiZoneMethod === 'independent') {
    bcrLegalLabel += ' [제84조②독립적용]';
    farLegalBase += ' [제84조②독립적용]';
  }
  g('lc-bcr-legal').textContent = bcrLegalLabel;
  const bcrBadge = g('lc-bcr-badge');
  if (r.landArea > 0) {
    bcrBadge.textContent = r.bcrOk ? '✔ 적합' : '✘ 초과';
    bcrBadge.className = 'lc-badge ' + (r.bcrOk ? 'ok' : 'ng');
  }

  g('lc-far-calc').textContent = r.calculatedFar.toFixed(2) + '%';
  const farLim = r.contributionArea > 0 ? r.relaxedFarLimit : r.legalFarMax;
  g('lc-far-legal').textContent = r.contributionArea > 0
    ? `완화 상한 ${farLim.toFixed(2)}%`
    : farLegalBase;
  const farBadge = g('lc-far-badge');
  if (r.landArea > 0) {
    farBadge.textContent = r.farOk ? '✔ 적합' : '✘ 초과';
    farBadge.className = 'lc-badge ' + (r.farOk ? 'ok' : 'ng');
  }


  // 주차 테이블
  if (r.totalHouseholds > 0) {
    g('lt-legal-park').textContent = sf(r.legalParkingCount) + ' 대';
    g('lt-actual-park').textContent = sf(r.totalInstParking) + ' 대';
    g('lt-park-status').innerHTML = badge(r.parkingOk);
    g('lt-expand-park').textContent = sf(r.expandParking) + ' 대 (30% 이상)';
    g('lt-ev-park').textContent = sf(r.evParking) + ' 대 (5% 이상)';
    g('lt-disabled-park').textContent = sf(r.disabledParking) + ' 대 (3% 이상)';
  }

  // 복리시설 테이블
  if (r.totalHouseholds > 0) {
    g('lt-community-legal').textContent = fmt(r.legalCommunityArea, 1) + ' ㎡';
    g('lt-community-actual').textContent = fmt(r.actualCommunityArea, 1) + ' ㎡';
    g('lt-community-status').innerHTML = r.legalCommunityArea > 0 ? badge(r.communityOk) : '100세대 이상 적용';

    g('lt-office-legal').textContent = fmt(r.legalOfficeArea, 1) + ' ㎡';
    g('lt-office-actual').textContent = fmt(r.actualOfficeArea, 1) + ' ㎡';
    g('lt-office-status').innerHTML = badge(r.officeOk);

    g('lt-senior-legal').textContent = r.legalSeniorArea > 0 ? fmt(r.legalSeniorArea, 1) + ' ㎡' : '해당 없음';
    g('lt-senior-actual').textContent = fmt(r.actualSeniorArea, 1) + ' ㎡';
    g('lt-senior-status').innerHTML = r.legalSeniorArea > 0 ? badge(r.seniorOk) : '150세대 이상 적용';

    g('lt-kinder-legal').textContent = r.legalKinderArea > 0
      ? `${fmt(r.legalKinderArea, 1)} ㎡ (정원 ${fmt(r.kinderCapacity, 0)}명)`
      : '해당 없음';
    g('lt-kinder-actual').textContent = fmt(r.actualKinderArea, 1) + ' ㎡';
    g('lt-kinder-status').innerHTML = r.legalKinderArea > 0 ? badge(r.kinderOk) : '300세대 이상 적용';

    g('lt-library-legal').textContent = r.legalLibraryArea > 0 ? fmt(r.legalLibraryArea, 1) + ' ㎡' : '해당 없음';
    g('lt-library-actual').textContent = fmt(r.actualLibraryArea, 1) + ' ㎡';
    g('lt-library-status').innerHTML = r.legalLibraryArea > 0 ? badge(r.libraryOk) : '500세대 이상 적용';

    g('lt-exercise-legal').textContent = r.communityExerciseRequired ? '종목별 규격에 따른 면적' : '해당 없음';
    g('lt-exercise-status').innerHTML = r.communityExerciseRequired ? '<span class="badge-ng">확인 필요</span>' : '500세대 이상 적용';

    g('lt-playground-legal').textContent = r.legalPlaygroundText
      ? r.legalPlaygroundText
      : (r.legalPlaygroundArea > 0 ? fmt(r.legalPlaygroundArea, 0) + ' ㎡' : '해당 없음');

    g('lt-green-legal').textContent = r.landArea > 0 ? fmt(r.legalGreenArea, 1) + ' ㎡' : '—';
    g('lt-green-std').textContent = `대지면적 × ${(r.legalGreenRatio * 100).toFixed(0)}% (${r.zoneName ? getZone(r.zoneName)?.category + '지역' : '용도지역 기준'})`;

    g('lt-openspace-legal').textContent = r.openspaceTarget ? fmt(r.legalOpenspaceArea, 1) + ' ㎡' : '대상 아님';
    g('lt-openspace-status').innerHTML = r.openspaceTarget ? '<span class="badge-ng">확인 필요</span>' : '—';
    g('lt-openspace-std').textContent = `대상 지정 시: 대지면적 × 조례비율(${r.openspaceRatio}%)`;

    g('lt-watertank-legal').textContent = fmt(r.legalWaterTankVolume, 1) + ' 톤';
  }
}

/* ═══════════════════════════════════════════════════
   14. 주차 미니 카드 업데이트
   ═══════════════════════════════════════════════════ */
function updateParkingMiniCard(r) {
  const g = id => document.getElementById(id);
  const sourceEl = g('parking-legal-source');
  if (sourceEl) sourceEl.textContent = r.parkingLegalSource ? `(${r.parkingLegalSource})` : '';

  const planLabel = g('parking-plan-label');
  if (planLabel) {
    planLabel.textContent = r.parkingMode === 'perUnit'
      ? `계획 주차대수 (세대당 ${(g('parking-per-unit')?.value || 1.3)}대)`
      : `계획 주차대수 (법정×${g('parking-multiplier')?.value || 1.2}배)`;
  }

  if (r.totalHouseholds === 0) {
    g('legal-parking-val').textContent = '세대 입력 대기';
    g('actual-parking-val').textContent = `${r.totalInstParking} 대`;
    g('parking-status').textContent = '세대 정보를 먼저 입력하세요';
    g('parking-status').className = 'legal-status';
    return;
  }

  g('legal-parking-val').textContent = `${r.legalParkingCount} 대 이상`;
  g('actual-parking-val').textContent = `${r.totalInstParking} 대`;
  const statusEl = g('parking-status');
  if (r.parkingOk) {
    statusEl.textContent = `✔ 법정 기준 충족 (${r.totalInstParking - r.legalParkingCount}대 여유)`;
    statusEl.className = 'legal-status ok';
  } else {
    statusEl.textContent = `✘ ${r.legalParkingCount - r.totalInstParking}대 부족`;
    statusEl.className = 'legal-status ng';
  }
}

/* ═══════════════════════════════════════════════════
   15. 세대 뱃지 업데이트 (STEP 2 하단)
   ═══════════════════════════════════════════════════ */
function updateCalcBadges(r) {
  document.getElementById('val-households').textContent = r.totalHouseholds.toLocaleString();
  document.getElementById('val-supply-area').textContent = fmt(r.housingGroundArea, 0);
}

/* ═══════════════════════════════════════════════════
   16. 오늘 날짜 설정
   ═══════════════════════════════════════════════════ */
function setTodayDate() {
  const d = new Date();
  document.getElementById('current-date').textContent =
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/* ═══════════════════════════════════════════════════
   17. 로딩 표시
   ═══════════════════════════════════════════════════ */
function showLoading(show) {
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = show ? 'flex' : 'none';
}
