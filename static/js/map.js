/**
 * map.js (v3 — 카카오맵 + 지적편집도 + 브이월드 필지 경계)
 * Kakao Maps API 기반 지도 모듈 (API Key 필요)
 * 클릭 시 브이월드 Open API(프록시)를 통해 필지 폴리곤을 가져옵니다.
 */

let kakaoMap = null;
let currentMarker = null;
let selectedParcels = {}; // 다중 필지 선택 저장소 { pnu: { areaM2, jibun, polygon, geom } }

let isDistrictLayerOn = true; // 지적편집도 활성화 상태

/* ─────────────────────────────────────────────
   1. 카카오 지도 초기화
───────────────────────────────────────────── */
function showMapError(container, message, details = "") {
  container.innerHTML = `
    <div style="padding: 20px; text-align: center; color: var(--text-main); background: var(--bg-card); border: 1px solid var(--danger); border-radius: var(--radius-md); position: absolute; top:50%; left:50%; transform:translate(-50%, -50%); width: 80%; max-width: 450px; box-shadow: var(--shadow-lg);">
      <i class="fa-solid fa-circle-exclamation" style="font-size: 2.5rem; color: var(--danger); margin-bottom: 12px;"></i>
      <h3 style="margin-bottom: 8px; color: var(--text-white);">지도 로드 실패</h3>
      <p style="font-size: 0.9rem; color: var(--text-sub); margin-bottom: 12px; line-height: 1.5;">${message}</p>
      ${details ? `<div style="font-size: 0.75rem; background: var(--bg-input); padding: 8px; border-radius: 4px; color: var(--danger); text-align: left; font-family: monospace; white-space: pre-wrap;">${details}</div>` : ''}
    </div>
  `;
}

function initMap(containerId, onLocationSelect) {
  const container = document.getElementById(containerId);
  if (!container) return null;

  // 카카오맵 API가 로드되지 않았다면 (API Key 없음 또는 네트워크 차단)
  if (typeof kakao === 'undefined' || !kakao.maps) {
    showMapError(container, 
      "카카오맵 SDK가 로드되지 않았습니다. API 키가 올바르지 않거나 카카오 개발자 센터에 도메인이 등록되지 않았을 수 있습니다.<br>콘솔(F12) 에러를 참고해 주세요."
    );
    return null;
  }

  try {
    const options = {
      center: new kakao.maps.LatLng(37.5665, 126.9780), // 서울시청 기본
      level: 4 // 확대 레벨
    };

    kakaoMap = new kakao.maps.Map(container, options);

    // 일반 지도/스카이뷰 컨트롤
    const mapTypeControl = new kakao.maps.MapTypeControl();
    kakaoMap.addControl(mapTypeControl, kakao.maps.ControlPosition.TOPRIGHT);
    
    // 줌 컨트롤
    const zoomControl = new kakao.maps.ZoomControl();
    kakaoMap.addControl(zoomControl, kakao.maps.ControlPosition.RIGHT);

    // 지적편집도 기본 활성화 (토지이음 스타일)
    kakaoMap.addOverlayMapTypeId(kakao.maps.MapTypeId.USE_DISTRICT);

    // 지적편집도 토글 버튼 이벤트
    const btnToggle = document.getElementById('btn-toggle-district');
    if (btnToggle) {
      btnToggle.addEventListener('click', () => {
        isDistrictLayerOn = !isDistrictLayerOn;
        if (isDistrictLayerOn) {
          kakaoMap.addOverlayMapTypeId(kakao.maps.MapTypeId.USE_DISTRICT);
          btnToggle.classList.add('active');
        } else {
          kakaoMap.removeOverlayMapTypeId(kakao.maps.MapTypeId.USE_DISTRICT);
          btnToggle.classList.remove('active');
        }
      });
    }
  } catch (err) {
    console.error("Kakao Map initialization error:", err);
    showMapError(container, 
      "카카오맵 객체 생성 중 에러가 발생했습니다. 카카오 개발자 사이트에서 도메인(http://127.0.0.1:5000)이 정상 등록되었는지 다시 한 번 확인해 주세요.",
      err.stack || err.message
    );
    return null;
  }

  // 카카오맵 클릭 이벤트
  kakao.maps.event.addListener(kakaoMap, 'click', async function(mouseEvent) {
    const latlng = mouseEvent.latLng;
    const lat = latlng.getLat();
    const lon = latlng.getLng();

    placeMarker(lat, lon);

    // 1. 주소-좌표 변환 (Kakao Geocoder)
    const geoResult = await reverseGeocodeKakao(lat, lon);
    // coord2Address 결과는 { address: {address_name,...}, road_address: {...} } 형태
    const fullAddress = geoResult?.address?.address_name || geoResult?.road_address?.address_name || '';

    // 2. 브이월드 API 필지 경계 획득 (Flask Proxy)
    const parcelResult = await queryAndDrawVWorldParcel(lat, lon, fullAddress);

    if (onLocationSelect) {
      onLocationSelect({
        lat, lng: lon,
        displayName: fullAddress,
        address: geoResult,
        parcel: parcelResult
      });
    }
  });

  return kakaoMap;
}

/* ─────────────────────────────────────────────
   2. 마커 배치
───────────────────────────────────────────── */
function placeMarker(lat, lon) {
  if (!kakaoMap) return;
  
  if (currentMarker) {
    currentMarker.setMap(null);
  }

  const markerPosition  = new kakao.maps.LatLng(lat, lon); 
  
  // 기본 마커 사용 (커스텀 이미지를 원하면 MarkerImage 사용)
  currentMarker = new kakao.maps.Marker({
      position: markerPosition
  });

  currentMarker.setMap(kakaoMap);
}

/* ─────────────────────────────────────────────
   3. 카카오 로컬 API - 좌표로 주소 변환
───────────────────────────────────────────── */
async function reverseGeocodeKakao(lat, lon) {
  return new Promise((resolve, reject) => {
    if (typeof kakao === 'undefined' || !kakao.maps.services) {
      resolve(null);
      return;
    }
    const geocoder = new kakao.maps.services.Geocoder();
    geocoder.coord2Address(lon, lat, (result, status) => {
      if (status === kakao.maps.services.Status.OK) {
        resolve(result[0]); // 지번주소, 도로명주소 정보 포함
      } else {
        resolve(null);
      }
    });
  });
}

/* ─────────────────────────────────────────────
   4. 카카오 로컬 API - 주소 검색
───────────────────────────────────────────── */
async function searchAddress(query) {
  return new Promise((resolve, reject) => {
    if (!query || typeof kakao === 'undefined' || !kakao.maps.services) {
      resolve([]);
      return;
    }
    const geocoder = new kakao.maps.services.Geocoder();
    geocoder.addressSearch(query, (result, status) => {
      if (status === kakao.maps.services.Status.OK) {
        // 결과 포맷을 기존 인터페이스에 맞춤
        const mapped = result.map(item => ({
          name: item.address_name,
          display_name: item.address_name,
          lat: item.y,
          lon: item.x,
          kakao_item: item
        }));
        resolve(mapped);
      } else {
        resolve([]);
      }
    });
  });
}

/* ─────────────────────────────────────────────
   5. 특정 위치로 지도 이동 (검색 시)
───────────────────────────────────────────── */
function flyToLocation(lat, lon, popupText) {
  if (!kakaoMap) return;
  
  const moveLatLon = new kakao.maps.LatLng(lat, lon);
  
  // 부드럽게 이동
  kakaoMap.panTo(moveLatLon);
  placeMarker(lat, lon);
}

/* ─────────────────────────────────────────────
   6. 브이월드 API 필지 탐지 및 그리기 (다중 선택 토글)
───────────────────────────────────────────── */
async function queryAndDrawVWorldParcel(lat, lon, kakaoAddress) {
  setParcelStatus('loading');

  let geom = null;
  let props = null;
  let zoneName = null;
  let isMock = false;

  try {
    const resp = await fetch(`/api/vworld-parcel?lat=${lat}&lon=${lon}`);
    if (!resp.ok) throw new Error('VWorld proxy error');
    
    const data = await resp.json();
    
    if (data && data.response && data.response.status === 'OK' && data.response.result?.featureCollection?.features?.length > 0) {
      const feature = data.response.result.featureCollection.features[0];
      geom = feature.geometry;
      props = feature.properties;
      zoneName = data.response.zone_name || null;
      
      // 공식 등록면적 (지적공부 기반) — 있으면 폴리곤 계산보다 우선 사용
      if (data.response.registered_area && data.response.registered_area > 0) {
        props._registeredArea = data.response.registered_area;
      }
      
      // 속성 목록 콘솔 출력 (어떤 면적 필드가 있는지 확인용)
      if (data.response.parcel_props) {
        console.log('[VWorld 필지 속성]', data.response.parcel_props);
      }
    } else {
      isMock = true;
    }
  } catch (err) {
    console.warn('VWorld API 호출 실패, 가상 필지 모드로 전환합니다.', err);
    isMock = true;
  }

  // API 키가 없거나 에러가 발생한 경우 가상 필지 생성 (Fallback)
  if (isMock) {
    geom = generateMockGeom(lat, lon);
    props = {
      pnu: `MOCK_${lat.toFixed(5)}_${lon.toFixed(5)}`,
      jibun: `가상필지(${lat.toFixed(4)}, ${lon.toFixed(4)})`
    };
  }

  const pnu = props.pnu || props.jibun;

  // 이미 선택된 필지면 선택 해제 (토글)
  if (selectedParcels[pnu]) {
    selectedParcels[pnu].polygon.setMap(null);
    delete selectedParcels[pnu];
    updateParcelStatusUI();
    return { action: 'removed', pnu };
  }


  // 새 필지 추가 (일단 단일 용도지역으로 저장 후 폴리곤 교차 조회로 업데이트)
  const polygon = drawParcelPolygonKakao(geom);

  // 면적 계산 (VWorld 토지대장 공식 등록면적이 있으면 최우선 적용)
  let areaM2 = 0;
  if (props && props._registeredArea && props._registeredArea > 0) {
    areaM2 = Math.round(props._registeredArea * 10) / 10; // 소수점 첫째자리 정밀도
  } else if (geom && geom.type === 'MultiPolygon') {
    areaM2 = Math.round(calculateMultiPolygonArea(geom.coordinates));
  }

  
  // 저장 (초기값: 단일 zoneName)
  selectedParcels[pnu] = {
    pnu,
    areaM2,
    jibun: props.jibun,
    address: kakaoAddress || props.jibun || '',
    zoneName,

    zonesMap: zoneName ? { [zoneName]: areaM2 } : {}, // 초기값
    polygon,
    geom,
    isMock
  };

  // ── 폴리곤 기반 복수 용도지역 교차 조회 ──────────────────────────
  // 브이월드 API로 필지 폴리곤이 걸치는 모든 용도지역을 교차 면적과 함께 조회
  if (geom && !isMock) {
    try {
      const zoneResp = await fetch('/api/zone-by-polygon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geom, total_area: areaM2 })
      });
      if (zoneResp.ok) {
        const zoneData = await zoneResp.json();
        if (zoneData.zones && Object.keys(zoneData.zones).length > 0) {
          selectedParcels[pnu].zonesMap = zoneData.zones;
          // 지배적 용도지역으로 zoneName도 업데이트
          const dominantEntry = Object.entries(zoneData.zones)
            .sort(([, a], [, b]) => b - a)[0];
          if (dominantEntry) {
            selectedParcels[pnu].zoneName = dominantEntry[0];
          }
          console.log(`[용도지역 교차조회] ${pnu}:`, zoneData.zones, `방식: ${zoneData.method}`);
        }
      }
    } catch (err) {
      console.warn('[용도지역 교차조회 실패]', err);
    }
  }

  updateParcelStatusUI();

  return {
    action: 'added',
    pnu,
    areaM2,
    jibun: props.jibun,
    address: kakaoAddress || props.jibun || '',
    zoneName: selectedParcels[pnu].zoneName,
    zonesMap: selectedParcels[pnu].zonesMap
  };
}



/** 가상 필지(정사각형) 생성 */
function generateMockGeom(lat, lon) {
  const d = 0.00015; // 약 15미터 범위
  return {
    type: 'MultiPolygon',
    coordinates: [[
      [
        [lon - d, lat - d],
        [lon + d, lat - d],
        [lon + d, lat + d],
        [lon - d, lat + d],
        [lon - d, lat - d]
      ]
    ]]
  };
}

/* ─────────────────────────────────────────────
   7. 카카오맵 위에 폴리곤 그리기 (반환)
───────────────────────────────────────────── */
function drawParcelPolygonKakao(geom) {
  if (!kakaoMap || !geom || geom.type !== 'MultiPolygon') return null;

  let polygonPath = [];
  const multiCoords = geom.coordinates;
  multiCoords.forEach(polygon => {
    polygon.forEach(ring => {
      let path = [];
      ring.forEach(coord => {
        path.push(new kakao.maps.LatLng(coord[1], coord[0]));
      });
      polygonPath.push(path);
    });
  });

  // 지도에 표시할 다각형 생성 (파란색 실선 + 연한 파란색 채우기)
  const polygonObj = new kakao.maps.Polygon({
    path: polygonPath, 
    strokeWeight: 3, 
    strokeColor: '#2563eb', 
    strokeOpacity: 0.9, 
    strokeStyle: 'solid', 
    fillColor: '#3b82f6', 
    fillOpacity: 0.25 
  });

  polygonObj.setMap(kakaoMap);
  return polygonObj;
}

function clearParcelBoundary() {
  // 선택된 모든 필지 폴리곤 삭제
  Object.values(selectedParcels).forEach(p => {
    if (p.polygon) p.polygon.setMap(null);
  });
  selectedParcels = {};
  updateParcelStatusUI();
}

/** 다중 선택된 필지 데이터를 통합하여 반환 */
function getSelectedParcelsData() {
  const parcels = Object.values(selectedParcels);
  if (parcels.length === 0) return null;

  const totalAreaM2 = parcels.reduce((sum, p) => sum + p.areaM2, 0);

  // 주소들을 지능적으로 병합 (공통 주소 접두사 + 지번 나열)
  const mergeAddresses = (parcelList) => {
    const addresses = parcelList.map(p => p.address).filter(Boolean);
    if (addresses.length === 0) return '';
    if (addresses.length === 1) return addresses[0];

    const splitAddrs = addresses.map(addr => addr.split(' '));
    let commonParts = [];
    const minLength = Math.min(...splitAddrs.map(a => a.length));

    for (let i = 0; i < minLength; i++) {
      const part = splitAddrs[0][i];
      const allMatch = splitAddrs.every(a => a[i] === part);
      if (allMatch) {
        commonParts.push(part);
      } else {
        break;
      }
    }

    const base = commonParts.join(' ');
    const uniqueSuffixes = [];
    addresses.forEach(addr => {
      const suffix = addr.substring(base.length).trim();
      if (suffix && !uniqueSuffixes.includes(suffix)) {
        uniqueSuffixes.push(suffix);
      }
    });

    if (uniqueSuffixes.length > 0) {
      return `${base} ${uniqueSuffixes.join(', ')}`;
    }
    return base;
  };

  const mergedAddress = mergeAddresses(parcels);

  // 용도지역별 면적 집계 (폴리곤 교차조회 결과 우선, 없으면 단일 zoneName으로 폴백)
  const zonesMap = {};
  parcels.forEach(p => {
    if (p.zonesMap && Object.keys(p.zonesMap).length > 0) {
      // 폴리곤 교차 조회로 얻은 구역별 면적 합산
      Object.entries(p.zonesMap).forEach(([zname, area]) => {
        if (zname && zname !== '미지정' && zname !== 'null') {
          zonesMap[zname] = (zonesMap[zname] || 0) + area;
        }
      });
    } else {
      // 폴백: 단일 zoneName
      const z = p.zoneName || '미지정';
      zonesMap[z] = (zonesMap[z] || 0) + p.areaM2;
    }
  });

  // 가장 많이 선택된 용도지역명 계산 (다수결)
  const zonesList = parcels.map(p => p.zoneName).filter(Boolean);
  let dominantZone = null;
  if (zonesList.length > 0) {
    const counts = {};
    zonesList.forEach(z => { counts[z] = (counts[z] || 0) + 1; });
    dominantZone = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
  }

  return {
    totalAreaM2,
    jibuns: mergedAddress,
    count: parcels.length,
    dominantZone,
    zonesMap,
    siteDimensions: getSiteBoundingDimensions(parcels),
    mergedGeom: mergeParcelGeoms(parcels)
  };
}

/** 선택된 필지들의 geom(MultiPolygon)을 하나의 MultiPolygon GeoJSON으로 합침 (/api/buildable-envelope 입력용) */
function mergeParcelGeoms(parcels) {
  const coords = [];
  parcels.forEach(p => {
    if (!p.geom) return;
    if (p.geom.type === 'MultiPolygon') coords.push(...p.geom.coordinates);
    else if (p.geom.type === 'Polygon') coords.push(p.geom.coordinates);
  });
  if (coords.length === 0) return null;
  return { type: 'MultiPolygon', coordinates: coords };
}

/**
 * 선택된 필지들의 폴리곤을 모두 감싸는 축정렬 바운딩박스를 구해
 * 동서(E-W)·남북(N-S) 개략 치수(m)를 반환 (배치 시뮬레이션용 근사치)
 */
function getSiteBoundingDimensions(parcels) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;

  parcels.forEach(p => {
    if (!p.geom || p.geom.type !== 'MultiPolygon') return;
    p.geom.coordinates.forEach(polygon => {
      polygon.forEach(ring => {
        ring.forEach(([lon, lat]) => {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        });
      });
    });
  });

  if (!isFinite(minLat) || !isFinite(minLon)) return null;

  const midLat = (minLat + maxLat) / 2;
  const mLat = 111320;
  const mLon = 111320 * Math.cos(midLat * Math.PI / 180);

  return {
    widthEW: Math.round((maxLon - minLon) * mLon * 10) / 10,
    depthNS: Math.round((maxLat - minLat) * mLat * 10) / 10,
    bbox: { minLon, minLat, maxLon, maxLat }
  };
}

/* ─────────────────────────────────────────────
   10. 건축가능영역 산출 (도로/인접대지 이격) + 개략 배치 미리보기
───────────────────────────────────────────── */
let layoutPreviewPolygons = [];
let edgeClassificationLines = [];
let manualEdgeOverrides = {}; // { edgeIndex: 'road'|'adjacent' } 사용자 수동보정
let lastEnvelopeEdges = null; // 가장 최근 /api/buildable-envelope 응답의 edges (수동보정 대상 조회용)

function clearLayoutPreview() {
  layoutPreviewPolygons.forEach(p => p.setMap(null));
  layoutPreviewPolygons = [];
}

function clearEdgeClassification() {
  edgeClassificationLines.forEach(l => l.setMap(null));
  edgeClassificationLines = [];
}

/** 구역계 취소 시 배치 관련 상태를 모두 초기화 */
function clearBuildableEnvelopeState() {
  clearLayoutPreview();
  clearEdgeClassification();
  manualEdgeOverrides = {};
  lastEnvelopeEdges = null;
}

/**
 * 대지 폴리곤을 /api/buildable-envelope로 보내 변별 도로/인접대지 분류 + 1차 건축가능영역을 받아온다.
 * onResult(envelopeGeojson, edges) 콜백으로 결과 전달 (main.js에서 calculate() 입력에 반영).
 */
async function fetchBuildableEnvelope(geom, roadSetback, adjacentSetback, onResult) {
  if (!geom) { onResult(null, null); return; }
  try {
    const edgeOverrides = Object.entries(manualEdgeOverrides).map(([index, type]) => ({ index: Number(index), type }));
    const resp = await fetch('/api/buildable-envelope', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geom, roadSetback, adjacentSetback, edgeOverrides })
    });
    if (!resp.ok) throw new Error('buildable-envelope 요청 실패');
    const data = await resp.json();
    lastEnvelopeEdges = data.edges || null;
    // 변 클릭으로 수동보정하면 같은 geom/setback으로 재조회 후 다시 콜백
    drawEdgeClassification(data.edges, () => fetchBuildableEnvelope(geom, roadSetback, adjacentSetback, onResult));
    onResult(data.envelope || null, data.edges || null);
  } catch (err) {
    console.warn('[건축가능영역 조회 실패]', err);
    lastEnvelopeEdges = null;
    onResult(null, null);
  }
}

/**
 * 변별 분류를 지도 위에 색상 점선으로 표시하고, 클릭하면 도로/인접대지 타입을 토글해
 * 수동보정한 뒤 onToggle 콜백을 호출한다 (재조회·재계산 트리거용).
 * 도로=파랑, 정북일조 면제 변(북측이 비주거지역)=초록, 그 외 인접대지=회색.
 * 도로 변은 실측된 도로폭을 인포윈도우로 확인할 수 있다.
 */
function drawEdgeClassification(edges, onToggle) {
  clearEdgeClassification();
  if (!kakaoMap || !edges) return;

  edges.forEach(edge => {
    const path = [
      new kakao.maps.LatLng(edge.p1[1], edge.p1[0]),
      new kakao.maps.LatLng(edge.p2[1], edge.p2[0])
    ];
    const isRoad = edge.type === 'road';
    const isNorthExempt = edge.isNorth && edge.northExempt;
    const color = isRoad ? '#2563eb' : (isNorthExempt ? '#16a34a' : '#94a3b8');
    const line = new kakao.maps.Polyline({
      path,
      strokeWeight: 4,
      strokeColor: color,
      strokeOpacity: 0.9,
      strokeStyle: 'shortdash'
    });
    line.setMap(kakaoMap);
    kakao.maps.event.addListener(line, 'click', () => {
      manualEdgeOverrides[edge.index] = isRoad ? 'adjacent' : 'road';
      if (onToggle) onToggle();
    });
    if (isRoad && edge.roadWidthM) {
      const mid = new kakao.maps.LatLng((edge.p1[1] + edge.p2[1]) / 2, (edge.p1[0] + edge.p2[0]) / 2);
      const label = new kakao.maps.CustomOverlay({
        position: mid,
        content: `<div style="background:#2563eb;color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;white-space:nowrap;">도로폭 ${edge.roadWidthM}m</div>`,
        yAnchor: 1.6
      });
      label.setMap(kakaoMap);
      edgeClassificationLines.push(label);
    }
    edgeClassificationLines.push(line);
  });
}

/**
 * calculator.js의 layoutInfo를 받아 개략 주동 형상을 카카오맵 단지 표기 스타일로 지도에 표시한다.
 * layoutInfo.rows[].segments가 있으면 동마다 세대수만큼 균등분할한 유닛 박스를(코어 구분 없이)
 * 옅은 단색 배경 + 얇은 테두리로 그리고, 동 중앙에 "평형타입 공급면적평" 라벨을 표시한다.
 * segments가 없으면(폴백) 건물 외곽만, 그마저 없으면(바운딩박스 폴백 경로) 단순 사각형을 그린다.
 * 실제 매싱 설계가 아닌 개략 근사치 — 시각화용.
 */
function drawLayoutPreview(bbox, layoutInfo) {
  clearLayoutPreview();
  if (!kakaoMap || !layoutInfo || !layoutInfo.maxRows) return;

  const hasSegments = Array.isArray(layoutInfo.rows) && layoutInfo.rows.length > 0 && layoutInfo.rows[0].segments;
  const hasPolygonRows = Array.isArray(layoutInfo.rows) && layoutInfo.rows.length > 0 && layoutInfo.rows[0].pathLL;

  if (hasSegments) {
    layoutInfo.rows.forEach(row => {
      row.segments.forEach(seg => {
        const path = seg.pathLL.map(([lon, lat]) => new kakao.maps.LatLng(lat, lon));
        const poly = new kakao.maps.Polygon({
          path,
          strokeWeight: 1,
          strokeColor: '#b45309',
          strokeOpacity: 0.8,
          strokeStyle: 'solid',
          fillColor: '#fdf1de',
          fillOpacity: 0.85
        });
        poly.setMap(kakaoMap);
        layoutPreviewPolygons.push(poly);
      });
      (row.buildingLabels || []).forEach(bl => {
        const label = new kakao.maps.CustomOverlay({
          position: new kakao.maps.LatLng(bl.positionLL[1], bl.positionLL[0]),
          content: `<div style="background:rgba(255,255,255,0.92);color:#7c2d12;font-size:11px;font-weight:600;padding:1px 5px;border-radius:3px;white-space:nowrap;border:1px solid #b45309;">${bl.text}</div>`,
          yAnchor: 0.5
        });
        label.setMap(kakaoMap);
        layoutPreviewPolygons.push(label);
      });
    });
    return;
  }

  if (hasPolygonRows) {
    layoutInfo.rows.forEach(row => {
      const path = row.pathLL.map(([lon, lat]) => new kakao.maps.LatLng(lat, lon));
      const poly = new kakao.maps.Polygon({
        path,
        strokeWeight: 2,
        strokeColor: '#f59e0b',
        strokeOpacity: 0.9,
        strokeStyle: 'shortdash',
        fillColor: '#f59e0b',
        fillOpacity: 0.1
      });
      poly.setMap(kakaoMap);
      layoutPreviewPolygons.push(poly);
    });
    return;
  }

  // 폴백: 바운딩박스 기반 단순 사각형
  if (!bbox) return;
  const { minLon, minLat, maxLon, maxLat } = bbox;
  const midLat = (minLat + maxLat) / 2;
  const mLat = 111320;
  const mLon = 111320 * Math.cos(midLat * Math.PI / 180);

  const depthDeg = (layoutInfo.bldgDepth || 15) / mLat;
  const gapDeg = (layoutInfo.buildingGap || 0) / mLat;
  const northSetbackDeg = (layoutInfo.northSetback || 0) / mLat;
  const northLimit = maxLat - northSetbackDeg;

  for (let i = 0; i < layoutInfo.maxRows; i++) {
    const rowStart = minLat + i * (depthDeg + gapDeg);
    const rowEnd = rowStart + depthDeg;
    if (rowEnd > northLimit) break;

    const path = [
      new kakao.maps.LatLng(rowStart, minLon),
      new kakao.maps.LatLng(rowStart, maxLon),
      new kakao.maps.LatLng(rowEnd, maxLon),
      new kakao.maps.LatLng(rowEnd, minLon)
    ];

    const poly = new kakao.maps.Polygon({
      path,
      strokeWeight: 2,
      strokeColor: '#f59e0b',
      strokeOpacity: 0.9,
      strokeStyle: 'shortdash',
      fillColor: '#f59e0b',
      fillOpacity: 0.1
    });
    poly.setMap(kakaoMap);
    layoutPreviewPolygons.push(poly);
  }
}

/* ─────────────────────────────────────────────
   8. 면적 계산 유틸리티 (신발끈 공식)
───────────────────────────────────────────── */
function calculateMultiPolygonArea(multiCoords) {
  let totalArea = 0;
  multiCoords.forEach(polygon => {
    // 첫 번째 링(외곽선) 면적 더하기
    totalArea += polygonAreaM2(polygon[0]);
    // 두 번째 링부터는 내부 구멍이므로 면적 빼기
    for (let i = 1; i < polygon.length; i++) {
       totalArea -= polygonAreaM2(polygon[i]);
    }
  });
  return totalArea;
}

// coords: [[lon, lat], [lon, lat], ...]
function polygonAreaM2(coords) {
  const n = coords.length;
  if (n < 3) return 0;
  
  const lat0 = coords[0][1];
  const mLat = 111320; // 1도당 대략적 미터 (위도)
  const mLon = 111320 * Math.cos(lat0 * Math.PI / 180); // 경도

  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    // y: lat, x: lon
    const xi = coords[i][0] * mLon;
    const yi = coords[i][1] * mLat;
    const xj = coords[j][0] * mLon;
    const yj = coords[j][1] * mLat;
    
    area += xi * yj - xj * yi;
  }
  return Math.abs(area / 2);
}

/* ─────────────────────────────────────────────
   9. 상태 UI 업데이트
───────────────────────────────────────────── */
function updateParcelStatusUI() {
  const data = getSelectedParcelsData();
  if (data) {
    const hasMock = Object.values(selectedParcels).some(p => p.isMock);
    const activeZones = Object.keys(data.zonesMap || {}).filter(z => z && z !== '미지정' && z !== 'null');
    setParcelStatus(hasMock ? 'mock_found' : 'found', data.totalAreaM2, data.jibuns, data.count, activeZones);
  } else {
    setParcelStatus('idle');
  }
}

function setParcelStatus(state, areaM2 = 0, jibun = '', count = 0, activeZones = []) {
  const el = document.getElementById('parcel-status');
  if (!el) return;

  const icons = {
    idle:       '<i class="fa-solid fa-hand-pointer"></i>',
    loading:    '<i class="fa-solid fa-circle-notch fa-spin"></i>',
    found:      '<i class="fa-solid fa-draw-polygon"></i>',
    mock_found: '<i class="fa-solid fa-triangle-exclamation"></i>',
    notfound:   '<i class="fa-solid fa-triangle-exclamation"></i>',
    error:      '<i class="fa-solid fa-circle-xmark"></i>',
  };

  const msgs = {
    idle:     '지도를 클릭하여 여러 필지를 선택한 후 \'구역계 확정\' 버튼을 눌러주세요.',
    loading:  '필지 경계 탐색 중... (용도지역 교차조회 포함)',
    notfound: '필지 데이터가 없습니다 — 면적을 직접 입력해주세요',
    error:    '경계 탐색 오류 — 직접 입력해주세요',
  };

  el.className = `parcel-status parcel-${state}`;

  if ((state === 'found' || state === 'mock_found') && areaM2 > 0) {
    const jibunText = jibun ? `&nbsp;·&nbsp;${jibun}` : '';
    let zoneText = '';
    if (activeZones && activeZones.length > 1) {
      const znames = activeZones.map(z => z.replace('지역', '')).join(' + ');
      zoneText = `&nbsp;·&nbsp;<span style="color:#f59e0b;font-weight:600;">혼합: ${znames}</span>`;
    } else if (activeZones && activeZones.length === 1) {
      zoneText = `&nbsp;·&nbsp;<span style="color:var(--accent);">${activeZones[0]}</span>`;
    }
    if (state === 'mock_found') {
      el.innerHTML = `${icons.mock_found} <strong>${count}개</strong> 가상 필지 선택됨 (API 키 없음) &nbsp;·&nbsp; 총 대지면적 <strong>${areaM2.toLocaleString()} ㎡</strong>${jibunText} <span style="color:var(--danger); font-size:0.75rem; margin-left:8px;">(실제 경계는 app.py의 VWORLD_API_KEY 입력 필요)</span>${zoneText}`;
    } else {
      el.innerHTML = `${icons.found} <strong>${count}개</strong> 실제 필지 선택됨 &nbsp;·&nbsp; 총 대지면적 <strong>${areaM2.toLocaleString()} ㎡</strong>${jibunText}${zoneText}`;
    }
  } else {
    el.innerHTML = `${icons[state] || ''} ${msgs[state] || ''}`;
  }
}
