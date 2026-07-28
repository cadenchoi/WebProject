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
  renderComboPicker();
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
   3-1. 조합 선택 UI (9종 주동 유형 시각 다중선택)
   ═══════════════════════════════════════════════════ */
/** comboKey 하나의 로컬 유닛 배치(calculator.js의 UNIT_COMBO_BUILDERS, massing.py와 동일 정의)를
 * 그대로 써서 작은 도형 미리보기 SVG를 만든다 — 실제 배치 결과와 똑같은 모양이어야 사용자가
 * "이 조합을 선택하면 이런 형태가 나온다"를 정확히 알 수 있다(대표값 uw=15,bd=10으로 그리며,
 * 실제 최적화 시에는 세대타입 공급면적에 비례해 폭이 다시 스케일된다 — 여기서는 형태 확인용). */
function comboThumbnailSvg(comboKey) {
  const uw = 15, bd = 10;
  const units = UNIT_COMBO_BUILDERS[comboKey](uw, bd);
  const polys = units.map(u => {
    if (u.diamond) {
      const r = u.s / Math.sqrt(2);
      return [[u.cx + r, u.cy], [u.cx, u.cy + r], [u.cx - r, u.cy], [u.cx, u.cy - r]];
    }
    const hx = u.sx / 2, hy = u.sy / 2;
    return [[u.cx - hx, u.cy - hy], [u.cx + hx, u.cy - hy], [u.cx + hx, u.cy + hy], [u.cx - hx, u.cy + hy]];
  });
  const allPts = polys.flat();
  const xs = allPts.map(p => p[0]), ys = allPts.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  const pad = Math.max(w, h) * 0.15 || 1;
  const vbX = minX - pad, vbY = minY - pad, vbW = w + pad * 2, vbH = h + pad * 2;
  const polyStrs = polys.map(pts =>
    `<polygon points="${pts.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ')}"/>`
  ).join('');
  return `<svg viewBox="${vbX.toFixed(2)} ${vbY.toFixed(2)} ${vbW.toFixed(2)} ${vbH.toFixed(2)}" class="combo-thumb-svg" preserveAspectRatio="xMidYMid meet">${polyStrs}</svg>`;
}

/** 9개 조합 카드를 그린다 — '자동'은 없고, 기본값은 9개 전부 선택(기존 자동 모드와 동일한
 * 탐색 범위)이며 사용자가 원하는 조합만 남기고 해제할 수 있다. */
function renderComboPicker() {
  const container = document.getElementById('combo-picker-grid');
  if (!container) return;
  container.innerHTML = UNIT_COMBO_KEYS.map(key => `
    <label class="combo-picker-card is-checked">
      <input type="checkbox" class="combo-picker-checkbox" value="${key}" checked>
      ${comboThumbnailSvg(key)}
      <span class="combo-picker-name">${UNIT_COMBO_DISPLAY_NAMES[key]}</span>
    </label>
  `).join('');
  container.querySelectorAll('.combo-picker-checkbox').forEach(cb => {
    cb.addEventListener('change', onComboPickerChange);
  });
}

/** 체크박스가 최소 1개는 항상 켜져 있도록 지키면서(0개면 배치 후보 자체가 없어짐) 카드의
 * 선택 표시(.is-checked)를 갱신하고 재계산한다. */
function onComboPickerChange(e) {
  const checkboxes = Array.from(document.querySelectorAll('.combo-picker-checkbox'));
  const checkedCount = checkboxes.filter(cb => cb.checked).length;
  if (checkedCount === 0) {
    e.target.checked = true; // 마지막 하나는 해제 불가
    alert('조합을 최소 1개 이상 선택해야 합니다.');
    return;
  }
  checkboxes.forEach(cb => cb.closest('.combo-picker-card').classList.toggle('is-checked', cb.checked));
  recalculate();
}

/* ═══════════════════════════════════════════════════
   4. 지도 클릭 → 주소 자동 입력 콜백 (다중 필지 선택 대응)
   ═══════════════════════════════════════════════════ */
function onMapLocationSelect({ lat, lng, displayName, address, parcel }) {
  // 주소 표시는 parcel.address(map.js queryAndDrawVWorldParcel의 결과)를 우선한다 — 카카오
  // Geocoder 원본(address/displayName)은 근사 지오코딩이라 실제로 선택된 필지 폴리곤과 다른
  // 지번을 가리킬 수 있는 반면(실측 확인됨: "604-4" 검색·클릭에도 실제로는 604 필지가
  // 선택됨), parcel.address는 VWorld가 그 정확한 좌표에서 실제로 찾아낸 필지 지번과 일치하지
  // 않으면 경고 문구를 덧붙인 값이다. 대지면적 합산 자체는 여전히 '구역계 확정' 버튼 클릭
  // 시에만 수행한다.
  const locInput = document.getElementById('location-text');
  const fullAddress = parcel?.address || address?.address?.address_name || address?.road_address?.address_name || displayName;
  if (fullAddress) {
    locInput.value = fullAddress;
  }
  if (parcel?.addressMismatch) {
    console.warn('[필지 불일치 경고] 검색/클릭한 주소와 실제 선택된 필지의 지번이 다릅니다:', fullAddress);
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
    // 사용자가 도형을 보고 다중선택한 주동 유형(1개 이상) — 배치는 이 목록 안에서만 이뤄진다
    comboModes:           Array.from(document.querySelectorAll('.combo-picker-checkbox:checked')).map(el => el.value),
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
  // 앱에 원문 대조까지 마친 지자체(VERIFIED_CITIES, zones.js)가 아니면 표시되는 수치가
  // 참고치일 수 있다 — 어느 지자체든 사용자가 그 자리에서 바로 법제처 국가법령정보센터
  // 원문을 확인할 수 있는 링크를 함께 보여준다("다른 시에서 작업할 때도 그 지자체에
  // 맞는 법규를 검토할 수 있게 해달라"는 요청 반영).
  const ordinanceUrl = buildOrdinanceSearchUrl(inputs.address, 'zoning');
  const buildingOrdinanceUrl = buildOrdinanceSearchUrl(inputs.address, 'building');
  const parkingOrdinanceUrl = buildOrdinanceSearchUrl(inputs.address, 'parking');
  const ordinanceLinksRow = g('ordinance-check-links');
  const linkBuilding = g('link-building-ordinance');
  const linkParking = g('link-parking-ordinance');
  if (ordinanceLinksRow) {
    if (buildingOrdinanceUrl && parkingOrdinanceUrl) {
      if (linkBuilding) linkBuilding.href = buildingOrdinanceUrl;
      if (linkParking) linkParking.href = parkingOrdinanceUrl;
      ordinanceLinksRow.style.display = '';
    } else {
      ordinanceLinksRow.style.display = 'none';
    }
  }
  const ordinanceLinkHtml = ordinanceUrl
    ? `<div style="grid-column:1/span 3;text-align:right;margin-top:2px;">
         <a href="${ordinanceUrl}" target="_blank" rel="noopener" style="font-size:0.7rem; color:var(--accent); text-decoration:none;">
           🔎 이 지자체 조례 원문 확인(법제처)
         </a>
       </div>`
    : '';
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
        ${ordinanceLinkHtml}
      `;
      badge.style.display = 'grid';
    } else {
      const z = r.zoneBreakdown[0];
      const zoneObj = getZone(z.name) || { category: '기타', desc: '' };
      const unverifiedNote = z.verified === false
        ? `<div style="grid-column:1/span 3;font-size:0.68rem;color:#b45309;background:#fffbeb;border-radius:4px;padding:4px 6px;margin-top:2px;">
             ⚠ 이 지자체 전용 조례를 아직 원문 대조하지 못해 참고치입니다 — 아래 링크로 실제 조례를 확인해 STEP 01의 "조례 건폐율/용적률 상한"란에 직접 입력하세요.
           </div>`
        : '';
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
        ${unverifiedNote}
        ${ordinanceLinkHtml}
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
  renderAmenitySummaryTable(r);
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
  const rowsEl = g('layout-rows');
  const floorsEl = g('layout-required-floors');
  const legalMaxEl = g('layout-legal-max-floors');
  const statusEl = g('layout-status');
  if (!rowsEl || !floorsEl || !statusEl) return;

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
    rowsEl.textContent = '—';
    floorsEl.textContent = '—';
    statusEl.textContent = '구역계를 확정하면 자동 산정됩니다 (개략 근사치, 실시설계 시 재검토 필요)';
    statusEl.className = 'legal-status';
    if (typeof clearLayoutPreview === 'function') clearLayoutPreview();
    return;
  }

  if (!r.layoutInfo) {
    rowsEl.textContent = '—';
    floorsEl.textContent = '—';
    statusEl.textContent = '세대 타입·세대수를 입력하면 자동 산정됩니다';
    statusEl.className = 'legal-status';
    if (typeof clearLayoutPreview === 'function') clearLayoutPreview();
    return;
  }

  const usedEnvelope = !!state.buildableEnvelope;
  const totalBuildingCount = (r.layoutInfo.rows || []).reduce((s, row) => s + (row.buildingCount || 1), 0);
  // 같은 조합이 여러 행에 쓰였으면 한 번만 표기한다(예: "2호(판상형) / 2호(판상형)"처럼
  // 똑같은 이름이 중복 나열되는 것을 막는다 — 요약 카드에서는 어떤 조합이 쓰였는지만 알면 된다).
  const uniqueCombos = usedEnvelope && r.layoutInfo.rows
    ? [...new Set(r.layoutInfo.rows.map(row => row.combo))]
    : [];
  const comboText = uniqueCombos.length > 0 ? ` (호수: ${uniqueCombos.join(' / ')})` : '';
  rowsEl.textContent = r.layoutInfo.maxRows > 0
    ? `총 ${totalBuildingCount}개 동 (${r.layoutInfo.maxRows}개 열, 층당 ${r.layoutInfo.totalUnitsPerFloorAllRows}세대)${comboText}`
    : '배치 불가 (가용폭 부족)';
  floorsEl.textContent = r.layoutInfo.requiredFloors ? `${r.layoutInfo.requiredFloors}층` : '—';

  // 지도 위 개략 배치 미리보기는 그리지 않는다 — layoutInfo는 calculator.js의 옛 판상형 전용
  // 그리디 패킹(estimatePolygonLayout) 결과라, 실제 배치(9종 유닛조합 카탈로그 기반 GA)와 전혀
  // 다른 그림을 보여줬다("틀린 그림", 사용자 피드백) — 정확한 미리보기는 `최적화 배치 실행`
  // (runOptimizeMassing)만 지도에 그린다. drawLayoutPreview/stampFloorCountOnLabels 함수 자체는
  // map.js에 그대로 남아있고 그쪽 경로가 계속 쓴다.

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

/** 지도에 그리기 직전, 각 동 라벨에 층수를 둘째 줄로 붙인다(JS 개략/Python 최적화 결과 공통 사용).
 *  라벨은 "타입\n층수" 두 줄 형식 — map.js가 white-space:pre-line으로 렌더링한다. */
function stampFloorCountOnLabels(layoutInfo, floors) {
  if (!layoutInfo || !floors || !Array.isArray(layoutInfo.rows)) return;
  const suffix = `\n${floors}층`;
  layoutInfo.rows.forEach(row => {
    (row.buildingLabels || []).forEach(bl => {
      if (!bl.text.endsWith(suffix)) bl.text += suffix;
    });
  });
}

/* ═══════════════════════════════════════════════════
   8-2. 최적화 배치(Python/Shapely) 실행 — 회전각·층수 전수 탐색으로
   목표 세대수는 참고하지 않고 이 대지의 법정 최대 수용력을 산출한다.
   기존 실시간 개략 계산(JS)은 그대로 두고, 버튼을 눌렀을 때만 opt-in으로 호출한다
   (연산이 수 초~수십 초 걸릴 수 있어 매 입력마다 자동 실행하지 않음). GA 탐색 자체는
   서버가 백그라운드 스레드로 실행하고(/api/optimize-massing/start), 여기서는 jobId를
   받아 /api/optimize-massing/status/<jobId>를 주기적으로 폴링해 진행률(경과시간·세대·
   재시작)을 보여준다 — 얼마나 걸릴지 전혀 알 수 없던 이전의 "그냥 스피너만 돌기"보다
   구체적인 진행 상황을 준다.
   ═══════════════════════════════════════════════════ */
let _optimizeMassingPollHandle = null;

/** progress_callback 페이로드(massing.py run_ga_search가 세대마다 보고)를 진행률 바
 * 비율(0~1)과 표시 텍스트로 변환한다. restart는 GA 재시작마다 예산이 나뉘므로(예:
 * 전체 90초를 3재시작이면 재시작당 30초) elapsed/wallClockBudget만 쓰면 재시작마다
 * 0%로 되돌아가 보인다 — restart/totalRestarts로 전체 재시작 중 몇 번째인지 함께
 * 반영한다. phase가 'pure'->'mixed'로 바뀌면(항상 일어나는 건 아님 — comboMode가
 * 특정 조합이고 순수 결과가 목표에 못 미칠 때만) 완전히 새로운 예산이 추가되는
 * 것이므로 바를 다시 0%부터 채운다(전체를 미리 "2단계 중 1단계"로 가정하지 않는다). */
function formatOptimizeMassingProgress(info) {
  const phaseLabel = info.phase === 'mixed' ? '2차 혼합 탐색' : '1차 조합 탐색';
  const totalRestarts = info.totalRestarts || 1;
  const restart = info.restart || 1;
  const restartLabel = totalRestarts > 1 ? ` (재시작 ${restart}/${totalRestarts})` : '';
  const elapsedS = info.elapsed != null ? Math.round(info.elapsed) : 0;
  const budgetS = info.wallClockBudget != null ? Math.round(info.wallClockBudget) : null;
  const timeText = budgetS ? `${elapsedS}초 / 약 ${budgetS}초` : `${elapsedS}초`;
  const genText = info.maxGenerations ? `세대 ${info.generation}/${info.maxGenerations}` : `세대 ${info.generation}`;
  const bestText = info.bestHouseholds ? ` · 현재까지 ${info.bestHouseholds.toLocaleString()}세대` : '';
  const withinRestart = info.wallClockBudget > 0 ? Math.max(0, Math.min(1, info.elapsed / info.wallClockBudget)) : 0;
  const fraction = Math.max(0, Math.min(1, (restart - 1 + withinRestart) / totalRestarts));
  return { text: `${phaseLabel}${restartLabel} · ${genText} · ${timeText}${bestText}`, fraction };
}

async function runOptimizeMassing() {
  const btn = document.getElementById('btn-optimize-massing');
  const resultBox = document.getElementById('optimize-massing-result');
  const statusEl = document.getElementById('opt-status');
  const progressWrap = document.getElementById('optimize-massing-progress');
  const progressFill = document.getElementById('opt-progress-fill');
  const progressText = document.getElementById('opt-progress-text');
  if (!btn || !resultBox || !statusEl) return;

  if (!state.buildableEnvelope || !state.envelopeEdges) {
    alert('먼저 지도에서 대지를 선택하고 "구역계 확정"을 눌러주세요.');
    return;
  }
  if (!lastResult || !lastResult.totalHouseholds) {
    alert('세대 타입과 세대수를 먼저 입력해주세요 (평균 전용면적 산정에 필요합니다).');
    return;
  }

  // 이전 폴링이 아직 돌고 있다면(예: 버튼이 비활성화되기 전에 어떻게든 다시 눌린 경우)
  // 먼저 정리한다 — 안 그러면 두 폴링 루프가 동시에 화면을 갱신하게 된다.
  if (_optimizeMassingPollHandle) {
    clearInterval(_optimizeMassingPollHandle);
    _optimizeMassingPollHandle = null;
  }

  const r = lastResult;
  const inputs = buildCalcInputs();
  const areaScale = (r.layoutInfo && r.layoutInfo.areaScale) || 1;
  const avgFarAreaPerHousehold = r.totalHouseholds > 0 ? r.farBaseArea / r.totalHouseholds : 0;

  // massing.py(정밀 GA)는 zoneName/zoneBreakdown을 전혀 받지 않으므로 calculator.js의
  // "준주거·근린상업은 0.25, 그 외 0.5 자동 적용" 완화 규칙을 스스로 적용할 수 없다 — 입력칸을
  // 비워두면(inputs.buildingGapRatio===null) 그냥 하드코딩된 0.5로 폴백해, 준주거지역 대지에서도
  // 실제 필요한 것보다 2배 넓은 인동간격을 요구해 용적률이 크게 미달되는 원인이 됐다. 여기서
  // calculator.js와 동일한 완화 규칙을 미리 적용해 항상 확정된 숫자를 넘긴다.
  const relaxedGapZone = (r.zoneBreakdown || []).some(z => z.name === '준주거지역' || z.name === '근린상업지역');
  const effectiveBuildingGapRatio = (inputs.buildingGapRatio !== null && inputs.buildingGapRatio !== undefined)
    ? inputs.buildingGapRatio
    : (relaxedGapZone ? 0.25 : 0.5);

  const payload = {
    buildableEnvelope: state.buildableEnvelope,
    envelopeEdges: state.envelopeEdges,
    unitTypeList: (r.unitDetails || []).filter(t => t.count > 0).map(t => ({ name: t.name, supplyArea: t.supplyArea, count: t.count })),
    standardBuildingDepth: (inputs.standardBuildingDepth || 10) * areaScale,
    standardUnitWidth: (inputs.standardUnitWidth || 15) * areaScale,
    coreWidth: inputs.coreWidth,
    comboModes: inputs.comboModes,
    // massing.py가 정북일조 적용 대상 지역(전용주거·일반주거)인지 판단하는 데 필요 — 준주거 등은
    // 이 조항 자체가 미적용이라 정북 이격을 아예 안 걸어야 한다(main.js도 zoneName을 안 보내면
    // 예전처럼 항상 적용하는 쪽으로 안전 폴백한다).
    zoneName: inputs.zoneName,
    northSetbackRatio: inputs.northSetbackRatio,
    buildingGapRatio: effectiveBuildingGapRatio,
    floorHeight1Mm: inputs.floorHeight1Mm,
    floorHeight2Mm: inputs.floorHeight2Mm,
    floorHeight3Mm: inputs.floorHeight3Mm,
    floorHeightTypicalMm: inputs.floorHeightTypicalMm,
    landArea: r.landArea,
    legalBcrMax: r.legalBcrMax,
    legalFarMax: r.legalFarMax,
    relaxedFarLimit: r.relaxedFarLimit,
    avgFarAreaPerHousehold,
    allowOver50Floors: document.getElementById('allow-over-50-floors')?.checked || false,
    gaWallClockS: Number(document.getElementById('ga-wall-clock-s')?.value) || 180,
    gaRestarts: Number(document.getElementById('ga-restarts')?.value) || 2
  };

  const originalBtnHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 탐색 중...';
  resultBox.style.display = 'none';
  statusEl.textContent = '';
  statusEl.className = 'legal-status';
  if (progressWrap) progressWrap.style.display = 'block';
  if (progressText) progressText.textContent = '작업을 시작하는 중...';
  if (progressFill) progressFill.style.width = '0%';

  const finish = () => {
    if (_optimizeMassingPollHandle) {
      clearInterval(_optimizeMassingPollHandle);
      _optimizeMassingPollHandle = null;
    }
    btn.disabled = false;
    btn.innerHTML = originalBtnHtml;
    if (progressWrap) progressWrap.style.display = 'none';
  };

  const showError = message => {
    finish();
    resultBox.style.display = 'block';
    renderOptimizeMassingResult({ error: message }, r);
  };

  const started = await startOptimizeMassingJob(payload);
  if (started.error) {
    showError(started.error);
    return;
  }

  const jobId = started.jobId;
  _optimizeMassingPollHandle = setInterval(async () => {
    const status = await fetchOptimizeMassingStatus(jobId);
    if (status.error) {
      // 폴링 도중 작업을 찾을 수 없어졌다면(개발서버가 파일 변경으로 재시작되는 등)
      // "계속 기다리는 중"으로 보이지 말고 명확한 오류로 알린다.
      showError(status.lost ? '작업을 찾을 수 없습니다(서버가 재시작되었을 수 있습니다) — 다시 실행해주세요' : status.error);
      return;
    }
    if (status.status === 'error') {
      showError(status.error || '알 수 없는 오류');
      return;
    }
    if (status.status === 'running') {
      if (status.progress) {
        const { text, fraction } = formatOptimizeMassingProgress(status.progress);
        if (progressText) progressText.textContent = text;
        if (progressFill) progressFill.style.width = `${Math.round(fraction * 100)}%`;
      }
      return;
    }
    if (status.status === 'done') {
      finish();
      resultBox.style.display = 'block';
      renderOptimizeMassingResult(status.result, r);
    }
  }, 600);
}

/** 최적화 배치 실행 결과를 opt-* 엘리먼트에 표시한다 — 폴링 완료 시점에만 호출된다. */
function renderOptimizeMassingResult(result, r) {
  const statusEl = document.getElementById('opt-status');
  const hEl = document.getElementById('opt-households');
  const shapeEl = document.getElementById('opt-shape');
  const frEl = document.getElementById('opt-floors-rot');
  const farEl = document.getElementById('opt-far');
  const bcrEl = document.getElementById('opt-bcr');
  const heightEl = document.getElementById('opt-assumed-height');
  const scoreEl = document.getElementById('opt-score-breakdown');
  const setbackWrap = document.getElementById('opt-setback-wrap');
  if (!statusEl) return;

  if (result.error || result.noFit) {
    if (hEl) hEl.textContent = '—';
    if (shapeEl) shapeEl.textContent = '—';
    if (frEl) frEl.textContent = '—';
    if (farEl) farEl.textContent = '—';
    if (bcrEl) bcrEl.textContent = '—';
    if (heightEl) heightEl.textContent = '—';
    if (scoreEl) scoreEl.textContent = '—';
    if (setbackWrap) setbackWrap.style.display = 'none';
    statusEl.textContent = result.error ? `⚠ 오류: ${result.error}` : '⚠ 이 대지/조건에서는 배치 가능한 조합을 찾지 못했습니다 — 조례 이격거리·세대폭·코어폭을 조정해보세요';
    statusEl.className = 'legal-status ng';
    return;
  }

  if (hEl) hEl.textContent = `${result.achievedHouseholds.toLocaleString()} 세대`;
  if (shapeEl) shapeEl.textContent = result.buildingShape || '—';
  if (frEl) {
    const floorsText = (result.minFloors != null && result.maxFloors != null && result.minFloors !== result.maxFloors)
      ? `${result.minFloors}~${result.maxFloors}층(동별 상이)`
      : `${result.chosenFloors}층`;
    frEl.textContent = `${floorsText} / 회전 ${result.rotationDeg}도`;
  }
  if (farEl) farEl.textContent = `${result.achievedFar}% (목표 ${result.farCapTarget}%)`;
  if (bcrEl) bcrEl.textContent = `${result.achievedBcr}% (법정 ${r.legalBcrMax}% 이하)`;
  if (heightEl) heightEl.textContent = result.assumedHeightM ? `${result.assumedHeightM}m (최고 ${result.maxFloors || result.chosenFloors}층 기준)` : '—';
  if (scoreEl) {
    const b = result.bestScoreBreakdown;
    scoreEl.textContent = b
      ? `남향 ${Math.round(b.southScore * 100)}% · 균형 ${Math.round(b.balanceScore * 100)}% · 마주보기 회피 ${Math.round(b.facingAvoidanceScore * 100)}% · 층수 평탄화 ${Math.round((b.floorSmoothScore ?? 0) * 100)}% · 그리드 규칙성 ${Math.round((b.gridRegularityScore ?? 0) * 100)}%`
      : '—';
  }

  // 변별 이격거리 상세 표: 배치가 각 기준선(정북·인접대지·도로중심선)과 동간 거리를 얼마나
  // 여유있게(또는 빠듯하게) 만족하는지 직접 확인할 방법이 없다는 피드백에 따라, 이미 계산되어
  // 있던 result.setbackReport를 표로 채워 넣는다(그동안은 데이터는 만들어놓고 항상 숨겨서
  // "✔ 만족" 문구만 보이고 실제 근거는 검증할 수 없었다).
  const setbackBody = document.getElementById('opt-setback-body');
  if (setbackWrap && setbackBody) {
    const report = result.setbackReport || [];
    if (report.length > 0) {
      setbackBody.innerHTML = report.map(d => {
        const required = d.requiredSetbackM;
        const actual = d.actualDistanceM;
        const ok = (actual == null || required == null) ? true : actual >= required - 0.01;
        const ratioText = d.exempted ? '면제' : (d.ratio != null ? `${d.ratio}H` : '—');
        const requiredText = required != null ? `${required.toFixed(2)}m` : '—';
        const actualText = actual != null ? `${actual.toFixed(2)}m` : '—';
        return `<tr class="${ok ? '' : 'ng'}"><td>${d.referenceLine || '—'}</td><td>${ratioText}</td><td>${requiredText}</td><td>${actualText}</td></tr>`;
      }).join('');
      setbackWrap.style.display = 'block';
    } else {
      setbackBody.innerHTML = '';
      setbackWrap.style.display = 'none';
    }
  }

  // 인동간격·채광사선(도로중심선 기준 포함)·정북일조 이격에 저촉하는 동은 유전자 평가 단계에서
  // 이미 제외되므로(massing.py evaluate_genome), 여기 도달한 best는 항상 검증을 통과한 배치다.
  const cappedNote = result.cappedAt50 ? ' — 50층 제한에 도달했습니다. 더 높은 층수도 탐색하려면 위 체크박스를 켜고 다시 실행해보세요.' : '';
  const stats = result.searchStats || {};
  statusEl.textContent = `✔ 인동간격·채광사선·정북일조 이격 기준을 만족하는 배치만 채택 (유전 알고리즘 ${stats.generationsRun}세대 × 개체 ${stats.populationSize}개 탐색, ${stats.elapsedMs}ms)${cappedNote}`;
  statusEl.className = 'legal-status ok';

  if (typeof drawLayoutPreview === 'function' && state.siteDimensions) {
    // 정밀 최적화 결과는 massing.py _unit_label_text가 유닛별 실제 층수를 라벨에 이미 넣어
    // 보내므로(동 안에서도 유닛마다 층수가 다를 수 있음), 대표 층수 하나(chosenFloors)를
    // 덧붙이면 서로 다른 두 층수 표기가 겹쳐 보인다(예: "10층 · 28층") — 여기서는 찍지 않는다.
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
  const suffix = ' (정밀 최적화 결과)';
  const floorsText = (result.minFloors != null && result.maxFloors != null && result.minFloors !== result.maxFloors)
    ? `${result.minFloors}~${result.maxFloors}층`
    : `${result.chosenFloors}층`;

  // ── 핵심지표요약 패널(sum-*) ──
  const bcrEl2 = g('sum-val-bcr'), bcrLimitEl = g('sum-limit-bcr'), bcrBarEl = g('sum-bar-bcr'), bcrItemEl = g('sum-bcr');
  const farEl2 = g('sum-val-far'), farLimitEl = g('sum-limit-far'), farBarEl = g('sum-bar-far'), farItemEl = g('sum-far');
  if (bcrEl2) bcrEl2.textContent = result.achievedBcr.toFixed(1) + '%';
  if (bcrLimitEl) bcrLimitEl.textContent = `법정: ${r.legalBcrMax}% 이하${suffix}`;
  if (bcrBarEl) bcrBarEl.style.width = Math.min(result.achievedBcr / r.legalBcrMax, 1) * 100 + '%';
  if (bcrItemEl) bcrItemEl.className = 'summary-item ' + (result.achievedBcr <= r.legalBcrMax + 0.01 ? 'ok' : 'ng');

  if (farEl2) farEl2.textContent = result.achievedFar.toFixed(1) + '%';
  if (farLimitEl) farLimitEl.textContent = `목표: ${result.farCapTarget}% (정밀 최적화 결과)`;
  if (farBarEl) farBarEl.style.width = Math.min(result.achievedFar / result.farCapTarget, 1) * 100 + '%';
  if (farItemEl) farItemEl.className = 'summary-item ' + (result.achievedFar <= result.farCapTarget + 0.01 ? 'ok' : 'ng');

  // ── 상단 설계개요 배너(ob-*) ──
  if (g('ob-bcr')) g('ob-bcr').textContent = `${result.achievedBcr.toFixed(1)}%`;
  if (g('ob-far')) g('ob-far').textContent = `${result.achievedFar.toFixed(1)}%`;
  if (g('ob-households')) g('ob-households').textContent = `${result.achievedHouseholds.toLocaleString()} 세대${suffix}`;

  // ── 건축개요 미리보기 표(t-*) ──
  if (g('t-bcr')) g('t-bcr').textContent = result.achievedBcr.toFixed(2) + '%';
  if (g('t-bcr-legal')) g('t-bcr-legal').textContent = `법정: ${r.legalBcrMax}% 이하 ${result.achievedBcr <= r.legalBcrMax + 0.01 ? '✔ 적합' : '✘ 초과'}${suffix}`;
  if (g('t-far')) g('t-far').textContent = result.achievedFar.toFixed(2) + '%';
  if (g('t-far-legal')) g('t-far-legal').textContent = `목표: ${result.farCapTarget}% ${result.achievedFar <= result.farCapTarget + 0.01 ? '✔ 적합' : '✘ 초과'}${suffix}`;
  if (g('t-households')) g('t-households').textContent = `${result.achievedHouseholds.toLocaleString()} 세대${suffix}`;
  if (g('t-scale')) g('t-scale').textContent = `${floorsText} (정밀 최적화 채택안, 지상)`;

  // ── 법적 검토 탭 계산값(lc-*) ──
  if (g('lc-bcr-calc')) g('lc-bcr-calc').textContent = result.achievedBcr.toFixed(2) + '%' + suffix;
  if (g('lc-far-calc')) g('lc-far-calc').textContent = result.achievedFar.toFixed(2) + '%' + suffix;
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

  if (r.landArea > 0) {
    g('t-green-area').textContent = sf(r.legalGreenArea) + ' ㎡ 이상';
    g('t-green-legal').textContent = `법정: ${r.greenLegalBasis || (Math.round(r.legalGreenRatio * 100) + '% 이상')}`;
  }
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

  // 법적 근거 열은 항목별로 지금 세대수 구간에 실제 해당하는 산식 하나만 보여준다(calculate()가
  // totalHouseholds 기준으로 이미 골라둔 텍스트를 그대로 표시) — 부대복리시설은 세대수 구간마다
  // 적용 산식 자체가 달라지므로, 여기 값은 세대수를 바꾸면 그 즉시 다른 문구로 바뀐다.
  const basis = v => `<td class="t-muted" style="font-size:11px; line-height:1.4;">${v || '—'}</td>`;

  let html = '';
  // 공동주택
  html += `<tr><th rowspan="1">공동주택</th><td>주거 합계</td>${basis('—')}<td class="n-r">${sf(r.housingGroundArea)}</td><td class="n-r">0.00</td><td class="n-r font-bold">${sf(r.housingGroundArea)}</td></tr>`;
  // 부대복리시설
  html += `<tr><th rowspan="7">부대복리<br>시설</th><td>관리사무소</td>${basis(r.officeLegalBasis)}<td class="n-r">${sf(r.actualOfficeArea)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>경로당</td>${basis(r.seniorLegalBasis)}<td class="n-r">${sf(r.actualSeniorArea)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>어린이집</td>${basis(r.kinderLegalBasis)}<td class="n-r">${sf(r.actualKinderArea)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>작은도서관</td>${basis(r.libraryLegalBasis)}<td class="n-r">${sf(r.actualLibraryArea)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>다함께돌봄센터</td>${basis(r.careLegalBasis)}<td class="n-r">${sf(r.actualCareArea)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>경비실</td>${basis(r.guardLegalBasis)}<td class="n-r">${sf(r.actualGuardArea)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>주민공동시설 (지하)</td>${basis(r.communityLegalBasis)}<td class="n-r">—</td><td class="n-r">${sf(amenityUnder)}</td><td class="n-r">—</td></tr>`;
  // 지하
  html += `<tr><th rowspan="3">지하시설</th><td>주차장</td>${basis('—')}<td class="n-r">—</td><td class="n-r">${sf(parkingUnder)}</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>세대창고</td>${basis(r.storageLegalBasis)}<td class="n-r">—</td><td class="n-r">${sf(storageUnder)}</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>기전실 (지상연면적×4%)</td>${basis(r.machineRoomLegalBasis)}<td class="n-r">—</td><td class="n-r">${sf(machineUnder)}</td><td class="n-r">—</td></tr>`;
  // 근린생활시설
  if (shopGround > 0) {
    html += `<tr><th>근린생활</th><td>근린생활시설</td>${basis('—')}<td class="n-r">${sf(shopGround)}</td><td class="n-r">—</td><td class="n-r">${sf(shopGround)}</td></tr>`;
  }
  // 소계
  html += `<tr class="row-highlight"><th colspan="2">소 계</th>${basis('—')}<td class="n-r font-bold">${sf(r.aboveGroundTotal)}</td><td class="n-r font-bold">${sf(underTotal)}</td><td class="n-r font-bold">${sf(grandTotal)}</td></tr>`;
  html += `<tr><th colspan="2" style="color:#2563eb;">용적률 산정용 연면적</th>${basis('—')}<td class="n-r font-bold" colspan="2" style="color:#2563eb;">${sf(r.farBaseArea)}</td><td class="n-c t-muted">${toPy(r.farBaseArea)}</td></tr>`;

  tbody.innerHTML = html;
}

/* ═══════════════════════════════════════════════════
   11-1. 부대복리시설 총괄표 + 주차대수 렌더링
   ═══════════════════════════════════════════════════ */
function renderAmenitySummaryTable(r) {
  const tbody = document.getElementById('amenity-table-body');
  const parkBody = document.getElementById('parking-table-body');
  if (!tbody || !parkBody) return;
  const sf = (v, d = 2) => fmt(v, d);

  if (r.totalHouseholds === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="align-center t-muted" style="padding:20px;">세대수를 입력하면 자동으로 계산됩니다</td></tr>';
    parkBody.innerHTML = '';
    return;
  }

  const basis = v => `<td class="t-muted" style="font-size:11px; line-height:1.4;">${v || '—'}</td>`;
  const plan = v => `<td class="n-r">${v}</td>`;

  let html = '';
  html += `<tr><th rowspan="4">공용<br>시설</th><td>관리사무소</td>${basis(r.officeLegalBasis)}${plan(sf(r.actualOfficeArea) + ' ㎡')}</tr>`;
  html += `<tr><td>기계/전기실</td>${basis(r.machineRoomLegalBasis)}${plan(sf(r.machineRoomArea) + ' ㎡')}</tr>`;
  html += `<tr><td>경비실</td>${basis(r.guardLegalBasis)}${plan(sf(r.actualGuardArea) + ' ㎡')}</tr>`;
  html += `<tr><td>세대창고</td>${basis(r.storageLegalBasis)}${plan(sf(r.actualStorageArea) + ' ㎡ (' + r.totalHouseholds + '세대분)')}</tr>`;

  html += `<tr><th rowspan="6">주민<br>공동시설</th><td>경로당</td>${basis(r.seniorLegalBasis)}${plan(sf(r.actualSeniorArea) + ' ㎡')}</tr>`;
  html += `<tr><td>작은도서관</td>${basis(r.libraryLegalBasis)}${plan(sf(r.actualLibraryArea) + ' ㎡')}</tr>`;
  html += `<tr><td>키즈라운지(다함께돌봄센터)</td>${basis(r.careLegalBasis)}${plan(sf(r.actualCareArea) + ' ㎡')}</tr>`;
  html += `<tr><td>어린이집</td>${basis(r.kinderLegalBasis)}${plan(sf(r.actualKinderArea) + ' ㎡' + (r.kinderCapacity > 0 ? ` (정원 ${Math.ceil(r.kinderCapacity)}명)` : ''))}</tr>`;
  html += `<tr><td>어린이놀이터 <span class="t-muted" style="font-size:10px;">(옥외)</span></td>${basis(r.playgroundLegalBasis)}${plan(r.legalPlaygroundArea > 0 ? sf(r.legalPlaygroundArea) + ' ㎡ 이상' : (r.legalPlaygroundText || '해당 없음'))}</tr>`;
  html += `<tr><td>주민운동시설 <span class="t-muted" style="font-size:10px;">(옥외)</span></td>${basis(r.exerciseLegalBasis)}${plan(r.communityExerciseRequired ? '별도 설계 (확인 필요)' : '해당 없음')}</tr>`;

  html += `<tr class="row-highlight"><th colspan="2">주민공동시설 소계</th>${basis(r.communityLegalBasis)}<td class="n-r font-bold">${sf(r.actualCommunityArea)} ㎡</td></tr>`;

  if (r.shopArea > 0) {
    html += `<tr><th>근린생활</th><td>근린생활시설</td>${basis('—')}${plan(sf(r.shopArea) + ' ㎡')}</tr>`;
  }

  tbody.innerHTML = html;

  let parkHtml = '';
  parkHtml += `<tr><th rowspan="4">주차대수</th><td>총 주차대수 <span class="t-muted" style="font-size:10px;">(${r.parkingLegalSource || ''})</span></td>${basis('세대별 전용면적 기준 산정 (주택건설기준 등에 관한 규정)')}<td class="n-r font-bold">${r.legalParkingCount} 대 이상 / 계획 ${r.totalInstParking} 대</td></tr>`;
  parkHtml += `<tr><td>확장형</td>${basis('총 주차대수의 30% 이상')}${plan(r.expandParking + ' 대')}</tr>`;
  parkHtml += `<tr><td>전기차 충전</td>${basis('총 주차대수의 5% 이상')}${plan(r.evParking + ' 대')}</tr>`;
  parkHtml += `<tr><td>장애인 전용</td>${basis('총 주차대수의 3% 이상')}${plan(r.disabledParking + ' 대')}</tr>`;
  parkBody.innerHTML = parkHtml;
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

    g('lt-storage-legal').textContent = r.legalStorageArea > 0 ? fmt(r.legalStorageArea, 1) + ' ㎡' : '해당 없음';
    g('lt-storage-actual').textContent = fmt(r.actualStorageArea, 1) + ' ㎡';
    g('lt-storage-status').innerHTML = r.legalStorageArea > 0 ? badge(r.storageOk) : '전용 50㎡ 이상 세대 없음';

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
