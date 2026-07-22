"""
건축개요 자동 생성 웹 서비스
Flask 백엔드: 정적 파일 호스팅 + Nominatim(OpenStreetMap) 주소 검색 프록시
"""
from flask import Flask, render_template, jsonify, request
import requests as req_lib
import json
import os

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
    각 용도지역별 교차 면적(WKT BBOX 기반 근사)을 반환
    
    POST body: { "geom": <GeoJSON geometry>, "total_area": <float in m2> }
    """
    body = request.get_json()
    if not body or 'geom' not in body:
        return jsonify({'error': 'geom required'}), 400

    geom = body['geom']
    total_area = body.get('total_area', 0)

    # Bounding box from GeoJSON geometry for VWorld geomFilter
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
        
        # 바운딩박스를 WKT POLYGON으로 변환
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
            'maxFeatures': 10
        }
        
        resp = req_lib.get(url, params=params, timeout=8)
        data = resp.json()
        features = data.get('response', {}).get('result', {}).get('featureCollection', {}).get('features', [])
        
        if not features:
            return jsonify({'zones': {}, 'method': 'none'})
        
        # 각 용도지역 feature의 바운딩박스 교차 면적 계산
        import math
        
        def ring_area_m2(coords):
            """Shoelace formula for ring area in m2 (approx)"""
            n = len(coords)
            if n < 3:
                return 0
            lat0 = coords[0][1]
            mLat = 111320
            mLon = 111320 * math.cos(lat0 * math.pi / 180)
            area = 0
            j = n - 1
            for i in range(n):
                xi = coords[i][0] * mLon
                yi = coords[i][1] * mLat
                xj = coords[j][0] * mLon
                yj = coords[j][1] * mLat
                area += (xj + xi) * (yj - yi)
                j = i
            return abs(area) / 2

        def geom_area_m2(g):
            if not g:
                return 0
            t = g.get('type', '')
            coords = g.get('coordinates', [])
            if t == 'Polygon':
                area = ring_area_m2(coords[0])
                for hole in coords[1:]:
                    area -= ring_area_m2(hole)
                return max(area, 0)
            elif t == 'MultiPolygon':
                total = 0
                for poly in coords:
                    total += ring_area_m2(poly[0])
                    for hole in poly[1:]:
                        total -= ring_area_m2(hole)
                return max(total, 0)
            return 0

        def bbox_intersect_area(b1, b2):
            """BBOX 교차 면적 (m2 근사)"""
            ix_min = max(b1[0], b2[0])
            iy_min = max(b1[1], b2[1])
            ix_max = min(b1[2], b2[2])
            iy_max = min(b1[3], b2[3])
            if ix_min >= ix_max or iy_min >= iy_max:
                return 0
            lat0 = (iy_min + iy_max) / 2
            mLat = 111320
            mLon = 111320 * math.cos(lat0 * math.pi / 180)
            return (ix_max - ix_min) * mLon * (iy_max - iy_min) * mLat

        parcel_bbox = (minx, miny, maxx, maxy)
        parcel_area_m2 = total_area if (total_area and total_area > 0) else geom_area_m2(geom)
        
        zones_raw = {}  # {zone_name: intersection_area_m2}
        
        for feat in features:

            raw_name = feat.get('properties', {}).get('uname', '')
            zone_name = fix_name(raw_name)
            if not zone_name:
                continue
            
            # 용도지역 feature의 geometry와 필지 BBOX 교차 면적 계산
            feat_geom = feat.get('geometry')
            if feat_geom:
                # 용도지역 도형 BBOX
                feat_coords = []
                def collect_coords(c):
                    if isinstance(c[0], (int, float)):
                        feat_coords.append(c)
                    else:
                        for item in c:
                            collect_coords(item)
                try:
                    collect_coords(feat_geom.get('coordinates', []))
                    if feat_coords:
                        flons = [c[0] for c in feat_coords]
                        flats = [c[1] for c in feat_coords]
                        feat_bbox = (min(flons), min(flats), max(flons), max(flats))
                        intersect_bbox_area = bbox_intersect_area(parcel_bbox, feat_bbox)
                        if intersect_bbox_area > 0:
                            zones_raw[zone_name] = zones_raw.get(zone_name, 0) + intersect_bbox_area
                except:
                    pass

        if not zones_raw:
            return jsonify({'zones': {}, 'method': 'none'})

        # 합계로 정규화하여 실제 대지면적에 맞게 배분
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



if __name__ == '__main__':
    print("="*55)
    print("  건축개요 자동 생성 웹 서비스 서버가 시작되었습니다!")
    print("  브라우저에서 http://127.0.0.1:5000 으로 접속하세요.")
    print("="*55)
    app.run(debug=True, port=5000)
