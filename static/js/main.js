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
  ]
};

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
  if (address) {
    locInput.value = address.address_name || displayName;
  }
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

      alert(`${data.count}개 필지(총 ${data.totalAreaM2.toLocaleString()}㎡)가 구역계로 확정되었습니다.`);
      switchTab('overview');
      recalculate();
    });
  }

  // 구역계 취소 버튼
  const btnClearBoundary = document.getElementById('btn-clear-boundary');
  if (btnClearBoundary) {
    btnClearBoundary.addEventListener('click', () => {
      if (confirm('선택된 구역계(필지)를 모두 취소하시겠습니까?')) {
        clearParcelBoundary();
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

  // 모든 입력 필드 → 실시간 재계산
  const allInputs = [
    'land-area', 'contrib-area', 'local-bcr', 'local-far',
    'above-floors', 'under-floors', 'exclusive-ratio',
    'parking-multiplier', 'parking-area-per-space', 'storage-area',
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
function recalculate() {
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
    // 층수 (비워두면 자동 추정)
    aboveFloorsManual:    vn('above-floors'),
    underFloorsManual:    vn('under-floors'),
    // 주차: 배수 방식
    parkingMultiplier:    v('parking-multiplier') || 1.2,
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
    exclusiveRatio:       (v('exclusive-ratio') || 74.8) / 100
  };

  const r = calculate(inputs);

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
  if (g('auto-office-val'))    g('auto-office-val').textContent    = sf0(r.autoOfficeArea);
  if (g('auto-guard-val'))     g('auto-guard-val').textContent     = sf0(r.autoGuardArea);
  if (g('auto-senior-val'))    g('auto-senior-val').textContent    = r.legalSeniorArea > 0 ? `${Math.round(r.autoSeniorArea)} ㎡ (법정: ${Math.round(r.legalSeniorArea)}㎡)` : '해당없음';
  if (g('auto-kinder-val'))    g('auto-kinder-val').textContent    = r.legalKinderArea > 0 ? `${Math.round(r.autoKinderArea)} ㎡ (법정: ${Math.round(r.legalKinderArea)}㎡)` : '해당없음';
  if (g('auto-community-val')) g('auto-community-val').textContent = r.legalCommunityArea > 0 ? `${Math.round(r.autoCommunityUnder)} ㎡` : '해당없음';

  // ── 주차 계획 배지 업데이트 ──────────────────────────
  const pmDisplay = g('parking-mult-display');
  if (pmDisplay) pmDisplay.textContent = (inputs.parkingMultiplier).toFixed(1);
  const parkAreaEst = g('parking-area-est');
  if (parkAreaEst) parkAreaEst.textContent = r.parkingUnderArea > 0 ? `${Math.round(r.parkingUnderArea).toLocaleString()} ㎡` : '— ㎡';
  const amenMultLabel = g('amenity-mult-label');
  if (amenMultLabel) amenMultLabel.textContent = `법정면적 ×${(inputs.amenityMultiplier).toFixed(1)}`;

  // ── 계산 결과 반영 ────────────────────────────────────
  updateSummaryPanel(r);
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

  // 건폐율
  const bcrPct = r.calculatedBcr.toFixed(1) + '%';
  g('sum-val-bcr').textContent = bcrPct;
  g('sum-limit-bcr').textContent = `법정: ${r.legalBcrMax}% 이하`;
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
  const amenityGround = r.groundAmenityTotal;
  const amenityUnder = r.underAmenityTotal;
  const parkingUnder = parseFloat(document.getElementById('parking-area')?.value) || 0;
  const storageUnder = parseFloat(document.getElementById('storage-area')?.value) || 0;
  const machineUnder = r.machineRoomArea;

  const underTotal = parkingUnder + amenityUnder + machineUnder + storageUnder;
  const grandTotal = r.aboveGroundTotal + underTotal;

  const rows = [
    ['공동주택', sf(r.housingGroundArea), '0.00', sf(r.housingGroundArea), '주거'],
    ['관리사무소', sf(r.groundAmenityTotal > 0 ? parseFloat(document.getElementById('area-office')?.value)||0 : 0), '—', '', '부대복리'],
    ['경로당', sf(parseFloat(document.getElementById('area-senior')?.value)||0), '—', '', '부대복리'],
    ['어린이집', sf(parseFloat(document.getElementById('area-kinder')?.value)||0), '—', '', '부대복리'],
    ['작은도서관', sf(parseFloat(document.getElementById('area-library')?.value)||0), '—', '', '부대복리'],
    ['다함께돌봄센터', sf(parseFloat(document.getElementById('area-care')?.value)||0), '—', '', '부대복리'],
    ['경비실', sf(parseFloat(document.getElementById('area-guard')?.value)||0), '—', '', '부대복리'],
    ['기타 주민공동시설', '—', sf(amenityUnder), '', '부대복리'],
    ['주차장', '—', sf(parkingUnder), '', '지하'],
    ['세대창고', '—', sf(storageUnder), '', '지하'],
    ['기전실 (지상연면적×4%)', '—', sf(machineUnder), '', '지하'],
    ['근린생활시설', sf(shopGround), '—', sf(shopGround), '상업'],
  ];

  let html = '';
  // 공동주택
  html += `<tr><th rowspan="1">공동주택</th><td>주거 합계</td><td class="n-r">${sf(r.housingGroundArea)}</td><td class="n-r">0.00</td><td class="n-r font-bold">${sf(r.housingGroundArea)}</td></tr>`;
  // 부대복리시설
  html += `<tr><th rowspan="7">부대복리<br>시설</th><td>관리사무소</td><td class="n-r">${sf(parseFloat(document.getElementById('area-office')?.value)||0)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>경로당</td><td class="n-r">${sf(parseFloat(document.getElementById('area-senior')?.value)||0)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>어린이집</td><td class="n-r">${sf(parseFloat(document.getElementById('area-kinder')?.value)||0)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>작은도서관</td><td class="n-r">${sf(parseFloat(document.getElementById('area-library')?.value)||0)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>다함께돌봄센터</td><td class="n-r">${sf(parseFloat(document.getElementById('area-care')?.value)||0)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
  html += `<tr><td>경비실</td><td class="n-r">${sf(parseFloat(document.getElementById('area-guard')?.value)||0)}</td><td class="n-r">—</td><td class="n-r">—</td></tr>`;
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
    tbody.innerHTML = '<tr><td colspan="9" class="align-center t-muted" style="padding:20px;">세대수를 입력하면 자동으로 계산됩니다</td></tr>';
    tfoot.innerHTML = '';
    return;
  }

  let html = '';
  let totCount = 0, totEx = 0, totWall = 0, totCommon = 0, totSupply = 0, totSupplyPy = 0;

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
        <td class="n-c">${((r.exclusiveRatio)*100).toFixed(1)}%</td>
      </tr>
    `;
    totCount += t.count;
    totEx += t.count * t.areaEx;
    totWall += t.count * t.wallShare;
    totCommon += t.count * t.commonShare;
    totSupply += t.count * t.supplyArea;
    totSupplyPy += t.count * t.supplyPy;
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

    g('lt-senior-legal').textContent = r.legalSeniorArea > 0 ? fmt(r.legalSeniorArea, 1) + ' ㎡' : '해당 없음';
    g('lt-senior-actual').textContent = fmt(r.actualSeniorArea, 1) + ' ㎡';
    g('lt-senior-status').innerHTML = r.legalSeniorArea > 0 ? badge(r.seniorOk) : '150세대 이상 적용';

    g('lt-kinder-legal').textContent = r.legalKinderArea > 0 ? fmt(r.legalKinderArea, 1) + ' ㎡' : '해당 없음';
    g('lt-kinder-actual').textContent = fmt(r.actualKinderArea, 1) + ' ㎡';
    g('lt-kinder-status').innerHTML = r.legalKinderArea > 0 ? badge(r.kinderOk) : '300세대 이상 적용';

    g('lt-playground-legal').textContent = r.legalPlaygroundArea > 0 ? fmt(r.legalPlaygroundArea, 0) + ' ㎡' : '해당 없음';
    g('lt-green-legal').textContent = r.landArea > 0 ? fmt(r.legalGreenArea, 1) + ' ㎡' : '—';
    g('lt-green-std').textContent = `대지면적 × ${(r.legalGreenRatio * 100).toFixed(0)}% (${r.zoneName ? getZone(r.zoneName)?.category + '지역' : '용도지역 기준'})`;
  }
}

/* ═══════════════════════════════════════════════════
   14. 주차 미니 카드 업데이트
   ═══════════════════════════════════════════════════ */
function updateParkingMiniCard(r) {
  const g = id => document.getElementById(id);
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
