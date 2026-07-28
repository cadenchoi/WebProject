"""
geo_utils.py
app.py와 massing.py가 공통으로 쓰는 저수준 지오메트리/브이월드 조회 헬퍼.
massing.py가 app.py를 import하지 않아도 되도록(순환 import 방지) 여기 모아둔다.
"""
import math
import requests as req_lib
from shapely.geometry import Polygon
from shapely.ops import transform as shapely_transform


def make_meter_converters(lat0):
    """기준위도 lat0의 등장방형 근사로 위경도(도) <-> 미터 평면좌표 변환 함수쌍을 반환."""
    m_lat = 111320.0
    m_lon = 111320.0 * math.cos(lat0 * math.pi / 180)

    def to_m(lon, lat):
        return (lon * m_lon, lat * m_lat)

    def to_ll(x, y):
        return (x / m_lon, y / m_lat)

    return to_m, to_ll


def clip_halfplane(polygon, p1, p2, inward_normal, setback):
    """
    polygon(미터 좌표)에서 변 p1->p2를 setback만큼 안쪽으로 민 반평면과의 교집합을 반환.
    inward_normal은 대지 안쪽을 가리키는 단위법선(nx, ny).
    """
    if setback <= 0:
        return polygon
    nx, ny = inward_normal
    ux, uy = (p2[0] - p1[0]), (p2[1] - p1[1])
    length = math.hypot(ux, uy)
    if length < 1e-9:
        return polygon
    ux, uy = ux / length, uy / length

    MARGIN = 100000  # 반평면 폴리곤용 충분히 큰 거리(m)
    ox, oy = p1[0] - nx * setback, p1[1] - ny * setback
    p_a = (ox - ux * MARGIN, oy - uy * MARGIN)
    p_b = (ox + ux * MARGIN, oy + uy * MARGIN)
    p_c = (p_b[0] - nx * MARGIN, p_b[1] - ny * MARGIN)
    p_d = (p_a[0] - nx * MARGIN, p_a[1] - ny * MARGIN)
    halfplane = Polygon([p_a, p_b, p_c, p_d])

    clipped = polygon.intersection(halfplane)
    if clipped.is_empty or clipped.area <= 0:
        return clipped
    if clipped.geom_type == 'MultiPolygon':
        clipped = max(clipped.geoms, key=lambda g: g.area)
    return clipped


def classify_edge(lon, lat, vworld_api_key, probe_dir=None):
    """
    대지 변 바깥쪽 샘플 지점의 연속지적도(LP_PA_CBND_BUBUN)를 조회해 도로/인접대지를 판정.
    이 레이어는 별도 지목 필드가 없고 jibun 문자열 끝에 지목 접미글자가 붙는 관행 표기를
    그대로 반환한다 (실제 조회 확인: 도로 필지는 "1373도"처럼 "도"로 끝남).
    도로로 판정되면 도로폭을 근사 측정해 함께 반환한다(건축법 제46조 도로사선 후퇴 자동계산용).

    도로폭 측정은 대지 변에 수직인 방향(probe_dir, 즉 app.py가 이미 계산해 둔 그 변의 바깥쪽
    법선)으로 도로 필지를 관통하는 직선을 긋고, 그 교차 구간의 길이를 잰다("국소 단면 측정").
    이전에는 도로 필지 전체를 감싸는 최소회전사각형(minimum_rotated_rectangle)의 짧은 변을
    썼는데, VWorld 연속지적도의 "도로" 필지는 교차로·회전(커브) 구간·중앙분리대 등을 한
    필지로 묶어 등록해 둔 경우가 흔해서, 필지 전체를 감싸는 사각형의 폭이 실제 대지 앞
    도로 폭보다 훨씬 크게 나올 수 있었다(예: 커브 구간이 필지에 포함되면 그 굽은 정도만큼
    사각형이 넓어짐). probe_dir을 넘기지 않은 호출부(구버전 호환)는 기존 방식으로 폴백한다.
    """
    try:
        url = 'https://api.vworld.kr/req/data'
        params = {
            'service': 'data',
            'request': 'GetFeature',
            'data': 'LP_PA_CBND_BUBUN',
            'key': vworld_api_key,
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
                from shapely.geometry import shape, LineString, Point
                road_shape_ll = shape(road_geom)
                rep_lat = road_shape_ll.representative_point().y
                r_m_lat = 111320.0
                r_m_lon = 111320.0 * math.cos(rep_lat * math.pi / 180)
                road_shape_m = shapely_transform(lambda x, y: (x * r_m_lon, y * r_m_lat), road_shape_ll)

                if probe_dir is not None:
                    pnx, pny = probe_dir
                    plen = math.hypot(pnx, pny)
                    if plen > 1e-9:
                        pnx, pny = pnx / plen, pny / plen
                        sample_m = (lon * r_m_lon, lat * r_m_lat)
                        PROBE_LEN = 200  # 실제 도로가 아무리 넓어도 충분히 긴 탐침(m)
                        start = (sample_m[0] - pnx * PROBE_LEN, sample_m[1] - pny * PROBE_LEN)
                        end = (sample_m[0] + pnx * PROBE_LEN, sample_m[1] + pny * PROBE_LEN)
                        inter = LineString([start, end]).intersection(road_shape_m)
                        seg = None
                        if inter.geom_type == 'LineString' and not inter.is_empty:
                            seg = inter
                        elif inter.geom_type == 'MultiLineString' and len(inter.geoms) > 0:
                            # 여러 조각으로 끊기면(도로 필지 형태가 복잡한 경우) 대지 변에서
                            # 가장 가까운 조각을 채택 — 우리 대지 바로 앞 단면이어야 하므로.
                            start_pt = Point(start)
                            seg = min(inter.geoms, key=lambda g: g.distance(start_pt))
                        if seg is not None and seg.length > 0:
                            road_width = round(seg.length, 1)

                if road_width is None:
                    # probe_dir 미지정 또는 국소 측정 실패 시 폴백: 필지 전체 최소회전사각형
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


def query_zone_name(lon, lat, vworld_api_key):
    """샘플 지점의 용도지역명(LT_C_UQ111) 조회 — 정북일조 예외(북측이 비주거지역) 판정용"""
    try:
        url = 'https://api.vworld.kr/req/data'
        params = {
            'service': 'data',
            'request': 'GetFeature',
            'data': 'LT_C_UQ111',
            'key': vworld_api_key,
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
