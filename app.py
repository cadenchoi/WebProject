"""
건축개요 자동 생성 웹 서비스
Flask 백엔드: 정적 파일 호스팅 + Nominatim(OpenStreetMap) 주소 검색 프록시
"""
from flask import Flask, render_template, jsonify, request
import requests as req_lib
import json
import os
import math
from shapely.geometry import shape, Polygon, mapping
from shapely.ops import transform as shapely_transform, unary_union

app = Flask(__name__)

# ==============================================================================
# API Keys (테스트 또는 실제 서비스용 키를 여기에 입력하세요)
# ==============================================================================
# 카카오맵 JavaScript API Key (기본값: 공란이거나 로컬 테스트용 키 입력)
KAKAO_API_KEY = os.environ.get('KAKAO_API_KEY', '44ef938856866c0a79ff45890252b177') # 발급받은 키를 여기에 입력하세요 (예: 'abc123def456...')

# 브이월드(VWorld) API Key (지적도 경계 데이터용)
# Vworld API는 오픈 API이며, 회원가입 후 무료로 키를 발급받을 수 있습니다.
VWORLD_API_KEY = os.environ.get('VWORLD_API_KEY', '967BF2B7-4517-38BD-93CD-E59683605BD5') # 브이월드 제공 테스트용 공개 키 또는 본인 키

NOMINATIM_HEADERS = {
    'User-Agent': 'KR-ArchOverview-WebApp/1.0 (educational use)'
}

@app.route('/')
def index():
    return render_template('index.html', kakao_api_key=KAKAO_API_KEY)



@app.route('/api/search-address')
def search_address():
    """주소 키워드로 후보지 검색 (Nominatim forward geocoding)"""
    query = request.args.get('q', '')
    if not query:
        return jsonify([])
    try:
        resp = req_lib.get(
            'https://nominatim.openstreetmap.org/search',
            params={
                'q': query,
                'format': 'json',
                'accept-language': 'ko',
                'countrycodes': 'kr',
                'limit': 6,
                'addressdetails': 1
            },
            headers=NOMINATIM_HEADERS,
            timeout=8
        )
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/reverse-geocode')
def reverse_geocode():
    """위경도 좌표 → 한국 주소 변환 (Nominatim reverse geocoding)"""
    lat = request.args.get('lat')
    lon = request.args.get('lon')
    if not lat or not lon:
        return jsonify({'error': 'lat, lon required'}), 400
    try:
        resp = req_lib.get(
            'https://nominatim.openstreetmap.org/reverse',
            params={
                'lat': lat,
                'lon': lon,
                'format': 'json',
                'accept-language': 'ko',
                'addressdetails': 1,
                'zoom': 18
            },
            headers=NOMINATIM_HEADERS,
            timeout=8
        )
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/vworld-parcel')
def vworld_parcel():
    """브이월드 Data API를 통한 필지 경계 및 용도지역 통합 조회"""
    lat = request.args.get('lat')
    lon = request.args.get('lon')
    if not lat or not lon:
        return jsonify({'error': 'lat, lon required'}), 400
    
    url = "https://api.vworld.kr/req/data"
    
    # 1. 용도지역 (LT_C_UQ111) 조회
    params_zone = {
        "service": "data",
        "request": "GetFeature",
        "data": "LT_C_UQ111",
        "key": VWORLD_API_KEY,
        "geomFilter": f"POINT({lon} {lat})",
        "crs": "EPSG:4326",
        "format": "json",
        "domain": "http://localhost:5000"
    }
    
    def fix_vworld_zone_name(broken_name):
        if not broken_name:
            return broken_name
        
        # 1. 공백 및 괄호 제거 (예: "제3종일반주거지역(공동주택)" -> "제3종일반주거지역")
        cleaned = broken_name.strip().replace(" ", "")
        if "(" in cleaned:
            cleaned = cleaned.split("(")[0]
            
        zones = [
            "제1종전용주거지역", "제2종전용주거지역",
            "제1종일반주거지역", "제2종일반주거지역", "제3종일반주거지역",
            "준주거지역", "중심상업지역", "일반상업지역", "근린상업지역", "유통상업지역",
            "전용공업지역", "일반공업지역", "준공업지역",
            "보전녹지지역", "생산녹지지역", "자연녹지지역"
        ]
        
        # 2. 정확히 일치하는 용도지역명이 있는가
        if cleaned in zones:
            return cleaned
            
        # 3. 부분 일치 확인 (예: "제3종일반주거" -> "제3종일반주거지역")
        for z in zones:
            if cleaned in z or z in cleaned:
                return z
                
        # 4. Vworld 인코딩 에러 대응 (EUC-KR -> UTF-8 강제 변환된 깨진 문자열 복원)
        for z in zones:
            simulated = z.encode('euc-kr').decode('utf-8', errors='replace')
            if broken_name == simulated:
                return z
                
        return broken_name

    zone_name = None
    try:
        resp_zone = req_lib.get(url, params=params_zone, timeout=4)
        if resp_zone.status_code == 200:
            zone_json = resp_zone.json()
            features = zone_json.get('response', {}).get('result', {}).get('featureCollection', {}).get('features', [])
            if features:
                # 첫 번째로 비어있지 않은 uname 찾기
                raw_name = None
                for feat in features:
                    name_candidate = feat.get('properties', {}).get('uname')
                    if name_candidate:
                        raw_name = name_candidate
                        break
                if not raw_name:
                    raw_name = features[0].get('properties', {}).get('uname')
                zone_name = fix_vworld_zone_name(raw_name)
    except Exception as e:
        print("VWorld Zoning Query Error:", e)

    # 2. 연속지적도 (LP_PA_CBND_BUBUN) 조회
    params_parcel = {
        "service": "data",
        "request": "GetFeature",
        "data": "LP_PA_CBND_BUBUN",
        "key": VWORLD_API_KEY,
        "geomFilter": f"POINT({lon} {lat})",
        "crs": "EPSG:4326",
        "format": "json",
        "domain": "http://localhost:5000"
    }
    
    try:
        resp_parcel = req_lib.get(url, params=params_parcel, timeout=5)
        parcel_json = resp_parcel.json()
        
        # 용도지역 정보 병합
        if 'response' in parcel_json:
            parcel_json['response']['zone_name'] = zone_name
            
            # ── 토지대장 공식 등록면적 조회 (VWorld getLandCharacteristics API) ──
            try:
                features = parcel_json['response'].get('result', {}).get('featureCollection', {}).get('features', [])
                if features:
                    props = features[0].get('properties', {})
                    pnu = props.get('pnu')
                    registered_area = None
                    
                    if pnu:
                        land_info_url = f"http://api.vworld.kr/ned/data/getLandCharacteristics?pnu={pnu}&key={VWORLD_API_KEY}&domain=http://localhost:5000&format=json&numOfRows=1"
                        resp_land = req_lib.get(land_info_url, timeout=4)
                        if resp_land.status_code == 200:
                            land_data = resp_land.json()
                            fields = land_data.get('landCharacteristicss', {}).get('field', [])
                            if fields:
                                ar_str = fields[0].get('lndpclAr')
                                if ar_str:
                                    registered_area = float(ar_str)
                                    print(f"[공식 토지대장 면적 조회 성공] PNU: {pnu} -> {registered_area}㎡")
                    
                    parcel_json['response']['registered_area'] = registered_area
                    parcel_json['response']['parcel_props'] = props
            except Exception as ep:
                print("공식 등록면적 조회 오류:", ep)
            
        return jsonify(parcel_json)
    except Exception as e:
        return jsonify({'error': str(e)}), 500




@app.route('/api/zone-by-polygon', methods=['POST'])
def zone_by_polygon():
    """
    필지 폴리곤을 받아서 겹치는 모든 용도지역을 조회하고
    각 용도지역과의 실제 폴리곤 교차 면적(shapely 기반 정밀 계산)을 반환.

    이전에는 필지 BBOX와 용도지역 BBOX의 사각형 교차 면적으로 근사했는데,
    필지나 용도지역이 사각형이 아닌 경우(도로변 노선형 상업지역 등) BBOX가
    실제 도형보다 훨씬 커져서 실제로는 안 걸치는 인접 용도지역까지
    "교차"로 잘못 잡히는 문제가 있었음 (예: 2개 용도지역인데 3개로 표시).

    POST body: { "geom": <GeoJSON geometry>, "total_area": <float in m2> }
    """
    body = request.get_json()
    if not body or 'geom' not in body:
        return jsonify({'error': 'geom required'}), 400

    geom = body['geom']
    total_area = body.get('total_area', 0)

    # Bounding box from GeoJSON geometry for VWorld geomFilter (조회용 대략 범위)
    def bbox_from_geom(g):
        coords = []
        def collect(c):
            if isinstance(c[0], (int, float)):
                coords.append(c)
            else:
                for item in c:
                    collect(item)
        collect(g['coordinates'])
        lons = [c[0] for c in coords]
        lats = [c[1] for c in coords]
        return min(lons), min(lats), max(lons), max(lats)

    def fix_name(broken_name):
        if not broken_name:
            return broken_name
        cleaned = broken_name.strip().replace(' ', '')
        if '(' in cleaned:
            cleaned = cleaned.split('(')[0]
        zones = [
            '제1종전용주거지역', '제2종전용주거지역',
            '제1종일반주거지역', '제2종일반주거지역', '제3종일반주거지역',
            '준주거지역', '중심상업지역', '일반상업지역', '근린상업지역', '유통상업지역',
            '전용공업지역', '일반공업지역', '준공업지역',
            '보전녹지지역', '생산녹지지역', '자연녹지지역'
        ]
        if cleaned in zones:
            return cleaned
        for z in zones:
            if cleaned in z or z in cleaned:
                return z
        return broken_name

    try:
        minx, miny, maxx, maxy = bbox_from_geom(geom)

        # 바운딩박스를 WKT POLYGON으로 변환 (VWorld 조회용 — 실제 교차 판정은 아래에서 폴리곤으로 재계산)
        bbox_wkt = f"POLYGON(({minx} {miny},{maxx} {miny},{maxx} {maxy},{minx} {maxy},{minx} {miny}))"

        url = 'https://api.vworld.kr/req/data'
        params = {
            'service': 'data',
            'request': 'GetFeature',
            'data': 'LT_C_UQ111',
            'key': VWORLD_API_KEY,
            'geomFilter': bbox_wkt,
            'crs': 'EPSG:4326',
            'format': 'json',
            'domain': 'http://localhost:5000',
            'attrFilter': '',
            'maxFeatures': 20
        }

        resp = req_lib.get(url, params=params, timeout=8)
        data = resp.json()
        features = data.get('response', {}).get('result', {}).get('featureCollection', {}).get('features', [])

        if not features:
            return jsonify({'zones': {}, 'method': 'none'})

        # 위경도(도) 좌표를 미터 단위 평면 좌표로 변환 (필지 중심 위도 기준 등장방형 근사)
        lat0 = (miny + maxy) / 2
        m_lat = 111320.0
        m_lon = 111320.0 * math.cos(lat0 * math.pi / 180)

        def to_meters(lon, lat):
            return (lon * m_lon, lat * m_lat)

        def safe_shape(g):
            """GeoJSON geometry → 미터 좌표계 shapely geometry (자체교차 등 무효 도형은 buffer(0)로 보정)"""
            geom_obj = shapely_transform(lambda lon, lat: to_meters(lon, lat), shape(g))
            if not geom_obj.is_valid:
                geom_obj = geom_obj.buffer(0)
            return geom_obj

        parcel_shape = safe_shape(geom)
        parcel_area_m2 = total_area if (total_area and total_area > 0) else parcel_shape.area

        zones_raw = {}  # {zone_name: intersection_area_m2}

        for feat in features:
            raw_name = feat.get('properties', {}).get('uname', '')
            zone_name = fix_name(raw_name)
            feat_geom = feat.get('geometry')
            if not zone_name or not feat_geom:
                continue

            try:
                zone_shape = safe_shape(feat_geom)
                intersection = parcel_shape.intersection(zone_shape)
                isect_area = intersection.area
                if isect_area > 0:
                    zones_raw[zone_name] = zones_raw.get(zone_name, 0) + isect_area
            except Exception as ei:
                print('zone_by_polygon intersection error:', ei)
                continue

        if not zones_raw:
            return jsonify({'zones': {}, 'method': 'none'})

        # 경계선 스냅 오차 등으로 생기는 미세한 노이즈 조각(전체 면적의 1% 미만) 제거
        total_intersect = sum(zones_raw.values())
        noise_threshold = total_intersect * 0.01
        zones_raw = {z: a for z, a in zones_raw.items() if a >= noise_threshold} or zones_raw

        # 실제 교차 비율을 유지한 채, 공식 등록 대지면적에 맞춰 배분
        total_intersect = sum(zones_raw.values())
        zones_final = {}
        for zname, isect in zones_raw.items():
            ratio = isect / total_intersect if total_intersect > 0 else 0
            area_m2 = round(parcel_area_m2 * ratio)
            if area_m2 > 0:
                zones_final[zname] = area_m2

        method = 'single' if len(zones_final) <= 1 else 'multi'
        return jsonify({'zones': zones_final, 'method': method, 'parcel_area': round(parcel_area_m2)})

    except Exception as e:
        print('zone_by_polygon error:', e)
        return jsonify({'error': str(e), 'zones': {}}), 500


def classify_edge(lon, lat):
    """
    대지 변 바깥쪽 샘플 지점의 연속지적도(LP_PA_CBND_BUBUN)를 조회해 도로/인접대지를 판정.
    이 레이어는 별도 지목 필드가 없고 jibun 문자열 끝에 지목 접미글자가 붙는 관행 표기를
    그대로 반환한다 (실제 조회 확인: 도로 필지는 "1373도"처럼 "도"로 끝남).
    도로로 판정되면 그 도로 필지 폴리곤의 최소회전사각형 짧은 변으로 도로폭을 근사 측정해 함께 반환
    (건축법 제46조 도로사선 후퇴 자동계산용).
    """
    try:
        url = 'https://api.vworld.kr/req/data'
        params = {
            'service': 'data',
            'request': 'GetFeature',
            'data': 'LP_PA_CBND_BUBUN',
            'key': VWORLD_API_KEY,
            'geomFilter': f'POINT({lon} {lat})',
            'crs': 'EPSG:4326',
            'format': 'json',
            'domain': 'http://localhost:5000'
        }
        resp = req_lib.get(url, params=params, timeout=4)
        data = resp.json()
        features = data.get('response', {}).get('result', {}).get('featureCollection', {}).get('features', [])
        if not features:
            return 'adjacent', None

        feat = features[0]
        jibun = (feat.get('properties', {}).get('jibun') or '').strip()
        if not jibun.endswith('도'):
            return 'adjacent', None

        road_width = None
        try:
            road_geom = feat.get('geometry')
            if road_geom:
                road_shape_ll = shape(road_geom)
                rep_lat = road_shape_ll.representative_point().y
                r_m_lat = 111320.0
                r_m_lon = 111320.0 * math.cos(rep_lat * math.pi / 180)
                road_shape_m = shapely_transform(lambda x, y: (x * r_m_lon, y * r_m_lat), road_shape_ll)
                mrr_coords = list(road_shape_m.minimum_rotated_rectangle.exterior.coords)
                side_a = math.dist(mrr_coords[0], mrr_coords[1])
                side_b = math.dist(mrr_coords[1], mrr_coords[2])
                road_width = round(min(side_a, side_b), 1)
        except Exception as ew:
            print('road width measure error:', ew)

        return 'road', road_width
    except Exception as e:
        print('classify_edge error:', e)
        return 'adjacent', None


def query_zone_name(lon, lat):
    """샘플 지점의 용도지역명(LT_C_UQ111) 조회 — 정북일조 예외(북측이 비주거지역) 판정용"""
    try:
        url = 'https://api.vworld.kr/req/data'
        params = {
            'service': 'data',
            'request': 'GetFeature',
            'data': 'LT_C_UQ111',
            'key': VWORLD_API_KEY,
            'geomFilter': f'POINT({lon} {lat})',
            'crs': 'EPSG:4326',
            'format': 'json',
            'domain': 'http://localhost:5000'
        }
        resp = req_lib.get(url, params=params, timeout=4)
        data = resp.json()
        features = data.get('response', {}).get('result', {}).get('featureCollection', {}).get('features', [])
        for feat in features:
            name = feat.get('properties', {}).get('uname')
            if name:
                return name
        return None
    except Exception as e:
        print('query_zone_name error:', e)
        return None


def is_north_exempt_zone(zone_name):
    """
    정북일조 사선은 인접대지가 전용주거·일반주거지역일 때만 적용된다(건축법 시행령 제86조③).
    조회 실패로 용도지역을 알 수 없을 때는 보수적으로 면제하지 않는다(사선 유지).
    """
    if not zone_name:
        return False
    return not (('전용주거' in zone_name) or ('일반주거' in zone_name))


@app.route('/api/buildable-envelope', methods=['POST'])
def buildable_envelope():
    """
    대지 폴리곤을 변 단위로 분석해 도로/인접대지 여부를 자동판정하고,
    각 변에 맞는 이격거리(도로 후퇴 / 대지안의 공지)를 적용한 1차 건축가능영역을 반환한다.

    정북방향으로 판단되는 변은 높이에 비례하는 일조사선(정북일조) 대상이라 여기서는
    이격을 적용하지 않고 변 정보만 표시한다 — 예상 층수가 필요한 계산이라
    프런트엔드(calculator.js)가 실시간으로 추가 클리핑한다.

    POST body:
      geom            : 대지 폴리곤 GeoJSON (Polygon/MultiPolygon)
      roadSetback     : 도로 후퇴거리 (m, 기본 2)
      adjacentSetback : 대지안의 공지 이격거리 (m, 기본 1.5)
      edgeOverrides   : [{ index, type: 'road'|'adjacent' }, ...] 사용자 수동보정
    """
    body = request.get_json()
    if not body or 'geom' not in body:
        return jsonify({'error': 'geom required'}), 400

    geom = body['geom']
    # roadSetback을 사용자가 직접 입력하지 않았으면(None) 도로폭 실측 기반 자동계산으로 대체한다
    road_setback_explicit = body.get('roadSetback')
    road_setback = float(road_setback_explicit) if road_setback_explicit else 2.0
    adjacent_setback = float(body.get('adjacentSetback') or 1.5)
    overrides = {
        o['index']: o['type']
        for o in (body.get('edgeOverrides') or [])
        if 'index' in o and 'type' in o
    }

    try:
        coords_for_bbox = []

        def collect(c):
            if isinstance(c[0], (int, float)):
                coords_for_bbox.append(c)
            else:
                for item in c:
                    collect(item)

        collect(geom['coordinates'])
        lats = [c[1] for c in coords_for_bbox]
        lat0 = (min(lats) + max(lats)) / 2
        m_lat = 111320.0
        m_lon = 111320.0 * math.cos(lat0 * math.pi / 180)

        def to_m(lon, lat):
            return (lon * m_lon, lat * m_lat)

        def to_ll(x, y):
            return (x / m_lon, y / m_lat)

        parcel_shape = shapely_transform(lambda lon, lat: to_m(lon, lat), shape(geom))
        if not parcel_shape.is_valid:
            parcel_shape = parcel_shape.buffer(0)
        if parcel_shape.geom_type == 'MultiPolygon':
            # 다중 필지 선택 시 인접 필지들을 하나의 대지 경계로 합침(불연속이면 가장 큰 조각만 사용)
            merged = unary_union(list(parcel_shape.geoms))
            parcel_shape = merged if merged.geom_type == 'Polygon' else max(merged.geoms, key=lambda g: g.area)

        centroid = parcel_shape.centroid
        exterior_coords = list(parcel_shape.exterior.coords)
        if exterior_coords[0] == exterior_coords[-1]:
            exterior_coords = exterior_coords[:-1]

        n = len(exterior_coords)
        edges_info = []
        working = parcel_shape
        MARGIN = 100000  # 반평면 폴리곤용 충분히 큰 거리(m)

        for i in range(n):
            p1 = exterior_coords[i]
            p2 = exterior_coords[(i + 1) % n]
            dx, dy = p2[0] - p1[0], p2[1] - p1[1]
            length = math.hypot(dx, dy)
            if length < 0.01:
                continue
            ux, uy = dx / length, dy / length
            # 두 법선 후보 중 대지 중심 반대쪽(바깥쪽)을 선택
            nx, ny = -uy, ux
            mid = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
            to_centroid = (centroid.x - mid[0], centroid.y - mid[1])
            if nx * to_centroid[0] + ny * to_centroid[1] > 0:
                nx, ny = -nx, -ny

            sample_x, sample_y = mid[0] + nx * 2.5, mid[1] + ny * 2.5
            sample_lon, sample_lat = to_ll(sample_x, sample_y)

            edge_type = overrides.get(i)
            road_width_m = None
            if edge_type is None:
                if length < 1.0:
                    # 너무 짧은 변(디지타이징 노이즈)은 VWorld 조회 없이 보수적으로 인접대지 처리
                    edge_type = 'adjacent'
                else:
                    edge_type, road_width_m = classify_edge(sample_lon, sample_lat)

            is_north = ny > 0.3  # 바깥쪽 법선이 북쪽 성분 우세 -> 정북 인접대지경계선 후보
            north_exempt = is_north_exempt_zone(query_zone_name(sample_lon, sample_lat)) if is_north else None

            p1_ll = to_ll(*p1)
            p2_ll = to_ll(*p2)
            edges_info.append({
                'index': i,
                'type': edge_type,
                'isNorth': is_north,
                'northExempt': north_exempt,
                'roadWidthM': road_width_m,
                'p1': [p1_ll[0], p1_ll[1]],
                'p2': [p2_ll[0], p2_ll[1]]
            })

            if is_north:
                continue  # 정북변은 프런트엔드에서 높이비례로 추가 클리핑 (정북일조 면제 시 프런트엔드에서 건너뜀)

            if edge_type == 'road' and road_setback_explicit is None and road_width_m is not None:
                # 사용자가 도로 후퇴거리를 직접 입력하지 않았으면, 측정된 실제 도로폭으로
                # 건축법 제46조(소요폭 4m 미달분의 1/2 후퇴)를 자동 계산
                setback = max(0.0, 2.0 - road_width_m / 2.0)
            else:
                setback = road_setback if edge_type == 'road' else adjacent_setback
            if setback <= 0:
                continue

            ox, oy = p1[0] - nx * setback, p1[1] - ny * setback
            p_a = (ox - ux * MARGIN, oy - uy * MARGIN)
            p_b = (ox + ux * MARGIN, oy + uy * MARGIN)
            p_c = (p_b[0] - nx * MARGIN, p_b[1] - ny * MARGIN)
            p_d = (p_a[0] - nx * MARGIN, p_a[1] - ny * MARGIN)
            halfplane = Polygon([p_a, p_b, p_c, p_d])

            clipped = working.intersection(halfplane)
            if not clipped.is_empty and clipped.area > 0:
                if clipped.geom_type == 'MultiPolygon':
                    clipped = max(clipped.geoms, key=lambda g: g.area)
                working = clipped

        envelope_ll = shapely_transform(lambda x, y: to_ll(x, y), working)
        envelope_geojson = mapping(envelope_ll)

        return jsonify({
            'envelope': envelope_geojson,
            'edges': edges_info,
            'envelopeAreaM2': round(working.area),
            'parcelAreaM2': round(parcel_shape.area)
        })

    except Exception as e:
        print('buildable_envelope error:', e)
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print("="*55)
    print("  건축개요 자동 생성 웹 서비스 서버가 시작되었습니다!")
    print("  브라우저에서 http://127.0.0.1:5000 으로 접속하세요.")
    print("="*55)
    app.run(debug=True, port=5000)
