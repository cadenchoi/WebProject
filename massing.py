"""
massing.py
공동주택 주동(Mass) 자동 배치·최적화 알고리즘.

static/js/calculator.js의 개략 배치 시뮬레이션(estimatePolygonLayout 등)은 고정된 목표
세대수를 맞추는 데 필요한 층수를 한 번의 그리디 패킹으로 근사할 뿐, 회전각·위치·층수를
실제로 바꿔가며 법정 용적률 한도를 최대한 활용하는 탐색은 하지 않는다.

이 모듈은 대지의 건축가능영역(도로/인접대지 이격 적용됨, app.py의 /api/buildable-envelope
결과) 위에서 유전 알고리즘(GA)으로 동의 위치·회전각·조합(comboKey)·유닛별 층수를 함께
탐색해, 법정 건폐율/용적률 상한을 넘지 않으면서 용적률을 가장 많이 활용하는 배치를
채택한다 — "이 대지에서 법적으로 지을 수 있는 최대 수용력"을 산출하는 것이 목표다
(입력된 목표 세대수는 참고하지 않는다).

주동 형상은 참조 이미지에 그려진 정확히 9종의 조합(2호~6호, UNIT_COMBO_BUILDERS)만
사용한다 — 판상형/L자형/타워형 등 자유 형상·자유 각도 조합은 배치 후보에서 완전히
제외했다. 화면에서 조합 하나(comboKey)를 선택하면 그 조합 위주로 배치하되, 법정
용적률·인동채광 이격을 그 조합만으로 못 채우면 GA가 다른 조합을 섞어 넣을 수 있다
(pack_params['primaryComboKey']). '자동' 선택 시에는 처음부터 9종을 자유롭게 섞는다.
정밀도를 우선해 GA를 여러 번(재시작) 돌려 그중 가장 세대수가 높은 배치를 채택한다.
"""
import math
import random
import time
from collections import Counter
from shapely.geometry import Polygon as ShapelyPolygon, LineString
from shapely.ops import unary_union

import geo_utils

IN_ROW_BUILDING_GAP = 6  # 같은 행(밴드) 안 동 사이 최소 이격(단변/측벽 간, m) — calculator.js와 동일 상수
ABSOLUTE_MAX_FLOORS = 70  # 어떤 경우에도 넘지 않는 절대 안전 상한 (calculator.js의 기존 1~70층 클램프와 동일)

# 인동간격(동간 거리, 건축법 시행령 제86조③2호가목) 비율 — 채광사선(같은 조③1호, 인접대지경계선·
# 도로중심선 기준, pack_params['buildingGapRatio']가 담당)과는 별개 조항이라 지역별 완화가 없다.
# 도시형 생활주택만 0.25배, 그 외(이 앱이 다루는 일반 공동주택)는 준주거·근린상업이어도 항상
# 0.5배(사용자 법조문 확인, 2026-07-26). _buildings_gap_ok/_derive_row_lines 등 동-동 거리를
# 다루는 곳은 반드시 이 상수를 쓰고, pack_params['buildingGapRatio']를 쓰면 안 된다(그건 동-
# 대지경계선/도로중심선 거리 전용).
INTER_BUILDING_GAP_RATIO = 0.5

# 정북일조(건축법 시행령 제86조①)가 적용되는 용도지역 — 전용주거·일반주거지역뿐이다. 그 외
# (준주거·상업·공업·녹지 등)는 이 조항 자체가 미적용이며, "완화"가 아니라 "정북 이격 자체가 없다".
NORTH_SETBACK_APPLICABLE_ZONES = {
    '제1종전용주거지역', '제2종전용주거지역',
    '제1종일반주거지역', '제2종일반주거지역', '제3종일반주거지역'
}


def num(v):
    try:
        if v is None or v == '':
            return 0.0
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# ─────────────────────────────────────────────────────────────
# 기하 유틸 (calculator.js의 폴리곤 유틸을 그대로 포팅 — 위경도 대신 로컬 미터 좌표의
# (x, y) 튜플 리스트로 폴리곤을 표현한다. shapely 대신 순수 파이썬으로 두는 이유는
# estimatePolygonLayout과 동일한 회전 로컬좌표계 슬라이싱/클리핑 방식을 그대로 재사용해
# JS 버전과 결과가 어긋나지 않게 하기 위함이다.)
# ─────────────────────────────────────────────────────────────

def polygon_centroid_approx(poly):
    n = len(poly)
    sx = sum(p[0] for p in poly)
    sy = sum(p[1] for p in poly)
    return (sx / n, sy / n)


def clip_polygon_by_halfplane(poly, line_point, normal):
    """Sutherland-Hodgman 단일 반평면 클리핑 (calculator.js clipPolygonByHalfplane 포팅)."""
    if not poly or len(poly) < 3:
        return []

    def dist(p):
        return (p[0] - line_point[0]) * normal[0] + (p[1] - line_point[1]) * normal[1]

    out = []
    n = len(poly)
    for i in range(n):
        cur = poly[i]
        prev = poly[i - 1]
        d_cur, d_prev = dist(cur), dist(prev)
        cur_in, prev_in = d_cur >= 0, d_prev >= 0
        if cur_in:
            if not prev_in:
                t = d_prev / (d_prev - d_cur)
                out.append((prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])))
            out.append(cur)
        elif prev_in:
            t = d_prev / (d_prev - d_cur)
            out.append((prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])))
    return out


def geojson_to_meter_ring(geojson, to_m):
    if geojson['type'] == 'Polygon':
        ring = geojson['coordinates'][0]
    elif geojson['type'] == 'MultiPolygon':
        ring = geojson['coordinates'][0][0]
    else:
        return None
    pts = [to_m(c[0], c[1]) for c in ring]
    if len(pts) > 1:
        a, b = pts[0], pts[-1]
        if abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9:
            pts.pop()
    return pts


def _avg_lat_of_geojson(geojson):
    coords = []

    def collect(c):
        if isinstance(c[0], (int, float)):
            coords.append(c)
        else:
            for item in c:
                collect(item)

    collect(geojson['coordinates'])
    lats = [c[1] for c in coords]
    return sum(lats) / len(lats)


# ─────────────────────────────────────────────────────────────
# Step 1(일부): 정북일조 클리핑 + 회전각 후보 도출
# ─────────────────────────────────────────────────────────────

def compute_assumed_height_m(floors, h1_mm, h2_mm, h3_mm, htyp_mm):
    """1~3층/기준층 층고(mm)를 받아 층수만큼 합산한 예상 높이(m). calculator.js computeAssumedHeightM 포팅."""
    def to_m_h(mm):
        v = num(mm)
        return (v if v > 0 else 2900) / 1000

    h1, h2, h3, htyp = to_m_h(h1_mm), to_m_h(h2_mm), to_m_h(h3_mm), to_m_h(htyp_mm)
    n = max(1, round(floors))
    total = 0.0
    for i in range(1, n + 1):
        if i == 1:
            total += h1
        elif i == 2:
            total += h2
        elif i == 3:
            total += h3
        else:
            total += htyp
    return total


def clip_daylight_setback_edges(poly_m, edges_info, to_m, assumed_height_m, north_setback_ratio, building_gap_ratio,
                                 apply_north_setback=True):
    """
    높이비례 채광 이격을 모든 변(도로 포함)에 적용한다(이 층수 기준으로 매번 새로 계산) — 이 검증을
    통과하지 못하는 (회전각, 층수) 조합은 optimize_massing에서 반드시 배제된다.
    (clipped_poly, setback_details) 튜플을 반환한다 — setback_details는 변별로 기준선·적용배수·
    요구 이격거리를 담아, 화면에서 "어느 기준선에서 몇 배(H×ratio)를 적용해 몇 m를 요구했는지"
    투명하게 보여줄 수 있게 한다.

    · 정북 방향(isNorth, 'adjacent'만): 정북일조 비율(north_setback_ratio). 두 가지 독립적인 면제
      사유가 있다 — (1) northExempt: 정북 방향의 이웃 대지가 비주거용도라 면제되는 경우, (2)
      apply_north_setback=False: 이 대지 자체의 용도지역이 애초에 정북일조 규정(건축법 시행령
      제86조①, 전용주거·일반주거지역에만 있음) 대상이 아닌 경우(준주거·상업·공업·녹지 등) — 이건
      "면제"가 아니라 "그 조항 자체가 미적용"이다. 둘 중 하나만 해당해도 정북 이격을 적용하지 않는다.
    · 그 외 인접대지경계선(동/서/남측): 인동간격/채광사선 비율(building_gap_ratio), 면제 없이 항상 적용.
    · 도로변: 공동주택 채광사선 규정상 도로 건너편에도 건물이 있을 수 있다고 보고, 대지경계선이 아닌
      "도로 중심선"을 기준점으로 인동간격 비율을 적용한다 — 도로 폭의 절반은 이미 이격거리로 인정되므로
      대지경계선에서 추가로 필요한 후퇴는 max(0, height*ratio - 도로폭/2)이다. 도로폭 실측값이 없으면
      보수적으로 크레딧을 주지 않는다(0으로 간주, 즉 전체 height*ratio를 대지경계선부터 그대로 요구).
      /api/buildable-envelope에서 이미 적용된 도로폭 기반 고정 후퇴(건축법 제46조)와는 별개로 추가된다.

    이전 버전은 정북 변만 재클리핑해서 나머지 변(동/서/남측·도로변)은 건물이 아무리 높아져도 이격이
    늘지 않는 버그가 있었다 — 구석에 극단적으로 높은 동 하나를 배치해 용적률을 채우는 비현실적인
    결과(예: 63층 단일동)가 "적합"으로 잘못 통과되는 원인이었다.

    building_gap_ratio는 이 함수(대지경계선/도로중심선 기준 채광사선, 건축법 시행령 제86조③1호)
    전용이다 — 동-동 거리(인동간격, 같은 조③2호)는 지역별 완화가 없는 별개 상수(INTER_BUILDING_
    GAP_RATIO)를 쓰며 이 함수와는 무관하다(evaluate_genome/_buildings_gap_ok/_derive_row_lines 참고).
    """
    result = poly_m
    centroid = polygon_centroid_approx(poly_m)
    setback_details = []
    for edge in (edges_info or []):
        edge_type = edge.get('type')
        if edge_type not in ('adjacent', 'road'):
            continue
        is_north = edge.get('isNorth')

        if edge_type == 'adjacent' and is_north and (edge.get('northExempt') or not apply_north_setback):
            setback_details.append({
                'edgeIndex': edge.get('index'), 'type': 'adjacent', 'isNorth': True,
                'referenceLine': '정북 인접대지경계선', 'ratio': north_setback_ratio,
                'exempted': True, 'requiredSetbackM': 0.0
            })
            continue  # 정북일조 면제(북측이 비주거지역) — 정북 방향에만 있는 예외

        if edge_type == 'road':
            road_width = num(edge.get('roadWidthM'))
            ratio = building_gap_ratio
            required_from_centerline = assumed_height_m * (ratio or 0.5)
            setback = max(0.0, required_from_centerline - road_width / 2.0)
            setback_details.append({
                'edgeIndex': edge.get('index'), 'type': 'road', 'isNorth': False,
                'referenceLine': '도로 중심선', 'ratio': ratio,
                'roadWidthM': road_width, 'roadCenterlineCreditM': round(road_width / 2.0, 2),
                'requiredFromReferenceM': round(required_from_centerline, 2),
                'requiredSetbackM': round(setback, 2)  # 대지경계선 기준 추가 후퇴량(도로폭 크레딧 차감 후)
            })
            if setback <= 0:
                continue
        else:
            ratio = north_setback_ratio if is_north else building_gap_ratio
            setback = max(1.5, assumed_height_m * (ratio or 0.5))
            setback_details.append({
                'edgeIndex': edge.get('index'), 'type': 'adjacent', 'isNorth': bool(is_north),
                'referenceLine': '정북 인접대지경계선' if is_north else '인접대지경계선',
                'ratio': ratio, 'requiredSetbackM': round(setback, 2)
            })

        p1 = to_m(*edge['p1'])
        p2 = to_m(*edge['p2'])
        dx, dy = p2[0] - p1[0], p2[1] - p1[1]
        length = math.hypot(dx, dy)
        if length < 0.01:
            continue
        nx, ny = -dy / length, dx / length
        mid = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
        to_centroid = (centroid[0] - mid[0], centroid[1] - mid[1])
        if nx * to_centroid[0] + ny * to_centroid[1] < 0:
            nx, ny = -nx, -ny
        line_point = (mid[0] + nx * setback, mid[1] + ny * setback)
        result = clip_polygon_by_halfplane(result, line_point, (nx, ny))
        if len(result) < 3:
            return result, setback_details
    return result, setback_details


def derive_orientation_candidates(edges_info, to_m):
    """
    도로변 방향 + 그 수직방향을 우선 후보로 삼고(각도 반올림으로 중복 제거),
    0~90도 15도 간격 스윕을 더해 회전각 탐색 범위를 넓힌다.
    calculator.js의 고정 2후보(stackDirA/stackDirB)를 N개 후보로 일반화한 것.
    """
    candidates = []
    seen_degrees = set()

    def add_candidate(stack_dir, front_source):
        length = math.hypot(*stack_dir)
        if length < 1e-9:
            return
        sd = (stack_dir[0] / length, stack_dir[1] / length)
        deg = round(math.degrees(math.atan2(sd[1], sd[0]))) % 180
        if deg in seen_degrees:
            return
        seen_degrees.add(deg)
        width_dir = (sd[1], -sd[0])
        candidates.append({'stackDir': sd, 'widthDir': width_dir, 'rotationDeg': deg, 'frontSource': front_source})

    for edge in (edges_info or []):
        if edge.get('type') != 'road' or edge.get('isNorth'):
            continue
        p1 = to_m(*edge['p1'])
        p2 = to_m(*edge['p2'])
        dx, dy = p2[0] - p1[0], p2[1] - p1[1]
        length = math.hypot(dx, dy)
        if length < 1e-6:
            continue
        road_dir = (dx / length, dy / length)
        perp = (-road_dir[1], road_dir[0])
        add_candidate(perp, 'road')
        add_candidate(road_dir, 'road')

    if not candidates:
        add_candidate((0.0, 1.0), 'south')

    base_angle = math.atan2(candidates[0]['stackDir'][1], candidates[0]['stackDir'][0])
    for step_deg in range(0, 91, 15):
        theta = base_angle + math.radians(step_deg)
        add_candidate((math.cos(theta), math.sin(theta)), 'sweep')

    return candidates


# ─────────────────────────────────────────────────────────────
# Step 2~3: 표준 모듈 초기 배치 + (구조적) 검증
# ─────────────────────────────────────────────────────────────

def attach_per_type_unit_widths(unit_type_list, base_unit_width):
    """
    세대타입별로 공급면적 비례 세대 폭을 계산해 붙인다. base_unit_width(표준 세대 폭)는 전체
    세대의 평균 공급면적 기준으로 이미 스케일된 값이므로, 각 타입은 자신의 공급면적이 평균보다
    크면 더 넓게, 작으면 더 좁게 비례 배정한다 — 84타입과 59타입이 섞인 동에서 실제 크기 차이가
    시각적으로 드러나도록 한다(이전에는 모든 타입이 동일한 표준폭이었음). calculator.js
    attachPerTypeUnitWidths 포팅.
    """
    if not unit_type_list:
        return unit_type_list
    total_count = sum(num(t.get('count')) for t in unit_type_list) or 1
    avg_supply_area = sum(num(t.get('count')) * num(t.get('supplyArea')) for t in unit_type_list) / total_count
    result = []
    for t in unit_type_list:
        unit_width = base_unit_width * (num(t.get('supplyArea')) / avg_supply_area) if avg_supply_area > 0 else base_unit_width
        result.append({**t, 'unitWidth': unit_width})
    return result


def validate_placement(rows, envelope_pts, gap_ratio=None):
    """방어적 재검증: GA(evaluate_genome)가 이미 인동간격·컨테인먼트를 판정했지만, 여기서는
    직렬화된 최종 데이터(rows, genome_result_to_rows의 출력)만으로 독립적으로 다시 확인한다
    — 알고리즘 자체가 아니라 "실제로 화면에 나가는 데이터"를 검증 대상으로 삼아, 직렬화
    과정에서 생긴 문제도 함께 잡는다. 예전에는 이격 재검증이 고정 최소 이격(IN_ROW_BUILDING_GAP,
    6m)만 확인해, 채광창 벽면이 실제로 마주보아 높이 비례 이격이 필요한 경우조차 통과시키는
    표기상 공백이 있었다 — evaluate_genome과 똑같은 _buildings_gap_ok(벽면 투영 기반 판정)를
    재사용해 이 공백을 없앤다."""
    if len(envelope_pts) < 3:
        return {'ok': False, 'violations': ['invalid-envelope']}
    envelope_shape = ShapelyPolygon(envelope_pts).buffer(0.01)

    buildings = []
    for r in rows:
        if not r.get('pathM') or len(r['pathM']) < 3:
            continue
        shp = ShapelyPolygon(r['pathM'])
        if not shp.is_valid or shp.area <= 0:
            continue
        units = [
            {'windowNormal': seg.get('windowNormal'), 'corners': seg['pathM']}
            for seg in (r.get('segments') or []) if seg.get('pathM') and len(seg['pathM']) >= 3
        ]
        buildings.append({'shape': shp, 'height': r.get('height') or 0, 'units': units})

    violations = []
    for b in buildings:
        if not envelope_shape.contains(b['shape'].buffer(-0.01)):
            violations.append('envelope-containment')
            break
    for i in range(len(buildings)):
        for j in range(i + 1, len(buildings)):
            a, c = buildings[i], buildings[j]
            if not _buildings_gap_ok(a['units'], a['height'], a['shape'], c['units'], c['height'], c['shape'], gap_ratio):
                violations.append(f"gap-{i}-{j}:{round(a['shape'].distance(c['shape']), 2)}m")
    return {'ok': len(violations) == 0, 'violations': violations}


# ─────────────────────────────────────────────────────────────
# Step 4~5: 유전 알고리즘 — 9종 유닛조합 카탈로그(2호~6호)만을 배치 후보로 쓰는 개체군 탐색.
# 유전자 = {rotationDeg, buildings:[{x, y, comboKey, unitFloors:[...]}, ...]}. rotationDeg
# 하나가 대지 전체(모든 동)가 공유하는 방향이다 — 동마다 따로 도는 회전각은 없다(실제
# 단지가 동마다 제각각 방향으로 서 있지 않고 한 방향으로 나란히 줄지어 배치되는 것과
# 동일). 하나의 유전자가 완결된 배치안 전체를 표현한다. 결정론적 레거시 패커·다형상 비교
# 로직은 없으므로 free_pool의 안전 유전자(_safe_building)가 유일한 안전망이다.
# ─────────────────────────────────────────────────────────────

def south_score(rotation_deg):
    """
    rotation_deg는 (레거시 derive_orientation_candidates와 동일한 관례로) stackDir(적층방향, 동을
    쌓아나가는 방향)의 각도다. stackDir=(0,1)(정북) 일 때 widthDir=(stackDir.y,-stackDir.x)=(1,0)이
    되어 장변이 동서로 늘어서고 건물이 정남향을 바라본다("기존 코드: 정북(0,1) = 정남향 건물이
    장변으로 늘어섬"). 즉 stackDir이 남북축(±90도)에 가까울수록 남향 장변이 되므로,
    stackDir의 y성분(=sin(rotation_deg))의 절댓값이 1에 가까울수록 높은 점수(0~1)를 준다.
    """
    rad = math.radians(rotation_deg % 180)
    return abs(math.sin(rad))


def balance_score(accepted_meta, site_stats):
    """
    채택된 동들의 중심점이 대지 전체에 고르게 안분됐을 때 높은 점수(0~1).
    편향도(중심점 평균이 대지 중심에서 벗어난 정도)와 분산도(동 간 평균거리/대지 대각선)를
    절반씩 합산 — 편향만 재면 "대지 중앙에 옹기종기 모인" 배치가 만점을 받는 오류를 피한다.
    """
    if not accepted_meta:
        return 0.0
    site_cx, site_cy = site_stats['centroid']
    half_w, half_d, diag = site_stats['halfW'], site_stats['halfD'], site_stats['diag']
    centers = [m['centerLocal'] for m in accepted_meta]
    mean_cx = sum(c[0] for c in centers) / len(centers)
    mean_cy = sum(c[1] for c in centers) / len(centers)
    dx = (mean_cx - site_cx) / (half_w or 1)
    dy = (mean_cy - site_cy) / (half_d or 1)
    alignment = max(0.0, 1 - min(1.0, math.hypot(dx, dy)))
    if len(centers) < 2:
        dispersion = 0.0
    else:
        pairs = [
            math.hypot(centers[i][0] - centers[j][0], centers[i][1] - centers[j][1])
            for i in range(len(centers)) for j in range(i + 1, len(centers))
        ]
        dispersion = min(1.0, (sum(pairs) / len(pairs)) / (diag or 1))
    return 0.5 * alignment + 0.5 * dispersion


def floor_neighbor_smoothness_score(accepted_meta, max_floors_cap):
    """채택된 동들 각각을 "가장 가까운 이웃 동 하나"와만 비교해, 대표층수(그 동의
    (minFloors+maxFloors)/2) 차이가 작을수록 1에 가까운 점수를 준다. 전체 쌍이 아니라
    최근접 이웃만 보는 이유: 멀리 떨어진 동끼리 층수가 다른 것은 실제 설계에서도 자연스럽고
    불이익을 줄 이유가 없다 — "바로 옆에 붙어있는 동인데 층수만 뚝뚝 튄다"는 부자연스러움만
    억제하는 게 목적이다(사용자 피드백: "주동끼리 유닛끼리 층수 차이가 너무 많이 나서...
    비슷한 층들이 적절한 위치에 배치되었으면"). max_floors_cap으로 정규화해(그 이상 벌어지는
    경우는 실제로 거의 없다) 0~1 범위를 유지한다."""
    if len(accepted_meta) < 2:
        return 1.0
    reps = [(m['minFloors'] + m['maxFloors']) / 2 for m in accepted_meta]
    centers = [m['centerLocal'] for m in accepted_meta]
    diffs = []
    for i in range(len(accepted_meta)):
        nearest_dist, nearest_diff = None, None
        for j in range(len(accepted_meta)):
            if i == j:
                continue
            d = math.hypot(centers[i][0] - centers[j][0], centers[i][1] - centers[j][1])
            if nearest_dist is None or d < nearest_dist:
                nearest_dist, nearest_diff = d, abs(reps[i] - reps[j])
        if nearest_diff is not None:
            diffs.append(nearest_diff)
    if not diffs:
        return 1.0
    avg_diff = sum(diffs) / len(diffs)
    return max(0.0, 1.0 - avg_diff / max(1, max_floors_cap))


def grid_regularity_score(accepted_meta, rotation_deg, site_stats):
    """채택된 동들의 중심점을 rotationDeg 기준 행(stackDir)·열(widthDir) 축에 투영해, "그리드
    체계 안에서 규칙적으로" 배치됐을수록 1에 가까운 점수를 준다. 사용자 피드백: "그리드 체계
    안에서 적절히 규칙적으로 배치되는 것이 높은 점수를 얻는 것으로 가야함 — 불규칙적으로
    그리드 체계 없이 배치되는 것이 조화롭지 못해보임". 세 가지를 본다:
    (1) 행(row) 간격의 균일성 — 행-행 간격이 들쭉날쭉하지 않고 고른가.
    (2) 열(col) 간격의 균일성 — 마찬가지로 열-열 간격이 고른가(다른 행의 동끼리도 같은
        열에 맞춰 서는지).
    (3) 열 공유도 — 건물마다 전부 제각각 다른 열이면(군집 수가 건물 수만큼 많으면) 그리드감이
        없으므로 감점, 소수의 열에 여러 동이 나눠 서 있으면 가점.
    행/열 군집은 대지 스케일(대각선)에 비례한 허용오차로 묶어(절대 m값을 쓰면 대지 크기가
    다를 때 기준이 안 맞는다), 동이 3개 미만이면 "규칙성"을 논할 표본이 안 되므로 만점 처리."""
    if len(accepted_meta) < 3:
        return 1.0
    rad = math.radians(rotation_deg % 180)
    stack_dir = (math.cos(rad), math.sin(rad))
    width_dir = (stack_dir[1], -stack_dir[0])
    ox, oy = site_stats['centroid']

    rows, cols = [], []
    for m in accepted_meta:
        cx, cy = m['centerLocal']
        dx, dy = cx - ox, cy - oy
        rows.append(dx * stack_dir[0] + dy * stack_dir[1])
        cols.append(dx * width_dir[0] + dy * width_dir[1])

    diag = site_stats.get('diag') or 1.0
    tol = max(diag * 0.03, 5.0)

    def cluster_1d(vals):
        order = sorted(range(len(vals)), key=lambda i: vals[i])
        clusters, cur = [], [order[0]]
        for idx in order[1:]:
            if vals[idx] - vals[cur[-1]] <= tol:
                cur.append(idx)
            else:
                clusters.append(cur)
                cur = [idx]
        clusters.append(cur)
        return clusters

    def spacing_regularity(vals, clusters):
        centers = sorted(sum(vals[i] for i in c) / len(c) for c in clusters)
        if len(centers) < 3:
            # 군집이 1~2개면 "간격의 규칙성"을 논할 표본이 부족 — 불리하지 않게 만점 처리.
            return 1.0
        gaps = [centers[i + 1] - centers[i] for i in range(len(centers) - 1)]
        mean_gap = sum(gaps) / len(gaps)
        if mean_gap <= 0:
            return 1.0
        variance = sum((g - mean_gap) ** 2 for g in gaps) / len(gaps)
        cv = (variance ** 0.5) / mean_gap  # 변동계수(작을수록 간격이 고름)
        return max(0.0, 1.0 - min(1.0, cv))

    row_clusters = cluster_1d(rows)
    col_clusters = cluster_1d(cols)
    row_reg = spacing_regularity(rows, row_clusters)
    col_reg = spacing_regularity(cols, col_clusters)
    col_sharing = 1.0 - (len(col_clusters) - 1) / max(1, len(accepted_meta) - 1)

    return 0.4 * row_reg + 0.3 * col_reg + 0.3 * col_sharing


# 참조 이미지(2호~6호, 정확히 9종)를 그대로 학습한 주동 카탈로그 — 정사각형에 가까운
# "유닛" 블록들이 사슬처럼 이어지며(직선 연장, 직각 꺾임) 필요하면 45도 회전된 마름모꼴
# 코너 유닛이 붙는 형태다. 이 카탈로그가 유일한 배치 후보군이다.
def _rect_unit(cx, cy, sx, sy):
    """직사각형 유닛(로컬 좌표) — sx=가로변, sy=세로변(꺾인 유닛은 sx/sy가 서로 바뀐 채로 들어옴).
    층당 1세대(hhPerFloor=1)."""
    return {'cx': cx, 'cy': cy, 'sx': sx, 'sy': sy, 'diamond': False, 'hhPerFloor': 1}


def _diamond_unit(cx, cy, s):
    """45도 회전된 마름모(정사각형 한 변=s) 코너 유닛. 참조 이미지를 정밀 측정(가로 스캔선으로
    획 픽셀의 x좌표를 행마다 추적해 위/아래/좌/우 꼭짓점을 역산)한 결과, 마름모는 인접
    유닛의 모서리에서 대각선 방향으로 오프셋을 주는 게 아니라 — 세로줄기(타워/스택)의
    바깥쪽 x좌표와 기준 행(맨 아래 유닛들)의 바닥 y좌표가 만나는 점에 중심이 그대로 온다
    (예: 4호-b·5호-b는 스택 높이가 1층이든 2층이든 항상 (uw+bd, 0)). 그 결과 마름모 반지름
    (s/√2)만큼 위/아래 이웃과 자연스럽게(각 변 폭 이내로) 겹쳐 shapely 합집합이 항상 하나로
    이어진 폴리곤이 된다. 참조 이미지에서 마름모 내부에 대각선이 그어져 있는 것은 마름모
    하나가 유닛 2개 몫(호수 표기 총합에 2개로 반영됨)임을 나타낸다 — s는 호출부에서
    sqrt(2*uw*bd)로 넘겨받고(유닛 1개 몫 sqrt(uw*bd)가 아님), hhPerFloor=2로 층당 세대수
    계산(evaluate_genome)에 반영한다."""
    return {'cx': cx, 'cy': cy, 's': s, 'diamond': True, 'hhPerFloor': 2}


# 아래 9개 조합의 유닛 위치는 참조 이미지를 픽셀 단위로 정밀 측정해 역산한 좌표다(변 색상
# 픽셀을 스캔해 각 유닛 사각형/마름모의 실제 경계를 검출 — 눈대중이 아니라 이미지에서 직접
# 읽어낸 값). 유닛이 이어지는 방식은 "완전히 겹치는 변 공유"가 아니라 "모서리 한 점에서 다음
# 유닛이 직각(또는 마름모는 45도)으로 꺾여 붙는" 사슬 구조이며, 어느 모서리에서 어느 방향으로
# 꺾이는지는 조합마다(3호/4호-a는 서로 다른 2개 유닛 중 첫 유닛 쪽을 덮는 방향, 4호-b/5호-a는
# 반대 방향, 4호-d/6호는 열의 가장 바깥쪽 끝에서) 다르므로 좌표를 그대로 하드코딩한다.
def _combo_2ho(uw, bd):
    return [_rect_unit(uw * 0.5, bd * 0.5, uw, bd), _rect_unit(uw * 1.5, bd * 0.5, uw, bd)]


def _combo_3ho(uw, bd):
    return [
        _rect_unit(uw * 0.5, bd * 0.5, uw, bd),
        _rect_unit(uw * 1.5, bd * 0.5, uw, bd),
        _rect_unit(uw - bd * 0.5, bd + uw * 0.5, bd, uw),
    ]


def _combo_4ho_a(uw, bd):
    return [
        _rect_unit(uw * 0.5, bd * 0.5, uw, bd),
        _rect_unit(uw * 1.5, bd * 0.5, uw, bd),
        _rect_unit(uw * 2.5, bd * 0.5, uw, bd),
        _rect_unit(uw - bd * 0.5, bd + uw * 0.5, bd, uw),
    ]


def _combo_4ho_b(uw, bd):
    s = math.sqrt(2 * uw * bd)
    return [
        _rect_unit(uw * 0.5, bd * 0.5, uw, bd),
        _rect_unit(uw + bd * 0.5, bd + uw * 0.5, bd, uw),
        _diamond_unit(uw + bd, 0, s),
    ]


def _combo_4ho_c(uw, bd):
    return [_rect_unit(uw * (i + 0.5), bd * 0.5, uw, bd) for i in range(4)]


def _combo_4ho_d(uw, bd):
    return [
        _rect_unit(uw * 0.5, bd * 0.5, uw, bd),
        _rect_unit(uw * 1.5, bd * 0.5, uw, bd),
        _rect_unit(uw * 2.0 + bd * 0.5, bd + uw * 0.5, bd, uw),
        _rect_unit(uw * 2.0 + bd * 0.5, bd + uw * 1.5, bd, uw),
    ]


def _combo_5ho_a(uw, bd):
    return [
        _rect_unit(uw * 0.5, bd * 0.5, uw, bd),
        _rect_unit(uw * 1.5, bd * 0.5, uw, bd),
        _rect_unit(uw + bd * 0.5, bd + uw * 0.5, bd, uw),
        _rect_unit(uw + bd * 0.5, bd + uw * 1.5, bd, uw),
        _rect_unit(uw + bd * 0.5, bd + uw * 2.5, bd, uw),
    ]


def _combo_5ho_b(uw, bd):
    s = math.sqrt(2 * uw * bd)
    return [
        _rect_unit(uw * 0.5, bd * 0.5, uw, bd),
        _rect_unit(uw + bd * 0.5, bd + uw * 0.5, bd, uw),
        _rect_unit(uw + bd * 0.5, bd + uw * 1.5, bd, uw),
        _diamond_unit(uw + bd, 0, s),
    ]


def _combo_6ho(uw, bd):
    s = math.sqrt(2 * uw * bd)
    return [
        _rect_unit(uw * 0.5, bd * 0.5, uw, bd),
        _rect_unit(uw * 1.5, bd * 0.5, uw, bd),
        _rect_unit(uw * 2.0 + bd * 0.5, bd + uw * 0.5, bd, uw),
        _rect_unit(uw * 2.0 + bd * 0.5, bd + uw * 1.5, bd, uw),
        _diamond_unit(uw * 2.0 + bd, 0, s),
    ]


# 참조 이미지에 그려진 정확히 9종의 조합(2호/3호/4호×4종/5호×2종/6호) — 이 목록"만"이 배치
# 후보다(자유 각도·자유 유닛수 조합은 더 이상 만들지 않는다).
UNIT_COMBO_BUILDERS = {
    '2호': _combo_2ho,
    '3호': _combo_3ho,
    '4호-a': _combo_4ho_a,
    '4호-b': _combo_4ho_b,
    '4호-c': _combo_4ho_c,
    '4호-d': _combo_4ho_d,
    '5호-a': _combo_5ho_a,
    '5호-b': _combo_5ho_b,
    '6호': _combo_6ho,
}
UNIT_COMBO_KEYS = list(UNIT_COMBO_BUILDERS.keys())
UNIT_COMBO_UNIT_COUNTS = {k: len(v(1.0, 1.0)) for k, v in UNIT_COMBO_BUILDERS.items()}

# 사용자에게 보여줄 조합 이름 — 참조 이미지의 9개 도형에 매긴 호수+형상 표기를 그대로 쓴다
# (내부 comboKey의 -a/-b/-c/-d 접미사는 같은 호수 안의 변형을 구분하기 위한 내부용일 뿐,
# 화면에는 이 표기만 노출한다).
UNIT_COMBO_DISPLAY_NAMES = {
    '2호': '2호(판상형)', '3호': '3호(타워형)',
    '4호-a': '4호(L형)', '4호-b': '4호(타워형)', '4호-c': '4호(판상형)', '4호-d': '4호(ㄱ형)',
    '5호-a': '5호(L형)', '5호-b': '5호(타워형)',
    '6호': '6호(타워형)',
}


def build_combo_units(combo_key, cx, cy, base_rotation_deg, pack_params, unit_width=None):
    """UNIT_COMBO_BUILDERS[combo_key]가 만든 로컬 유닛 배치를 실제 unitWidth/bldgDepth로
    스케일하고, 조합 전체의 중심을 원점으로 맞춘 뒤 base_rotation_deg만큼 회전해 (cx,cy)로
    옮긴다. 유닛별로 world 좌표 꼭짓점(정사각형 또는 마름모)과 중심점을 반환한다 — 이 반환값이
    곧 "유닛별로 독립적인 컨테인먼트 판정·층수·라벨"의 최소 단위가 된다.

    unit_width를 명시적으로 넘기면(동에 배정된 세대타입의 공급면적 비례 폭,
    attach_per_type_unit_widths가 계산해둔 값) pack_params['unitWidth'](전체 평균 기준값)
    대신 그 값을 쓴다 — 이게 없으면 59㎡/84㎡ 등 타입을 섞어 넣어도 모든 동이 똑같은
    평균 크기로만 그려지는 문제가 있었다(실측 확인됨: 타입 라벨만 다르고 박스 크기는 항상
    동일)."""
    uw = unit_width if unit_width is not None else pack_params['unitWidth']
    bd = pack_params['bldgDepth']
    local_units = UNIT_COMBO_BUILDERS[combo_key](uw, bd)
    ox = sum(u['cx'] for u in local_units) / len(local_units)
    oy = sum(u['cy'] for u in local_units) / len(local_units)
    # 카탈로그 로컬 좌표는 유닛이 로컬 +X축으로 이어붙는 형태(장변이 로컬 X와 나란)라, base_rotation_deg를
    # 그대로 쓰면 장변(채광창 방향)이 stackDir(행 간 이격 축)에 나란해져 버린다 — 그러면 "같은 행에서
    # 옆으로 나란한" 동끼리 오히려 창을 마주보고(좁은 이격만 요구), "다른 행(앞뒤)" 동끼리는 창이
    # 옆을 봐 큰 이격이 스킵되는(실측 확인됨: south_score가 정확히 반대로 최고점을 주는 회전각을
    # 골랐음) 정반대 결과가 난다. +90도를 더해 장변을 widthDir(같은 행 안에서 옆으로 나란한 축)에
    # 맞추고 채광창을 stackDir(행-행 이격 축)에 맞춰야 _site_frame의 행/열 개념과 실제 창 방향이
    # 일치한다.
    rad = math.radians(base_rotation_deg + 90)
    cos_a, sin_a = math.cos(rad), math.sin(rad)

    def rot(x, y):
        return (x * cos_a - y * sin_a, x * sin_a + y * cos_a)

    world_units = []
    for u in local_units:
        wcx, wcy = rot(u['cx'] - ox, u['cy'] - oy)
        wcx, wcy = wcx + cx, wcy + cy
        if u['diamond']:
            r = u['s'] / math.sqrt(2)
            corners = [
                (wcx + math.cos(math.radians(a) + rad) * r, wcy + math.sin(math.radians(a) + rad) * r)
                for a in (0, 90, 180, 270)
            ]
            # 마름모는 4개 대각변이 모두 같은 길이라 "장변(채광창)" 방향이 모호하다 — 방향성
            # 판정 없이(None) 항상 최소 이격만 적용한다(evaluate_genome의 이격 판정 참고).
            window_normal = None
        else:
            hx, hy = u['sx'] / 2, u['sy'] / 2
            corners = []
            for lcx, lcy in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)):
                rcx, rcy = rot(lcx, lcy)
                corners.append((wcx + rcx, wcy + rcy))
            # 채광창은 유닛의 장변(긴 변)에 있고, 그 장변의 바깥쪽(조합 중심 반대쪽)을 향한다
            # — 실제 설계 관행과 일치(각 세대는 조합 몸체 바깥으로 창을 낸다). 장변이 로컬
            # x축과 평행하면(sx>=sy, "곧은 행" 유닛) 창은 ±y 방향, y축과 평행하면(꺾인 유닛)
            # ±x 방향 — 두 후보 중 조합 중심(ox,oy)에서 이 유닛 쪽을 향하는 쪽을 고른다.
            if u['sx'] >= u['sy']:
                n1, n2 = (0.0, 1.0), (0.0, -1.0)
            else:
                n1, n2 = (1.0, 0.0), (-1.0, 0.0)
            to_unit = (u['cx'] - ox, u['cy'] - oy)
            d1 = n1[0] * to_unit[0] + n1[1] * to_unit[1]
            d2 = n2[0] * to_unit[0] + n2[1] * to_unit[1]
            local_normal = n1 if d1 >= d2 else n2
            window_normal = rot(*local_normal)
        world_units.append({
            'corners': corners, 'centerM': (wcx, wcy), 'diamond': u['diamond'], 'hhPerFloor': u['hhPerFloor'],
            'windowNormal': window_normal
        })
    return world_units


def derive_max_buildings(land_area, pack_params):
    """대지면적 기반 동 개수 상한(여유 있게) — 유전자의 buildings 리스트 길이 상한.
    9종 카탈로그의 평균 유닛 수(약 4.1개) × 유닛당 개략 면적(unitWidth×bldgDepth) 기준으로
    잡는다 — 이 카탈로그는 동 하나당 최대 6유닛으로 컴팩트하므로 여유를 덜 둔다."""
    unit_width, bldg_depth = pack_params['unitWidth'], pack_params['bldgDepth']
    avg_units = sum(UNIT_COMBO_UNIT_COUNTS.values()) / len(UNIT_COMBO_UNIT_COUNTS)
    typical_footprint = avg_units * unit_width * bldg_depth * 0.6
    est = math.ceil(land_area / max(typical_footprint * 1.3, 1))
    return max(8, min(120, est))


def _compute_building_shapes(world_units, unit_floors, combo_key, envelope_for_height, pack_params):
    """동 하나의 유닛별 층수 컨테인먼트 판정 + 병합 외곽선/집계값 계산 — evaluate_genome의
    building_cache가 (comboKey, rotationDeg, x, y, unitFloors) 키로 캐시하는 단위(다른 동과
    무관하게 결정되는 부분만). 실패하면 None."""
    unit_shapes = []
    for wu, floors_u in zip(world_units, unit_floors):
        height_u = compute_assumed_height_m(floors_u, pack_params['h1Mm'], pack_params['h2Mm'], pack_params['h3Mm'], pack_params['htypMm'])
        env_shape_u, _ = envelope_for_height(height_u)
        if env_shape_u is None:
            return None
        shp_u = ShapelyPolygon(wu['corners'])
        if not shp_u.is_valid or shp_u.area <= 0 or not env_shape_u.contains(shp_u.buffer(-0.01, join_style='mitre')):
            return None
        unit_shapes.append({'shape': shp_u, 'floors': floors_u, 'height': height_u, 'centerM': wu['centerM'], 'hhPerFloor': wu['hhPerFloor'], 'windowNormal': wu['windowNormal'], 'corners': wu['corners']})

    # 회전각이 축에 딱 맞지 않는 경우(예: 37도), 서로 맞닿아야 할 유닛 경계가 부동소수점
    # 반올림으로 아주 미세하게(나노미터 단위) 벌어져 shapely가 하나로 안 붙고 여러 조각
    # (MultiPolygon)으로 쪼개는 경우가 있다 — 합집합 직전에만 아주 작은 양의 버퍼(1mm)를
    # 줘서 그 틈을 메운다(면적 오차는 유닛 하나당 0.1% 미만으로 무시할 수준). 라벨/세그먼트에
    # 쓰는 유닛 개별 폴리곤(us['shape'])은 원래 값 그대로 두고, 동 전체 외곽선(shp)에만 적용.
    shp = unary_union([us['shape'].buffer(0.001, join_style='mitre') for us in unit_shapes])
    if shp.geom_type == 'MultiPolygon' or not shp.is_valid or shp.area <= 0:
        # 끊어지거나 무효인 예외적 경우 — 세대수/건폐면적을 실제보다 적게 잡는 대신,
        # 이 동 하나만 이번 세대에서 버린다(다른 동엔 영향 없음).
        return None

    # n(호수 표기용 총 세대수/층)은 유닛 개수(len)가 아니라 유닛별 hhPerFloor 합이다 —
    # 마름모 유닛 하나가 층당 2세대를 차지하므로(예: 4호-b는 유닛이 3개뿐이지만 세대는 4호).
    n = sum(us['hhPerFloor'] for us in unit_shapes)
    height_b = max(us['height'] for us in unit_shapes)
    households_b = sum(us['floors'] * us['hhPerFloor'] for us in unit_shapes)
    min_floors_b = min(us['floors'] for us in unit_shapes)
    max_floors_b = max(us['floors'] for us in unit_shapes)
    shape_extra = {'comboKey': combo_key, 'unitShapes': unit_shapes}
    return (unit_shapes, shp, n, height_b, households_b, min_floors_b, max_floors_b, shape_extra)


# 동-동 이격(인동간격)은 "채광창이 있는 벽면"에서 그 벽면의 직각(법선) 방향으로만 높이
# 비례 최대치를 적용해야 한다. 각 유닛(build_combo_units가 계산한 windowNormal, 대각선
# 코너 유닛인 마름모는 None)마다 독립적으로 판정한다.
#
# 최초 구현은 유닛 중심점을 잇는 벡터가 법선과 45˚ 이내인지만 봤는데, 이는 실제 GA 결과에서
# 인동간격 위반이 발견되어(사용자가 실제 배치도에 빨간 표시로 직접 짚어 확인함) 부정확한
# 것으로 드러났다 — 지그재그로 어긋난(엇갈려 배치된) 두 동은 중심-중심 각도가 45˚를 넘어도,
# 벽면 자체의 폭(장변 길이)이 넓으면 그 벽면을 법선 방향으로 그대로 투영했을 때의 "그림자"가
# 여전히 상대 동과 겹칠 수 있다 — 각도만 보면 이런 경우를 "안 마주본다"고 잘못 판정해 이격을
# 과소 요구하게 된다. 실제 인동간격 심의도 각도가 아니라 "그 벽면 폭만큼의 사선/그림자가
# 상대 동에 걸치는가"로 판단한다.
#
# 그래서 유닛의 실제 꼭짓점(corners)을 써서, 법선(n)·접선(t=벽면이 늘어선 방향) 두 축에
# 사영한다: 상대 동의 어느 점이든 이 벽면보다 법선 방향으로 더 앞쪽에 있고(전면에 있음),
# 접선 방향 사영 범위가 이 벽면의 폭 범위와 겹치면(그림자가 실제로 걸침) "마주본다"고
# 판정한다 — 각도가 아니라 기하학적 투영 겹침이 기준이다.
#
# evaluate_genome(탐색 중 판정)과 validate_placement(최종 방어 재검증)가 같은 로직을 공유
# 하도록 모듈 최상위 함수로 둔다 — 예전에는 evaluate_genome 안에만 있어서, 최종 방어
# 재검증이 이걸 모르고 고정 최소 이격(6m)만 확인해 "탐색 중엔 걸러졌을 위반이 방어
# 재검증은 통과하는" 표기상 공백이 있었다.
def _wall_projection(normal, corners):
    tangent = (-normal[1], normal[0])
    cx = sum(c[0] for c in corners) / len(corners)
    cy = sum(c[1] for c in corners) / len(corners)
    n_vals = [(c[0] - cx) * normal[0] + (c[1] - cy) * normal[1] for c in corners]
    t_vals = [(c[0] - cx) * tangent[0] + (c[1] - cy) * tangent[1] for c in corners]
    return (cx, cy), tangent, max(n_vals), (min(t_vals), max(t_vals))


def _window_faces(normal, corners, other_corners, tangent_margin=1.0):
    if normal is None:
        return False
    (cx, cy), tangent, wall_n, (wall_t_lo, wall_t_hi) = _wall_projection(normal, corners)
    other_n = [(p[0] - cx) * normal[0] + (p[1] - cy) * normal[1] for p in other_corners]
    if max(other_n) <= wall_n:
        return False  # 상대 동이 이 벽면보다 앞쪽(바깥쪽)에 있지 않음
    other_t = [(p[0] - cx) * tangent[0] + (p[1] - cy) * tangent[1] for p in other_corners]
    return max(other_t) > wall_t_lo - tangent_margin and min(other_t) < wall_t_hi + tangent_margin


def _any_units_facing(units_a, units_b):
    """동 A·B의 유닛을 전수 대조해 어느 한쪽이든 채광창 벽면이 상대 동을 마주보는 유닛
    쌍이 있는지 판정한다(편측 판정으로 충분 — 건축법상 인동간격도 편측 벽면 기준).
    units_a/units_b는 각각 {'windowNormal', 'corners'}를 가진 유닛 목록(마름모처럼
    windowNormal이 None인 유닛은 항상 제외). _buildings_gap_ok(요구 이격 판정)와
    evaluate_genome의 마주보기 회피 점수 집계가 이 판정을 공유한다."""
    for us_a in units_a:
        na, ca = us_a['windowNormal'], us_a['corners']
        for us_b in units_b:
            nb, cb = us_b['windowNormal'], us_b['corners']
            if _window_faces(na, ca, cb) or _window_faces(nb, cb, ca):
                return True
    return False


def _buildings_gap_ok(units_a, height_a, shape_a, units_b, height_b, shape_b, gap_ratio):
    """동 A·B가 서로에 대해 요구되는 최소 이격을 만족하는지 판정한다 — 마주보면(_any_units_facing)
    두 동 중 더 높은 쪽 기준 height×gapRatio를, 아니면 최소 이격(IN_ROW_BUILDING_GAP)만 요구한다."""
    facing = _any_units_facing(units_a, units_b)
    required_gap = max(max(height_a, height_b) * (gap_ratio or 0.5), IN_ROW_BUILDING_GAP) if facing else IN_ROW_BUILDING_GAP
    return shape_a.distance(shape_b) >= required_gap - 0.05


def evaluate_genome(genome, poly_m_raw, edges_info, to_m, pack_params, legal_bcr_max, far_cap_target, site_stats,
                     envelope_cache=None, building_cache=None):
    """
    유전자 하나를 평가한다(구성적/repair-by-omission 방식): 동마다 자기 층수(b['floors'])로
    정해지는 높이 기준 채광이격을 재클리핑한 건축가능영역에 완전히 포함되고, 이미 채택된
    동들과 최소 이격(두 동 중 더 높은 쪽 기준 height×gapRatio)을 만족하는 동만 순서대로
    채택한다 — 대지 밖이거나 너무 가까운 동은 그 동 하나만 버리고 유전자 전체는 죽이지
    않는다(GA 패킹 문제의 표준 기법). 이 방식 자체가 "법규에 무조건 부합하는 안"만 결과에
    남긴다는 요구를 구조적으로 보장한다. 다만 채택된 동들의 합이 법정 건폐율/용적률 상한을
    넘으면 유전자 전체를 폐기(None)한다.

    이 동 안에서도 유닛마다 독립적인 층수·높이·채광이격 컨테인먼트 판정을 받는다(같은 동 안의
    유닛 하나라도 실패하면 물리적으로 붙어있는 매스라 "구멍"을 낼 수 없으므로 그 동 전체를
    버린다). 같은 높이를 쓰는 유닛이 여러 개면 중복 계산을 피하기 위해 반올림한 높이값 기준으로
    캐시한다. 동간 최소 이격은 동 단위로 확인한다(그 동에서 가장 높은 유닛 기준 — 보수적 근사).

    envelope_cache/building_cache는 run_ga_search가 세대·재시작에 걸쳐 공유하는 딕셔너리를
    넘길 수 있다(넘기지 않으면 이 호출 하나에서만 쓰고 버리는 로컬 캐시를 새로 만든다 —
    기존 단독 호출/테스트와 호환). envelope_cache는 높이→채광이격 재클리핑 영역(대지·조례
    고정, 세대 전체에서 동일)을, building_cache는 (comboKey, rotationDeg, x, y, unitFloors)
    조합 하나의 평가 결과(포함 여부, 병합 외곽선, 세대수 등 — 다른 동과 무관하게 결정됨)를
    캐시한다. 교차·돌연변이로 다음 세대가 만들어져도 대부분의 동은 부모와 완전히 같은 값으로
    그대로 넘어오므로(마주보는 다른 동만 이 캐시로는 알 수 없어 매번 다시 확인한다), 세대가
    지날수록 캐시 적중률이 크게 올라가 실측 성능 향상이 크다(대형 대지에서 세대당 평가 시간이
    지배적 병목이었음 — 실측 확인됨).
    """
    north_ratio = pack_params['northSetbackRatio']
    gap_ratio = pack_params['buildingGapRatio']  # 대지경계선/도로중심선 채광사선 전용(제86조③1호) — 동간 거리엔 쓰지 않는다
    apply_north_setback = pack_params.get('applyNorthSetback', True)
    max_floors_cap = pack_params.get('maxFloorsCap', 70)

    if envelope_cache is None:
        envelope_cache = {}

    def envelope_for_height(height):
        return _envelope_shape_for_height(height, poly_m_raw, edges_info, to_m, north_ratio, gap_ratio, envelope_cache,
                                           apply_north_setback=apply_north_setback)

    accepted_meta = []
    n_facing_pairs = 0
    n_total_pairs = 0
    for b in genome['buildings']:
        if not b.get('active', True):
            continue
        cx, cy = b['x'], b['y']

        # 9종 카탈로그 중 하나(comboKey)와, 그 조합에 속한 유닛 각각의 독립적인 층수
        # (unitFloors)가 이미 이 동의 유전자에 정해져 있다 — 같은 동 안에서도 유닛마다
        # 층수가 다를 수 있으므로(정북/인동 여건에 따라 낮은 유닛/높은 유닛이 섞인 실제
        # 설계 관행), 유닛마다 자신의 층수 기준 채광이격 재클리핑 영역에 개별적으로
        # 포함되는지 확인한다 — 유닛 하나라도 실패하면(물리적으로 붙어있는 하나의 매스라
        # "구멍"을 낼 수 없으므로) 이 동 전체를 이번 세대에서는 버린다(유전자 자체는 죽지
        # 않고, 이후 돌연변이가 그 유닛의 층수를 낮추면 다시 살아날 수 있다).
        combo_key = b.get('comboKey')
        if combo_key not in UNIT_COMBO_BUILDERS:
            allowed_fallback = pack_params.get('allowedComboKeys') or UNIT_COMBO_KEYS
            combo_key = allowed_fallback[0]
        # 동마다 제각각 방향을 고르지 않고 유전자 전체가 공유하는 rotationDeg를 그대로
        # 쓴다 — 실제 단지는 동마다 방향이 들쭉날쭉하지 않고 한 방향(주로 정남향)으로
        # 나란히 줄지어 배치되므로, "대지 전체의 한 방향"이 유일한 회전 자유도다.
        base_rot = genome['rotationDeg']
        # 이 동에 배정된 세대타입(unitTypeIdx)의 공급면적 비례 폭을 써야 59㎡/84㎡ 등 타입을
        # 섞어 넣었을 때 실제로 동 크기가 달라진다 — 이게 없으면 모든 동이 pack_params의 전체
        # 평균 폭 하나로만 그려져, 타입 라벨만 다르고 박스 크기는 항상 같은 문제가 있었다
        # (사용자 피드백: "59타입 84타입을 넣어봤을 때 크기가 같이 배치되는 문제").
        unit_type_idx = b.get('unitTypeIdx', 0)
        resolved_unit_width = _unit_width_for_type(pack_params, unit_type_idx)
        world_units = build_combo_units(combo_key, cx, cy, base_rot, pack_params, unit_width=resolved_unit_width)
        raw_floors = b.get('unitFloors') or [1]
        unit_floors = []
        for i in range(len(world_units)):
            src = raw_floors[i] if i < len(raw_floors) else (raw_floors[-1] if raw_floors else 1)
            unit_floors.append(max(1, min(max_floors_cap, round(num(src) or 1))))

        # 이 동 하나의 평가 결과(포함 판정·병합 외곽선·세대수 등)는 오직 (comboKey, 공유
        # rotationDeg, 위치, 유닛별 층수, 세대타입)에만 좌우되고 다른 동과는 무관하다 —
        # 교차·돌연변이로 다음 세대가 만들어져도 대부분의 동은 부모와 이 값들이 완전히 같은
        # 채로 넘어오므로, building_cache(run_ga_search가 세대·재시작에 걸쳐 공유)에 캐시해두면
        # 세대가 지날수록 이 동에서 가장 비싼 부분(유닛별 shapely 폴리곤·포함판정·병합)을 다시
        # 계산하지 않고 재사용할 수 있다(대형 대지에서 동 개수가 늘수록 이 재계산이 세대당
        # 시간을 지배해 예산 안에 몇 세대밖에 못 도는 문제의 근본 원인이었음 — 실측 확인됨).
        # 세대타입에 따라 폭이 달라지므로 unit_type_idx도 반드시 캐시 키에 포함해야 한다 —
        # 안 그러면 같은 위치·조합·층수라도 타입이 다른 동이 캐시를 잘못 재사용하게 된다.
        cache_key = None
        if building_cache is not None:
            cache_key = (combo_key, round(base_rot, 3), round(cx, 3), round(cy, 3), tuple(unit_floors), unit_type_idx)
        if cache_key is not None and cache_key in building_cache:
            cached_result = building_cache[cache_key]
        else:
            cached_result = _compute_building_shapes(world_units, unit_floors, combo_key, envelope_for_height, pack_params)
            if cache_key is not None:
                building_cache[cache_key] = cached_result
        if cached_result is None:
            continue
        unit_shapes, shp, n, height_b, households_b, min_floors_b, max_floors_b, shape_extra = cached_result

        # 이격 판정과 함께, 채택되면 이 동이 기존 채택 동들과 몇 쌍이나 "마주보는지"도 센다
        # (기존 채택된 동 수만큼 확정적으로 늘어나는 쌍 수 — 이 동이 결국 버려지면 아래에서
        # gap_ok가 False가 되어 이 집계 자체를 쓰지 않는다). 마주보기 자체는 이격만 지키면
        # 위법은 아니지만(요건을 만족하면 통과), 사용자가 보여준 실제 설계안은 합법 최소치를
        # 겨우 맞추는 게 아니라 애초에 서로 덜 마주보도록 배치를 짠다 — 이 능동적 선호를
        # sort_key의 tie 점수에 반영해(마주보기 회피 점수), 세대수가 같거나 비슷한 후보끼리
        # 경쟁할 때 GA가 더 사람이 설계한 것처럼 어긋난(엇갈린) 배치를 선호하게 한다.
        gap_ok = True
        facing_pairs_this = 0
        for m in accepted_meta:
            # 동-동 거리(인동간격, 제86조③2호가목)는 지역별 완화가 없다 — gap_ratio(대지경계선
            # 기준, 준주거 등에서 완화됨)가 아니라 고정 INTER_BUILDING_GAP_RATIO를 쓴다.
            if not _buildings_gap_ok(unit_shapes, height_b, shp, m['unitShapes'], m['height'], m['shape'], INTER_BUILDING_GAP_RATIO):
                gap_ok = False
                break
            if _any_units_facing(unit_shapes, m['unitShapes']):
                facing_pairs_this += 1
        if not gap_ok:
            continue
        n_total_pairs += len(accepted_meta)
        n_facing_pairs += facing_pairs_this

        accepted_meta.append({
            'N': n, 'minFloors': min_floors_b, 'maxFloors': max_floors_b, 'households': households_b,
            'height': height_b, 'shape': shp, 'centerLocal': (cx, cy), 'unitTypeIdx': unit_type_idx, **shape_extra
        })

    if not accepted_meta:
        return None

    households = sum(m['households'] for m in accepted_meta)
    far = households * pack_params['avgFarAreaPerHousehold'] / pack_params['landArea'] * 100
    footprint = sum(m['shape'].area for m in accepted_meta)
    bcr = footprint / pack_params['landArea'] * 100
    if bcr > legal_bcr_max + 0.01 or far > far_cap_target + 0.01:
        return None

    max_height = max(m['height'] for m in accepted_meta)
    _, worst_case_details = envelope_for_height(max_height)
    min_floors_val = min(m['minFloors'] for m in accepted_meta)
    max_floors_val = max(m['maxFloors'] for m in accepted_meta)

    south = south_score(genome['rotationDeg'])
    balance = balance_score(accepted_meta, site_stats)
    # 마주보기 회피 점수: 채택된 동들 사이 모든 쌍 중 실제로 "마주보는"(_any_units_facing) 쌍의
    # 비율이 낮을수록 1에 가깝다. 이격요건 자체는 마주보든 안 보든 만족하면 통과이므로(위법이
    # 아니므로) 이 점수는 하드 제약이 아니라 tie 점수의 한 축일 뿐이다 — 사용자가 보여준 실제
    # 설계안(Y자형 3면 타워 단지)처럼, 요건을 겨우 맞추는 배치보다 애초에 덜 마주보도록 어긋나게
    # 배치한 후보를 세대수가 같거나 비슷할 때 우선하도록 만든다.
    facing_avoidance = 1.0 - (n_facing_pairs / n_total_pairs) if n_total_pairs > 0 else 1.0
    # 인접 동끼리 층수가 들쭉날쭉하지 않고 비슷한 층들이 서로 가까운 위치에 모이도록 하는
    # 점수 — 사용자가 "동/유닛끼리 층수 차이가 너무 크다"고 지적해 추가했다. south/facing과
    # 비중을 나눠 가지므로(합 1.0 유지) south의 비중을 0.45→0.30으로 낮췄다 — 남향 배치는
    # 이미 방위 후보 시딩으로 어느 정도 확보되는 반면, 층수 평탄화는 이 점수 없이는 전혀
    # 압력이 없었다(순수 세대수/건폐면적만으로 경쟁하면 층수 분포는 완전히 무작위로 방치됨).
    floor_smooth = floor_neighbor_smoothness_score(accepted_meta, max_floors_cap)
    # 그리드 규칙성 점수 — 사용자가 "그리드 체계 안에서 규칙적으로 배치되는 것이 높은 점수를
    # 받아야 한다"고 명시적으로 요청해 추가했다. 기존 항목들의 비중을 골고루 낮춰(합 1.0 유지)
    # 새 항목에 자리를 만들었다.
    grid_regularity = grid_regularity_score(accepted_meta, genome['rotationDeg'], site_stats)
    tie = 0.20 * south + 0.10 * balance + 0.20 * facing_avoidance + 0.25 * floor_smooth + 0.25 * grid_regularity

    # 화면에서 조합을 하나 선택했으면(primaryComboKey), 경쟁 순위에 쓰는 점수(sort_key)에서
    # 그 조합이 아닌 세대는 NON_PRIMARY_COMBO_WEIGHT만큼만 인정한다 — 그냥 achievedHouseholds
    # (실제 달성 세대수, 화면 표시·용적률 판정에 쓰는 진짜 값)로만 순위를 매기면 GA가 "이
    # 대지에 더 조밀하게 들어가는 다른 조합"을 몇 세대 만에 전부 채택해버려 선택한 조합이
    # 완전히 사라질 수 있다(실측 확인됨) — "부족할 때만 섞는다"가 아니라 "더 나으면 통째로
    # 갈아치운다"가 되어버리는 문제. effective_score는 오직 진화 압력(선택·경쟁)에만 쓰이고,
    # achievedHouseholds/achievedFar 등 실제 보고값은 그대로 진짜 값을 쓴다.
    #
    # 사용자가 comboMode를 직접 고르지 않은 '자동' 모드에서도(primaryComboKey가 없어도)
    # 이 유전자 자신의 dominantComboKey를 기준으로 같은 압력을 준다 — 그렇지 않으면
    # _random_genome/_mutate_genome이 생성 단계에서 아무리 한 조합 위주로 새/재추첨
    # 건물을 만들어도, 교차(_crossover_genomes)가 서로 다른 dominantComboKey를 가진 두
    # 부모의 기존 건물들을 그대로 이어붙여 섞인 세대를 낳고, 그 세대가 세대수만 높으면
    # (조합 순도와 무관하게) 그대로 살아남아 여러 세대에 걸쳐 섞인 채로 남는다(실측
    # 확인됨: DOMINANT_COMBO_BIAS_AUTO=0.92를 줬는데도 지배 조합 비율이 0.57에 그침).
    primary_combo_key = pack_params.get('primaryComboKey') or genome.get('dominantComboKey')
    if primary_combo_key:
        primary_households = sum(m['households'] for m in accepted_meta if m.get('comboKey') == primary_combo_key)
        other_households = households - primary_households
        effective_score = primary_households + NON_PRIMARY_COMBO_WEIGHT * other_households
    else:
        effective_score = households

    sort_key = (effective_score, tie, max_floors_val, -footprint)

    return {
        'minFloors': min_floors_val, 'maxFloors': max_floors_val, 'rotationDeg': genome['rotationDeg'] % 180,
        'acceptedMeta': accepted_meta, 'unitsPerFloor': round(households / max_floors_val) if max_floors_val else 0,
        'achievedHouseholds': households, 'achievedFar': far, 'achievedBcr': bcr,
        'footprintAreaM2': footprint,
        'northSetback': (max(1.5, max_height * (north_ratio or 0.5)) if apply_north_setback else 0.0),
        'buildingGap': max_height * INTER_BUILDING_GAP_RATIO,
        'assumedHeightM': max_height, 'setbackDetails': worst_case_details,
        'southScore': south, 'balanceScore': balance, 'facingAvoidanceScore': facing_avoidance,
        'floorSmoothScore': floor_smooth, 'gridRegularityScore': grid_regularity, 'sortKey': sort_key
    }


# primary_combo_key(장르 하나를 강제 지정)가 주어졌을 때 combo_bias 확률로 그 조합으로
# 태어나게 하는 기본값 — 현재 화면(다중선택 체크박스 그리드)은 primaryComboKey를 보내지
# 않으므로(항상 None, allowedComboKeys만 보낸다) 이 상수는 run_ga_search가 pack_params에
# comboBias가 없을 때 쓰는 안전한 기본값으로만 남아 있다. 실제 배치 다양성 조절은
# DOMINANT_COMBO_BIAS_AUTO와 allowedComboKeys가 담당한다.
PRIMARY_COMBO_BIAS = 0.85

# evaluate_genome의 sort_key(경쟁 순위 전용 점수)에서, 이 유전자의 dominantComboKey가 아닌
# 조합으로 지어진 동의 세대수에 곱하는 가중치. 1.0이면 조합 순도를 전혀 신경 쓰지 않고
# 순수 세대수만으로 경쟁해 지배 조합이 통째로 밀려날 수 있다(실측 확인됨) — 0.5는 "다른
# 조합이 실제로 두 배 가까이 더 조밀하게 들어가야만 지배 조합을 밀어낼 가치가 있다"는
# 뜻으로, 대부분은 지배 조합 위주를 유지하되 진짜 필요할 때만(충분히 큰 이득이 있을
# 때만) 허용된 다른 조합으로 섞이도록 한다.
NON_PRIMARY_COMBO_WEIGHT = 0.5

# 유전자 하나(배치안 하나)는 사용자가 다중선택한 조합(allowedComboKeys) 중에서도 대체로
# 하나만 반복 사용해야 실제 설계 사례처럼 보인다 — 안산 초지동 604-4 실제 설계안(건축사
# 검토 PDF, 350%/400%/450% 세 안 공통)은 대지 하나에 정확히 한 종류의 점형 조합을 6개
# 동에 그대로 반복했을 뿐, 동마다 형태를 섞지 않았다. _random_genome이 유전자가 태어날
# 때 허용된 조합 중 그 유전자만의 "지배 조합"(dominantComboKey)을 하나 무작위로 정해 이
# 확률로 고수하게 한다 — 개체군 전체는 서로 다른 지배 조합을 동시에 시도하므로, 사용자가
# 여러 조합을 선택했다면 그중 실제로 가장 잘 들어맞는 조합(들)로 자연히 수렴한다.
DOMINANT_COMBO_BIAS_AUTO = 0.92

# 대지 가장자리(행렬의 첫/끝 행)에 배정되는 목표층수에 곱하는 최소 배율 — 1.0에 가까울수록
# 가장자리와 중앙의 층수가 같아지고, 낮을수록 계단식 스카이라인이 뚜렷해진다. 안산 초지동
# 604-4 실제 설계안에서 가장자리 동(24~26층)과 중앙 동(37층)의 비율이 약 0.65~0.70이었던
# 것을 참고하되, floor_neighbor_smoothness_score(인접 동 층수 유사도)와 과도하게 충돌하지
# 않도록 0.72로 다소 완만하게 잡는다.
EDGE_HEIGHT_MIN_RATIO = 0.72

# 가장자리 행에는 상대적으로 폭이 좁은(작은) 세대타입을, 중앙 행에는 넓은(큰) 세대타입을
# 배정하는 쪽으로 편향시킬 확률 — 604-4 설계안의 "가장자리 동은 59A 포함, 중앙 동은 84A
# 위주" 경향을 동 단위로 근사한다(한 동 안에서 날개별로 타입을 섞는 것까지는 반영하지
# 않는다 — 그러려면 9종 카탈로그 좌표 산식 전체를 유닛별 폭 가변으로 다시 짜야 해서
# 59/84 크기가 뒤섞이던 예전 버그를 다시 부를 위험이 크다). 나머지 확률은 기존처럼
# 공급비율 가중 무작위(탐색 다양성 유지).
EDGE_TYPE_BIAS = 0.6

# 교차(_crossover_genomes)로 다른 부모에게서 물려받은 동 중, 자식의 dominantComboKey와
# 다른 동을 그 자리에서 dominantComboKey로 다시 지을 확률 — 생성·변이 단계의 편향만으로는
# 교차가 매 세대 재유입시키는 "섞인 조합"을 충분히 빨리 씻어내지 못한다(실측 확인됨).
CROSSOVER_COMBO_CLEANUP = 0.7


def _pick_combo_key(rng, primary_combo_key, combo_bias, allowed_combo_keys):
    if primary_combo_key and rng.random() < combo_bias:
        return primary_combo_key
    return rng.choice(allowed_combo_keys)


def _pick_unit_type_idx(rng, unit_type_list, edge_factor=None):
    """세대타입 목록에서 count(공급 비율) 가중치로 인덱스 하나를 무작위로 고른다 — 이 동
    전체가 이 타입 하나로 지어진다. 실제 설계 관행상 한 동은 보통 하나의 평형(전용면적)으로
    통일되고, 59㎡/84㎡처럼 전혀 다른 크기가 한 동 안에서 유닛별로 뒤섞이지 않는다.

    edge_factor(0=대지 가장자리 행, 1=한가운데 행)를 주면 EDGE_TYPE_BIAS 확률로 그 위치에
    맞는 폭 순위의 타입을 고른다(가장자리엔 좁은 타입, 중앙엔 넓은 타입) — 604-4 실제
    설계안에서 확인된 "가장자리 동은 작은 타입 포함, 중앙 동은 큰 타입 위주" 경향을 생성
    단계부터 유도한다."""
    if not unit_type_list:
        return 0
    if edge_factor is not None and len(unit_type_list) > 1 and rng.random() < EDGE_TYPE_BIAS:
        order = sorted(range(len(unit_type_list)), key=lambda i: num(unit_type_list[i].get('unitWidth')) or 0)
        rank = round(edge_factor * (len(order) - 1))
        return order[rank]
    total = sum(num(t.get('count')) for t in unit_type_list) or 1
    r = rng.uniform(0, total)
    acc = 0.0
    for i, t in enumerate(unit_type_list):
        acc += num(t.get('count'))
        if r <= acc:
            return i
    return len(unit_type_list) - 1


def _unit_width_for_type(pack_params, unit_type_idx):
    """이 동에 배정된 세대타입(unitTypeIdx)의 공급면적 비례 폭(attach_per_type_unit_widths가
    미리 계산해둔 unitWidth)을 반환한다 — 타입 목록이 없거나 인덱스가 범위를 벗어나면 전체
    평균 기준값(pack_params['unitWidth'])으로 안전하게 대체한다."""
    types = pack_params.get('unitTypeList') or []
    if not types:
        return pack_params['unitWidth']
    idx = max(0, min(unit_type_idx, len(types) - 1))
    return num(types[idx].get('unitWidth')) or pack_params['unitWidth']


# ── 행(row) 기반 배치 좌표계 ─────────────────────────────────────────────
# 실제 공동주택 단지는 동마다 제각각 방향·위치가 아니라, 대지 전체가 한 방향(주로 정남향)을
# 보고 그 방향에 나란히 줄지어("행") 배치된다 — 자유 (x,y) 산점도로 배치하면 회전각이
# 동마다 따로 놀고 인접 동 사이 간격도 들쭉날쭉해 실제 설계안처럼 보이지 않는다는 문제가
# 있었다(실측/재검토 결과). 아래 헬퍼들은 유전자의 rotationDeg 하나로 대지 전체의 방향을
# 고정하고, 그 방향의 수직축(행 좌표)·평행축(열 좌표) 로컬 좌표계를 만들어 각 동의 위치를
# "몇 번째 행의 어느 지점"으로 다루게 한다 — 동의 실제 World(x,y)는 여전히 evaluate_genome이
# 이격·포함 여부를 그대로 판정하므로, 여기서는 GA가 "행에 정렬된 후보"를 더 잘 만들고
# 변이 후에도 그 정렬을 대체로 유지하게 하는 생성·변이 전용 좌표 변환일 뿐이다.
def _site_frame(rotation_deg, xs, ys):
    rad = math.radians(rotation_deg)
    stack_dir = (math.cos(rad), math.sin(rad))
    width_dir = (stack_dir[1], -stack_dir[0])
    center = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
    corners = [(x, y) for x in (min(xs), max(xs)) for y in (min(ys), max(ys))]
    row_vals = [(cx - center[0]) * stack_dir[0] + (cy - center[1]) * stack_dir[1] for cx, cy in corners]
    col_vals = [(cx - center[0]) * width_dir[0] + (cy - center[1]) * width_dir[1] for cx, cy in corners]
    return center, stack_dir, width_dir, (min(row_vals), max(row_vals)), (min(col_vals), max(col_vals))


def _row_col_to_xy(center, stack_dir, width_dir, row_val, col_val):
    return (center[0] + row_val * stack_dir[0] + col_val * width_dir[0],
            center[1] + row_val * stack_dir[1] + col_val * width_dir[1])


def _xy_to_row_col(center, stack_dir, width_dir, x, y):
    dx, dy = x - center[0], y - center[1]
    return (dx * stack_dir[0] + dy * stack_dir[1], dx * width_dir[0] + dy * width_dir[1])


def _envelope_shape_for_height(height, poly_m_raw, edges_info, to_m, north_ratio, gap_ratio, cache, apply_north_setback=True):
    """height별로 채광이격 재클리핑한 건축가능영역 shapely Polygon(무효/빈 경우 None)을 구해
    cache(반올림한 높이 키)에 저장해 재사용한다. evaluate_genome의 컨테인먼트 판정과
    _site_frame_for_floors(생성 단계의 행/열 범위 산정)가 같은 캐시를 공유해 재계산을 피한다."""
    key = round(height, 1)
    if key not in cache:
        env, details = clip_daylight_setback_edges(poly_m_raw, edges_info, to_m, height, north_ratio, gap_ratio,
                                                     apply_north_setback=apply_north_setback)
        shp = None
        if len(env) >= 3:
            candidate = ShapelyPolygon(env).buffer(0.01, join_style='mitre')
            if candidate.is_valid and candidate.area > 0:
                shp = candidate
        cache[key] = (shp, details)
    return cache[key]


def _site_frame_for_floors(rotation_deg, typical_floors, poly_m_raw, edges_info, to_m, pack_params, envelope_cache):
    """생성 단계(무작위 초기 개체군·돌연변이)의 행/열 좌표계 — 원본 대지 전체가 아니라
    typical_floors가 함의하는 높이만큼 채광이격을 재클리핑한 "실제 건축가능영역" 기준으로
    row/col 범위를 잡는다.

    원본 대지 기준으로 행/열을 잡으면(이전 동작) 고층을 겨냥하는 유전자일수록 실제로는 채광
    이격 때문에 갈 수 없는 대지 가장자리에까지 동을 배치 시도하게 된다 — 사용자가 확인해준 대로
    도로/인접대지/정북 전부에서 높이비례 이격이 실제로 적용되므로(성긴 우연이 아니라 올바른
    법규), 예를 들어 200x200m 대지에서 높이 145m(50층)면 대지의 92%가 건축 불가 영역이 된다.
    유닛 하나만 이 축소된 영역을 벗어나도 그 동 전체가 탈락하므로(같은 동은 물리적으로 붙어있어
    "구멍"을 낼 수 없음), 실측 확인 결과 typicalFloors가 20~30만 넘어가도 대부분의 동이 탈락하고
    안전 동(_safe_building) 1개만 남아 그 전략 자체를 탐색할 기회가 없었다. 여기서는 애초에
    "그 층수에서 실제로 갈 수 있는 영역"만 후보로 제안해, 고층 소수동 전략도 저층 다동 전략과
    동등하게 탐색되게 한다(실제 컨테인먼트 판정은 evaluate_genome이 유닛별 층수로 다시 하므로,
    여기서 근사가 다소 어긋나도 결과의 적법성 자체는 그대로 보장된다).

    그 높이에서 아예 남는 영역이 없으면(shp가 None/빈 폴리곤) 원본 대지로 폴백한다 — 이 경우
    n_rows가 1로 수렴해 안전 동 1개만 남는 것이 오히려 올바른 결과다(그 층수는 이 대지에서
    물리적으로 불가능하다는 뜻이므로)."""
    height = compute_assumed_height_m(
        typical_floors, pack_params.get('h1Mm'), pack_params.get('h2Mm'), pack_params.get('h3Mm'), pack_params.get('htypMm')
    )
    shp, _ = _envelope_shape_for_height(
        height, poly_m_raw, edges_info, to_m,
        pack_params['northSetbackRatio'], pack_params['buildingGapRatio'], envelope_cache,
        apply_north_setback=pack_params.get('applyNorthSetback', True)
    )
    ring = list(shp.exterior.coords) if (shp is not None and not shp.is_empty) else poly_m_raw
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return _site_frame(rotation_deg, xs, ys)


def _derive_row_lines(rng, row_range, pack_params, typical_floors, max_floors_cap):
    """row축 범위를 후보 행(row) 오프셋들로 나누고, 행마다 독립적으로 샘플링한 목표 층수를
    함께 반환한다: [(row_val, row_target_floors), ...]. 실제 이격요건은 evaluate_genome이
    유닛별 실제 층수로 다시 재검증하므로, 여기서는 "동이 나란히 줄지어 보이도록" 생성
    단계의 후보 위치·목표층수만 제안한다.

    이전 버전은 유전자 전체에 단 하나의 typical_floors로 균일한 행 간격(row_pitch)을 잡았다
    (row_pitch = max(bldg_depth + typical_height×gapRatio, bldg_depth×3), 행마다 동일).
    그런데 실제로 각 행에 배정되는 유닛들의 층수는 _sample_floors_near가 그때그때 ±편차를
    두고 뽑으므로, 유전자 평균(typical_floors)에서 벗어난 값이 나오면 그 동은 옆 행과의
    이격을 못 채워 탈락한다 — 실측 확인됨: typicalFloors=15인 유전자 하나에서 27개 배치
    시도 중 15개가 컨테인먼트 실패로 탈락(8개는 이격 실패, 4개만 성공). 여기서는 행마다
    자신의 목표 층수를 독립적으로 샘플링하고, 다음 행까지의 간격을 "두 행 중 더 높은 쪽
    기준"(evaluate_genome의 실제 판정 공식 _buildings_gap_ok와 동일하게
    max(h_prev,h_next)×gapRatio)으로 매번 새로 계산해 나간다(대지 경계 안에 들어갈 때까지
    아래에서 위로 순차 배치) — 그래야 그 행에 배정될 유닛들의 층수가 "그 행이 실제로 잡은
    간격"과 서로 어긋나지 않는다. 배치 후 전체를 row_range 중앙에 오도록 이동한다(기존
    균등배치가 항상 중앙 정렬이었던 것과 동등하게).

    반환하는 각 행에는 목표층수와 함께 edge_factor(0=대지 가장자리 행, 1=한가운데 행)도
    딸려 있다 — 604-4 실제 설계안(건축사 검토 PDF)처럼 가장자리 행은 낮게, 중앙 행은
    높게 짓는 계단식 스카이라인을 EDGE_HEIGHT_MIN_RATIO로 목표층수에 반영하고, 같은
    위치 신호를 세대타입 배정(_pick_unit_type_idx의 edge_factor)에도 공유한다."""
    lo, hi = row_range
    span = hi - lo
    bldg_depth = pack_params['bldgDepth']
    # 행간 거리(row pitch)는 동-동 거리(인동간격) 개념이라 INTER_BUILDING_GAP_RATIO(지역 불문
    # 고정 0.5)를 쓴다 — pack_params['buildingGapRatio']는 대지경계선 기준이라 여기 쓰면 안 된다.
    gap_ratio = INTER_BUILDING_GAP_RATIO
    if span <= 0:
        return [((lo + hi) / 2, typical_floors, 1.0)]

    def height_of(floors):
        return compute_assumed_height_m(
            floors, pack_params.get('h1Mm'), pack_params.get('h2Mm'), pack_params.get('h3Mm'), pack_params.get('htypMm')
        )

    targets = [_sample_floors_near(rng, typical_floors, max_floors_cap)]
    offsets = [0.0]
    while len(offsets) < 20:
        next_target = _sample_floors_near(rng, typical_floors, max_floors_cap)
        pitch = max(bldg_depth + max(height_of(targets[-1]), height_of(next_target)) * gap_ratio, bldg_depth * 3)
        next_offset = offsets[-1] + pitch
        if next_offset > span:
            break
        offsets.append(next_offset)
        targets.append(next_target)

    # 가장자리(0에 가까운/offsets[-1]에 가까운 오프셋)는 낮게, 중앙(오프셋 중간)은 높게 —
    # edge_factor는 0(가장자리)~1(한가운데)이고, 목표층수에 EDGE_HEIGHT_MIN_RATIO~1.0 배율로
    # 적용한다. 행이 1개뿐이면(span_built=0) 편향 없이 그대로 둔다.
    span_built = offsets[-1] if len(offsets) > 1 else 0.0
    edge_factors = [(1 - abs(2 * off / span_built - 1)) if span_built > 0 else 1.0 for off in offsets]
    targets = [
        max(1, min(max_floors_cap, round(t * (EDGE_HEIGHT_MIN_RATIO + (1 - EDGE_HEIGHT_MIN_RATIO) * ef))))
        for t, ef in zip(targets, edge_factors)
    ]

    shift = lo + (span - offsets[-1]) / 2
    return [(off + shift, t, ef) for off, t, ef in zip(offsets, targets, edge_factors)]


def _derive_col_lines(col_range, pack_params):
    """col축 범위를 균등한 간격의 후보 열(column) 위치들로 나눈다 — _derive_row_lines의 열
    버전. grid_regularity_score가 "여러 동이 같은 열을 공유하는" 배치에 점수를 주므로,
    생성·변이 단계에서부터 그런 배치를 실제로 더 잘 찾아내게 하는 장치다(점수만 있고 그런
    배치를 만들어낼 방법이 없으면 제한된 세대 수 안에서 우연히 발견되길 기다려야 한다).
    행과 달리 열 간격은 목표 층수에 좌우되지 않으므로(층수는 행-행 이격에만 영향), 조합
    하나의 개략 폭(9종 카탈로그 평균 유닛 수 기준) 피치로 균등 배치한다."""
    lo, hi = col_range
    span = hi - lo
    if span <= 0:
        return [(lo + hi) / 2]
    unit_width, bldg_depth = pack_params['unitWidth'], pack_params['bldgDepth']
    avg_units = sum(UNIT_COMBO_UNIT_COUNTS.values()) / len(UNIT_COMBO_UNIT_COUNTS)
    pitch = math.sqrt(avg_units) * max(unit_width, bldg_depth) * 1.3 + IN_ROW_BUILDING_GAP
    n_cols = max(1, min(20, round(span / pitch)))
    step = span / n_cols
    return [lo + step * (i + 0.5) for i in range(n_cols)]


def _random_building(rng, center, stack_dir, width_dir, row_lines, col_range, max_floors_cap, primary_combo_key, combo_bias, allowed_combo_keys, unit_type_list=None):
    combo_key = _pick_combo_key(rng, primary_combo_key, combo_bias, allowed_combo_keys)
    n_units = UNIT_COMBO_UNIT_COUNTS[combo_key]
    row_val, row_target_floors, edge_factor = rng.choice(row_lines)
    col_val = rng.uniform(*col_range)
    x, y = _row_col_to_xy(center, stack_dir, width_dir, row_val, col_val)
    return {
        'x': x, 'y': y, 'active': True,
        'comboKey': combo_key, 'unitFloors': [_sample_floors_near(rng, row_target_floors, max_floors_cap) for _ in range(n_units)],
        'unitTypeIdx': _pick_unit_type_idx(rng, unit_type_list or [], edge_factor)
    }


def _safe_building(center, allowed_combo_keys, unit_type_list=None):
    """항상 존재해야 하는 '안전' 동 — 대지 중심, 최저 층수(1층), 허용된 조합 중 유닛 수가
    가장 적은(=가장 작은) 조합으로 구성해 어떤 대지에서도 이격요건을 만족할 가능성을
    최대화한다(무작위 초기 개체군이 통째로 죽는 사태를 방지). 위치를 대지 중심으로 두는
    것만으로는 부족하다 — 그 동에 무작위로 배정된 층수·조합이 크면 중심에서도 이격요건을
    못 채울 수 있으므로, 크기 자체를 최소로 고정한다. 예전에는 항상 '2호'로 고정했는데,
    사용자가 조합을 다중선택할 때 2호를 선택 해제하면 이 안전장치가 사용자가 고르지
    않은 조합을 배치해버리는 문제가 있어, 반드시 allowed_combo_keys 안에서만 고른다.
    세대타입도 폭이 가장 좁은 타입을 골라 이격요건을 만족할 가능성을 조금이라도 더 높인다."""
    unit_type_idx = 0
    if unit_type_list:
        unit_type_idx = min(range(len(unit_type_list)), key=lambda i: num(unit_type_list[i].get('unitWidth')) or float('inf'))
    safe_key = min(allowed_combo_keys, key=lambda k: UNIT_COMBO_UNIT_COUNTS[k])
    return {
        'x': center[0], 'y': center[1], 'active': True,
        'comboKey': safe_key, 'unitFloors': [1] * UNIT_COMBO_UNIT_COUNTS[safe_key], 'unitTypeIdx': unit_type_idx
    }


def _approx_combo_span(combo_key, unit_width, bldg_depth):
    """조합 하나의 대략적인 콜(열) 방향 스팬 — 그리디 초기 배치에서 같은 행 안의 동끼리
    확실히 떨어뜨려 놓기 위한 근사치일 뿐, 정확한 폭은 evaluate_genome이 실제 회전된
    폴리곤으로 다시 검증한다(여기서 다소 넉넉히 잡아도 결과에 해가 되지 않는다)."""
    n_units = UNIT_COMBO_UNIT_COUNTS[combo_key]
    return math.sqrt(n_units) * max(unit_width, bldg_depth) * 1.3


def _sample_floors_near(rng, typical_floors, max_floors_cap):
    """typical_floors(대개 그 동/행이 목표로 하는 층수) 근방(표준편차 약 18%)에서 층수를
    뽑는다 — 행 간격(_derive_row_lines)이 이 목표층수 기준으로 잡히므로, 실제 배정 층수가
    여기서 크게 벗어나면 그 동은 옆 행과 이격요건을 못 채우기 쉽다. 예전에는 편차를 30%로
    뒀는데, _derive_row_lines가 행마다 목표층수를 독립 샘플링하도록 바뀐 뒤에도(그래서
    유전자 전체 평균이 아니라 그 행 자체의 목표와 비교되므로 예전보다는 여유가 생겼다)
    여전히 30%는 컨테인먼트 실패를 자주 유발해(실측 확인됨) 18%로 좁혔다 — 그래도
    "동 안에서도 유닛별로 층수가 갈리는" 탐색 자유도는 충분히 남는다."""
    val = rng.gauss(typical_floors, max(1.5, typical_floors * 0.18))
    return max(1, min(max_floors_cap, round(val)))


def _pack_row_greedy(rng, row_val, col_range, max_floors_cap, primary_combo_key, combo_bias, allowed_combo_keys, unit_width, bldg_depth, row_target_floors, max_new, unit_type_list, col_lines=None, edge_factor=None):
    """한 행(row_val)에 왼쪽부터 그리디로 조합을 채운다(실제 설계에서 한 행에 동이 나란히
    줄지어 들어차는 방식) — _random_building을 행마다 독립적으로 호출해 완전 자유배치하면
    같은 행 안에서 동끼리 무작위로 겹쳐 대부분 이격 위반으로 탈락하는 문제가 있었다(실측
    확인됨: 150x150 대지에서 동 1개만 살아남고 건폐율 3%대에 그침) — 그리디 패킹으로
    시작부터 서로 떨어뜨려 놓아야 초기 개체군이 다동 배치를 실제로 탐색할 수 있다.
    row_target_floors는 유전자 전체 평균이 아니라 이 행 자체의 목표층수(_derive_row_lines가
    행마다 독립 샘플링)다 — 그래야 이 행에 배정되는 유닛들의 층수가 이 행이 실제로 잡은
    간격과 맞아떨어진다.

    col_lines(_derive_col_lines가 만든 후보 열)를 주면 그 중 하나에서 살짝만 흔들어
    시작한다 — 매번 대지 시작점 근처에서 완전 무작위로 출발하면 행마다 시작 위치가
    제각각이라 같은 열에 여러 동이 맞춰 설 확률이 낮다(grid_regularity_score가 보상하는
    "여러 동이 같은 열을 공유하는" 배치를 생성 단계에서부터 더 잘 찾아내게 하는 장치)."""
    col_span = col_range[1] - col_range[0]
    if col_span <= 0:
        return []
    if col_lines:
        cursor = max(col_range[0], min(col_range[1] - 1, rng.choice(col_lines) + rng.gauss(0, col_span * 0.02)))
    else:
        cursor = col_range[0] + rng.uniform(0, col_span * 0.2)
    built = []
    guard = 0
    while cursor < col_range[1] and len(built) < max_new and guard < 30:
        guard += 1
        combo_key = _pick_combo_key(rng, primary_combo_key, combo_bias, allowed_combo_keys)
        span = _approx_combo_span(combo_key, unit_width, bldg_depth)
        if built and cursor + span > col_range[1]:
            break
        n_units = UNIT_COMBO_UNIT_COUNTS[combo_key]
        col_val = min(cursor + span / 2, col_range[1] - span / 2) if span < col_span else (col_range[0] + col_range[1]) / 2
        built.append({
            'colVal': col_val, 'comboKey': combo_key,
            'unitFloors': [_sample_floors_near(rng, row_target_floors, max_floors_cap) for _ in range(n_units)],
            'unitTypeIdx': _pick_unit_type_idx(rng, unit_type_list, edge_factor)
        })
        cursor += span + IN_ROW_BUILDING_GAP
    return built


def _random_genome(rng, poly_m_raw, edges_info, to_m, envelope_cache, max_floors_cap, max_buildings,
                    primary_combo_key, combo_bias, pack_params, orientation_degs=None):
    # 절반 정도는 도로 방향 후보(orientation_degs)에서 살짝 흔들어 뽑는다 — 완전 균등random보다
    # 남향 배치로 더 빨리 수렴하게 하는 가벼운 힌트일 뿐, 나머지 절반은 여전히 자유탐색이다.
    if orientation_degs and rng.random() < 0.5:
        rotation_deg = (rng.choice(orientation_degs) + rng.gauss(0, 3)) % 180
    else:
        rotation_deg = rng.uniform(0, 180)
    bldg_depth, unit_width = pack_params['bldgDepth'], pack_params['unitWidth']
    # typicalFloors: 이 유전자가 겨냥하는 대표 층수(행 간격 산정용) — 유전자마다 다르게 태어나게
    # 해서 "저층 다동" 전략과 "고층 소수동" 전략을 개체군이 동시에 시도하게 한다(_derive_row_lines
    # 참고). 3~max_floors_cap 전 구간에서 고르되, 로그 스케일로 뽑아 저층 쪽도 충분히 나오게 한다.
    typical_floors = max(3, round(math.exp(rng.uniform(math.log(3), math.log(max(3, max_floors_cap))))))
    # 사용자가 다중선택한 조합만 배치 후보다 — 미선택이면(방어적 기본값) 9종 전체.
    allowed_combo_keys = pack_params.get('allowedComboKeys') or UNIT_COMBO_KEYS
    # dominantComboKey: 이 유전자(배치안 하나)가 대체로 반복 사용할 조합 하나를 정한다 —
    # 허용된 조합 중에서 무작위로 하나 골라, 개체군 전체가 서로 다른 "한 조합 반복" 전략을
    # 동시에 탐색하게 한다(604-4 실제 설계안처럼 한 배치안 안에서는 형태가 섞이지 않는다).
    # 사용자가 조합을 딱 1개만 골랐으면 allowed_combo_keys가 원소 1개뿐이라 자동으로 그
    # 조합 하나로 고정된다 — 별도 분기가 필요 없다.
    dominant_combo_key = primary_combo_key or rng.choice(allowed_combo_keys)
    dominant_combo_bias = combo_bias if primary_combo_key else DOMINANT_COMBO_BIAS_AUTO
    center, stack_dir, width_dir, row_range, col_range = _site_frame_for_floors(
        rotation_deg, typical_floors, poly_m_raw, edges_info, to_m, pack_params, envelope_cache)
    row_lines = _derive_row_lines(rng, row_range, pack_params, typical_floors, max_floors_cap)
    rng.shuffle(row_lines)
    col_lines = _derive_col_lines(col_range, pack_params)

    unit_type_list = pack_params.get('unitTypeList') or []
    buildings = []
    for row_val, row_target, edge_factor in row_lines:
        if len(buildings) >= max_buildings:
            break
        for slot in _pack_row_greedy(rng, row_val, col_range, max_floors_cap, dominant_combo_key, dominant_combo_bias, allowed_combo_keys,
                                      unit_width, bldg_depth, row_target, max_buildings - len(buildings), unit_type_list, col_lines, edge_factor):
            x, y = _row_col_to_xy(center, stack_dir, width_dir, row_val, slot['colVal'])
            buildings.append({
                'x': x, 'y': y, 'active': True, 'comboKey': slot['comboKey'],
                'unitFloors': slot['unitFloors'], 'unitTypeIdx': slot['unitTypeIdx']
            })
    if buildings:
        # 첫 동은 통째로 "안전 동"으로 교체한다(위치만 옮기는 게 아니라 크기·층수까지 최소로) —
        # 무작위 초기 개체군이 전부 이격 위반으로 죽어 탐색이 아예 아무 배치도 못 찾는 사태를
        # 막는 안전장치.
        buildings[0] = _safe_building(center, allowed_combo_keys, unit_type_list)
    return {'rotationDeg': rotation_deg, 'typicalFloors': typical_floors, 'dominantComboKey': dominant_combo_key, 'buildings': buildings}


def _mutate_genome(parent, rng, poly_m_raw, edges_info, to_m, envelope_cache, max_floors_cap, max_buildings,
                    primary_combo_key, combo_bias, pack_params):
    new_rotation = (parent['rotationDeg'] + rng.gauss(0, 10)) % 180
    # typicalFloors(행 간격 산정용 대표 층수)도 서서히 변이시킨다 — "저층 다동 ↔ 고층 소수동"
    # 전략 사이를 GA가 계속 미세 조정하며 탐색하게 한다(_random_genome 참고).
    prev_typical = parent.get('typicalFloors') or max(3, round(max_floors_cap * 0.5))
    new_typical = max(3, min(max_floors_cap, round(prev_typical + rng.gauss(0, max(2, max_floors_cap * 0.1)))))
    # 사용자가 다중선택한 조합만 배치 후보다 — 미선택이면(방어적 기본값) 9종 전체.
    allowed_combo_keys = pack_params.get('allowedComboKeys') or UNIT_COMBO_KEYS
    # dominantComboKey는 부모에서 그대로 물려받는다(한 배치안이 세대를 거치며 형태를 계속
    # 바꾸면 "한 조합 반복" 원칙이 흔들린다) — 사용자가 comboMode를 직접 골랐으면 항상 그
    # 조합이 우선한다. 부모의 dominantComboKey가 현재 허용집합에 없으면(이론상 불가능하지만
    # 방어적으로) 허용집합에서 새로 고른다.
    parent_dominant = parent.get('dominantComboKey')
    if parent_dominant not in allowed_combo_keys:
        parent_dominant = None
    dominant_combo_key = primary_combo_key or parent_dominant or rng.choice(allowed_combo_keys)
    dominant_combo_bias = combo_bias if primary_combo_key else DOMINANT_COMBO_BIAS_AUTO
    center, stack_dir, width_dir, row_range, col_range = _site_frame_for_floors(
        new_rotation, new_typical, poly_m_raw, edges_info, to_m, pack_params, envelope_cache)
    row_lines = _derive_row_lines(rng, row_range, pack_params, new_typical, max_floors_cap)
    col_lines = _derive_col_lines(col_range, pack_params)
    col_jitter = (col_range[1] - col_range[0]) / 40 or 5
    g = {'rotationDeg': new_rotation, 'typicalFloors': new_typical, 'dominantComboKey': dominant_combo_key,
         'buildings': [dict(b) for b in parent['buildings']]}
    for b in g['buildings']:
        # 위치 변이는 world(x,y)를 직접 흔드는 대신 행/열 로컬 좌표로 바꿔서 다룬다 —
        # 대부분(88%)은 가장 가까운 행으로, 열도 대부분(82%)은 가장 가까운 열로 다시 스냅해,
        # rotationDeg가 세대를 거치며 조금씩 드리프트해도(위에서 매번 새로 계산) 전체 배치가
        # 여전히 나란한 행·열 그리드 구조를 유지하게 한다(실제 설계 관행이자 grid_regularity_
        # score가 보상하는 배치 — 604-4 실제 설계안처럼 반듯한 격자로 더 뚜렷하게 수렴하도록
        # 기존 80%/70%에서 상향했다). 나머지는 자유롭게 흔들어 새로운 행·열 간격도 계속
        # 탐색한다.
        row_val, col_val = _xy_to_row_col(center, stack_dir, width_dir, b['x'], b['y'])
        snapped_target = None
        snapped_edge = None
        if rng.random() < 0.88:
            snapped_row_val, snapped_target, snapped_edge = min(row_lines, key=lambda rt: abs(rt[0] - row_val))
            row_val = snapped_row_val + rng.gauss(0, col_jitter * 0.3)
        else:
            row_val += rng.gauss(0, col_jitter)
        if col_lines and rng.random() < 0.82:
            snapped_col_val = min(col_lines, key=lambda c: abs(c - col_val))
            col_val = snapped_col_val + rng.gauss(0, col_jitter * 0.3)
        else:
            col_val += rng.gauss(0, col_jitter)
        b['x'], b['y'] = _row_col_to_xy(center, stack_dir, width_dir, row_val, col_val)

        # 세대타입도 드물게(10%) 다른 타입으로 통째로 바꿔본다 — 이 동 전체가 한 타입으로
        # 통일된 채로만 변이하므로(현실적인 설계 관행), 이 동의 폭/크기가 그 타입에 맞게
        # 함께 바뀐다(evaluate_genome이 unitTypeIdx로 폭을 다시 계산). snapped_edge가 있으면
        # (이번에 행 스냅이 일어났으면) 그 위치 신호로 가장자리/중앙 타입 편향도 함께 준다.
        unit_type_list = pack_params.get('unitTypeList') or []
        if unit_type_list and rng.random() < 0.1:
            b['unitTypeIdx'] = _pick_unit_type_idx(rng, unit_type_list, snapped_edge)
        elif 'unitTypeIdx' not in b:
            b['unitTypeIdx'] = _pick_unit_type_idx(rng, unit_type_list, snapped_edge)

        cur_key = b.get('comboKey') if b.get('comboKey') in UNIT_COMBO_BUILDERS else allowed_combo_keys[0]
        cur_floors = list(b.get('unitFloors') or [1])
        if rng.random() < 0.15:
            # 조합을 통째로 다른 것으로 바꿔본다(2호↔4호-b 등 — 유닛 수가 바뀔 수 있으므로
            # 층수 리스트도 새로 구성한다). dominantComboKey 쪽으로 되돌아갈 확률이 높다
            # (_pick_combo_key).
            new_key = _pick_combo_key(rng, dominant_combo_key, dominant_combo_bias, allowed_combo_keys)
            n_units = UNIT_COMBO_UNIT_COUNTS[new_key]
            b['comboKey'] = new_key
            b['unitFloors'] = [rng.choice(cur_floors) if cur_floors else rng.randint(1, max_floors_cap) for _ in range(n_units)]
        else:
            n_units = UNIT_COMBO_UNIT_COUNTS[cur_key]
            while len(cur_floors) < n_units:
                cur_floors.append(cur_floors[-1] if cur_floors else 1)
            cur_floors = cur_floors[:n_units]

            if snapped_target is not None:
                # 이 동이 스냅된 행의 목표층수(row_target_floors) 쪽으로 매 세대 조금씩(25%)
                # 끌어당긴다 — 이게 없으면 위치는 행마다 다시 계산해 가지런히 스냅되는데
                # 층수는 태어날 때 값에 그대로 머문 채(생성 이후로는 행과 전혀 연동되지
                # 않았음) 돌연변이로만 갈라져서, 몇 세대만 지나도 "행은 가지런한데 층수는
                # 제각각"이 된다 — 사용자가 지적한 "동/유닛끼리 층수 차이가 너무 큼"의
                # 근본 원인이었다(실측 확인됨).
                cur_floors = [f + (snapped_target - f) * 0.25 for f in cur_floors]

            if rng.random() < 0.7:
                # 동 전체를 같은 방향·같은 폭으로 함께 흔든다 — 유닛별로 완전히 독립적인
                # 변이만 반복하면 세대를 거듭할수록 같은 동 안의 유닛끼리도 층수가 무작위로
                # 벌어진다(사용자 피드백: "유닛끼리 층수 차이가 너무 많이 남") — 동을 하나의
                # 덩어리로 오르내리게 해 내부 층수를 대체로 가깝게 유지한 채로도 저층↔고층
                # 탐색은 계속되게 한다.
                shared_delta = rng.choice([-3, -2, -1, 1, 2, 3])
                cur_floors = [f + shared_delta for f in cur_floors]
            else:
                # 드물게(30%) 유닛별 소폭(±1) 개별 변이도 남겨둔다 — 정북/인동 여건에 따라
                # 한 동 안에서도 살짝 갈리는 자연스러운 정도(예: 코너 유닛만 1층 낮음)는
                # 탐색 자유도로 유지한다.
                cur_floors = [f + (rng.choice([-1, 1]) if rng.random() < 0.3 else 0) for f in cur_floors]

            cur_floors = [max(1, min(max_floors_cap, round(f))) for f in cur_floors]
            b['comboKey'] = cur_key
            b['unitFloors'] = cur_floors
    if rng.random() < 0.15 and len(g['buildings']) < max_buildings:
        g['buildings'].append(_random_building(rng, center, stack_dir, width_dir, row_lines, col_range, max_floors_cap, dominant_combo_key, dominant_combo_bias, allowed_combo_keys, pack_params.get('unitTypeList')))
    if rng.random() < 0.15 and len(g['buildings']) > 2:
        g['buildings'].pop(rng.randrange(len(g['buildings'])))
    return g


def _clone_genome(g):
    """유전자를 완전히 독립된 사본으로 복제한다(buildings 리스트의 각 dict까지 얕은 복사) —
    엘리트 보존·재시작 간 시딩처럼 "이 유전자를 그대로 다음 세대/재시작의 초기 개체군에
    넣되, 원본과 얽히지 않게" 해야 하는 곳에서 쓴다. 얕은 복사로 충분한 이유: 각 building
    dict의 값(x, y, comboKey, unitFloors 리스트 등)은 이후 변이에서 항상 "새 리스트/새 dict를
    만들어 통째로 교체"하는 방식으로 갱신되지(제자리 수정하지) 않기 때문 — 기존
    _random_genome/_mutate_genome도 동일한 얕은 복사 관례를 쓴다."""
    return {
        'rotationDeg': g['rotationDeg'],
        'typicalFloors': g.get('typicalFloors'),
        'dominantComboKey': g.get('dominantComboKey'),
        'buildings': [dict(b) for b in g['buildings']]
    }


def _crossover_genomes(p1, p2, rng):
    b1, b2 = p1['buildings'], p2['buildings']
    if not b1 or not b2:
        buildings = [dict(b) for b in (b1 or b2)]
    else:
        cut1 = rng.randint(0, len(b1))
        cut2 = rng.randint(0, len(b2))
        buildings = [dict(b) for b in b1[:cut1]] + [dict(b) for b in b2[cut2:]]
    rotation = p1['rotationDeg'] + rng.random() * (p2['rotationDeg'] - p1['rotationDeg']) if rng.random() < 0.5 else (p1['rotationDeg'] if rng.random() < 0.5 else p2['rotationDeg'])
    typical_floors = p1.get('typicalFloors') if rng.random() < 0.5 else p2.get('typicalFloors')
    # dominantComboKey도 두 부모 중 하나를 그대로 물려받는다(두 부모의 조합을 섞으면 자식이
    # "한 조합 반복" 원칙 없이 태어나 버린다) — 어느 부모를 물려받을지는 rotation과 같은
    # 동전으로 결정해 서로 다른 유전자 필드가 제각각 다른 부모에서 오는 일반적인 교차 방식을
    # 따른다.
    dominant_combo_key = (p1.get('dominantComboKey') if rng.random() < 0.5 else p2.get('dominantComboKey')) \
        or p1.get('dominantComboKey') or p2.get('dominantComboKey')
    # 교차로 이어붙인 동 중 자식이 물려받은 dominantComboKey와 다른 것(다른 부모의 조합을
    # 그대로 물려받은 동)은 CROSSOVER_COMBO_CLEANUP 확률로 그 자리에서 dominantComboKey로
    # 다시 짓는다 — 이게 없으면 부모 둘의 지배 조합이 다를 때마다 교차가 매 세대 "섞인"
    # 자식을 계속 새로 만들어내고, evaluate_genome의 세대 압력(effective_score)만으로는
    # 수렴이 느려 여러 세대가 지나도 지배 조합 비율이 낮게 유지된다(실측 확인됨).
    if dominant_combo_key:
        for b in buildings:
            if b.get('comboKey') != dominant_combo_key and rng.random() < CROSSOVER_COMBO_CLEANUP:
                cur_floors = list(b.get('unitFloors') or [1])
                n_units = UNIT_COMBO_UNIT_COUNTS[dominant_combo_key]
                b['comboKey'] = dominant_combo_key
                b['unitFloors'] = [rng.choice(cur_floors) for _ in range(n_units)]
    return {'rotationDeg': rotation % 180, 'typicalFloors': typical_floors, 'dominantComboKey': dominant_combo_key, 'buildings': buildings}


def _unit_label_text(unit_type, floors_u):
    """유닛 하나짜리 라벨 — "타입\n층수" 두 줄만 표시한다. 동 수가 많은 대지에서는 한 줄짜리
    긴 라벨("59타입 24평 · 20층")이 서로 겹쳐 읽을 수 없었기 때문에(사용자 피드백), 공급면적
    평수는 빼고 두 줄로 나눠 라벨 폭을 절반 이하로 줄인다(평수는 상단 요약·면적표에 이미 있음).
    개행은 map.js가 white-space:pre-line으로 렌더링한다."""
    return f"{unit_type['name']}\n{floors_u}층"


def genome_result_to_rows(result, pack_params):
    """acceptedMeta(9종 카탈로그 조합)를 기존 rows 스키마로 직렬화한다. 유닛마다 층수가
    다를 수 있으므로 유닛 하나하나에 개별 라벨을 붙인다 — 동 전체에 라벨 하나가 아니라
    유닛 개수만큼 라벨이 생긴다."""
    types = pack_params['unitTypeList'] or [{'name': '유닛', 'supplyArea': 0, 'count': 1}]
    rows = []
    for m in result['acceptedMeta']:
        # 이 동 전체가 유전자에 배정된 세대타입 하나(unitTypeIdx)로 통일된다 — 예전에는 유닛마다
        # pick_next_unit_type을 새로 불러 같은 동 안에서도 59타입/84타입이 뒤섞여 라벨링될 수
        # 있었는데, 애초에 evaluate_genome이 그 동 전체를 이 타입 하나의 폭으로 그렸으므로
        # 라벨도 그와 일치하게 이 타입 하나만 써야 한다(사용자 피드백: "크기가 같이 배치되는
        # 문제").
        type_idx = max(0, min(m.get('unitTypeIdx', 0), len(types) - 1))
        unit_type = types[type_idx]
        segments = []
        buildingLabels = []
        for us in m['unitShapes']:
            path_m = list(us['shape'].exterior.coords)
            # windowNormal도 함께 넘긴다 — validate_placement의 최종 방어 재검증이 evaluate_genome과
            # 같은 인동간격(_buildings_gap_ok) 판정을 이 직렬화된 데이터만으로 재수행할 수 있어야
            # 하기 때문(그래야 두 검증이 항상 같은 기준으로 일치한다는 것이 실제로 보장된다).
            segments.append({'type': 'unit', 'pathM': path_m, 'windowNormal': us['windowNormal']})
            buildingLabels.append({'text': _unit_label_text(unit_type, us['floors']), 'positionM': us['centerM']})
        # pathM은 validate_placement의 최종 방어 재검증(shapely 컨테인먼트·이격 재확인)에
        # 그대로 쓰인다 — evaluate_genome이 이미 검증에 쓴 실제 유닛 합집합 외곽선(m['shape'])을
        # 그대로 넘겨야 두 검증이 같은 형태를 기준으로 일치한다(바운딩박스 등 근사치를 쓰면
        # 유효한 배치가 방어 재검증에서 거짓으로 탈락할 수 있다).
        outline = list(m['shape'].exterior.coords)
        xs_all = [c[0] for c in outline]
        combo_key = m.get('comboKey', '')
        rows.append({
            'width': round((max(xs_all) - min(xs_all)) * 10) / 10,
            'combo': UNIT_COMBO_DISPLAY_NAMES.get(combo_key, combo_key), 'buildingCount': 1, 'unitsThisRow': m['N'],
            'segments': segments, 'buildingLabels': buildingLabels, 'pathM': outline, 'height': m['height']
        })
    return rows


# 사용자가 "정밀 최적화는 1분 이상 걸려도 상관없다"고 명시함 — 결과 품질(최대 용적률)을
# 우선해 예산을 넉넉히 잡는다. optimize_massing은 이 예산으로 run_ga_search를 여러 번
# 재시작(GA_RESTARTS)해 그중 세대수가 가장 높은 배치를 채택한다(예산은 재시작 수만큼 나눠 쓴다).
# 복잡한 대지(동 수가 많아 유전자 평가 1회당 도형 연산 비용이 큰 경우)는 재시작 수만큼 예산이
# 쪼개지면 세대(generation)를 충분히 못 돌고 조기 종료될 수 있어, 기본값을 180초/재시작 2회로
# 올려 재시작당 최소 90초를 확보한다. gaWallClockS/gaRestarts로 화면에서 사용자가 직접 조정 가능.
POP_SIZE_FREE = 60
MIN_GENERATIONS = 30
PLATEAU_LIMIT = 15
MAX_GENERATIONS = 150
WALL_CLOCK_BUDGET_S = 180.0
MUTATION_RATE = 0.35
BIG_JUMP_RATE = 0.08

# 엘리트 보존 개수 — 세대 교체 시 상위 ELITE_COUNT개 유전자를 변형 없이 그대로 다음 세대로
# 옮긴다. 이게 없으면(예전 상태) 다음 세대가 토너먼트 선택→교차→변이만으로 통째로 새로
# 만들어져서, 이번 세대에서 찾은 최선의 유전자가 다음 세대에 우연히 하나도 안 뽑히거나
# 뽑혀도 변이로 망가지면 그대로 유전자 풀에서 사라진다(global_best로 결과는 여전히 보고되지만,
# 그 "좋은 배치 구조"를 후속 세대의 교차·변이 재료로 계속 활용하지 못해 탐색 효율이 떨어진다 —
# 표준적인 GA 개선 기법).
ELITE_COUNT = 2

def run_ga_search(poly_m, envelope_edges, to_m, pack_params, legal_bcr_max, far_cap_target,
                   land_area, max_floors_cap, rng,
                   pop_size_free, min_generations, plateau_limit, max_generations, wall_clock_budget_s,
                   envelope_cache=None, building_cache=None, progress_callback=None, seed_genome=None):
    """
    개체군 GA 탐색 본체 — optimize_massing이 재시작(restart)마다 독립적으로 호출한다. 동별
    자유 배치(위치·회전각·comboKey·유닛별 층수)를 유전자로 하는 개체군을 선택·교차·돌연변이로
    진화시켜, 법정 건폐율/용적률을 넘지 않으면서 세대수(→ 남향성 → 배치균형 → 층수 →
    건축면적 순 사전식 비교)가 최대인 배치를 찾는다. 도로 방향에서 뽑은 회전각 후보를 초기
    개체군 절반 정도에 힌트로 줘 남향 배치로 더 빨리 수렴하게 한다(구속하지는 않는다).

    seed_genome(선택)을 주면 초기 개체군 한 자리에 그 유전자를 그대로 심는다 — 재시작 간에
    이전 재시작의 최선 유전자를 다음 재시작의 시작점으로 물려줘(_run_ga_restarts 참고), 매
    재시작이 완전히 처음부터 다시 탐색하느라 예산을 낭비하지 않게 한다. 심어진 뒤로는 다른
    개체와 똑같이 경쟁하며(별도 보호 없음), 실제로 더 나으면 엘리트 보존(ELITE_COUNT)이
    자연스럽게 이후 세대에도 살아남긴다.

    progress_callback(선택)은 세대마다 한 번씩 {generation, maxGenerations, elapsed,
    wallClockBudget, bestHouseholds, bestFar}로 호출된다 — 화면에 진행률(경과시간·세대·
    지금까지 찾은 최선안)을 실시간으로 보여주기 위함이다. 마지막(종료 조건을 만족한) 세대도
    빠짐없이 보고하도록 break 검사 직전에 호출한다.
    """
    t0 = time.time()
    if envelope_cache is None:
        envelope_cache = {}
    xs = [p[0] for p in poly_m]
    ys = [p[1] for p in poly_m]
    site_stats = {
        'centroid': polygon_centroid_approx(poly_m),
        'halfW': (max(xs) - min(xs)) / 2, 'halfD': (max(ys) - min(ys)) / 2,
        'diag': math.hypot(max(xs) - min(xs), max(ys) - min(ys))
    }
    max_buildings = derive_max_buildings(land_area, pack_params)
    primary_combo_key = pack_params.get('primaryComboKey')
    combo_bias = pack_params.get('comboBias', PRIMARY_COMBO_BIAS)
    orientation_degs = [o['rotationDeg'] for o in derive_orientation_candidates(envelope_edges, to_m)]

    def evaluate(genome):
        return evaluate_genome(genome, poly_m, envelope_edges, to_m, pack_params, legal_bcr_max, far_cap_target, site_stats,
                                envelope_cache=envelope_cache, building_cache=building_cache)

    def new_random_genome():
        return _random_genome(rng, poly_m, envelope_edges, to_m, envelope_cache, max_floors_cap, max_buildings,
                               primary_combo_key, combo_bias, pack_params, orientation_degs)

    free_pool = [new_random_genome() for _ in range(pop_size_free)]
    if seed_genome is not None and free_pool:
        free_pool[0] = _clone_genome(seed_genome)

    global_best = None  # (result, genome)
    no_improve_streak = 0
    generation = 0

    while True:
        generation += 1
        evaluated = [(evaluate(g), g) for g in free_pool]
        evaluated = [(r, g) for r, g in evaluated if r is not None]
        evaluated.sort(key=lambda pair: pair[0]['sortKey'], reverse=True)

        improved = False
        if evaluated:
            top_res, top_genome = evaluated[0]
            if global_best is None or top_res['sortKey'] > global_best[0]['sortKey']:
                global_best = (top_res, top_genome)
                improved = True
        no_improve_streak = 0 if improved else no_improve_streak + 1

        # 조기수렴 방지: 자유 풀의 달성세대수 분산이 급락하면(탐색 초반 구간에 한해) 하위 일부를 재시딩
        if generation < min_generations + 4 and len(evaluated) >= 4:
            vals = [r['achievedHouseholds'] for r, g in evaluated]
            mean_v = sum(vals) / len(vals)
            std_v = (sum((v - mean_v) ** 2 for v in vals) / len(vals)) ** 0.5
            if mean_v > 0 and std_v / mean_v < 0.03:
                replace_n = max(4, len(free_pool) // 4)
                for idx in range(min(replace_n, len(free_pool))):
                    free_pool[idx] = new_random_genome()

        elapsed = time.time() - t0
        if progress_callback is not None:
            progress_callback({
                'generation': generation, 'maxGenerations': max_generations,
                'elapsed': elapsed, 'wallClockBudget': wall_clock_budget_s,
                'bestHouseholds': global_best[0]['achievedHouseholds'] if global_best else 0,
                'bestFar': global_best[0]['achievedFar'] if global_best else 0,
            })
        if generation >= max_generations or elapsed >= wall_clock_budget_s:
            break
        if generation >= min_generations and no_improve_streak >= plateau_limit:
            break

        # ── 다음 세대: 선택·교차·돌연변이로 전체 풀 교체 ──
        if len(evaluated) < 2:
            free_pool = [new_random_genome() for _ in range(pop_size_free)]
            continue

        def tournament():
            cands = rng.sample(evaluated, min(3, len(evaluated)))
            return max(cands, key=lambda pair: pair[0]['sortKey'])[1]

        # 엘리트 보존: 이번 세대 상위 ELITE_COUNT개는 변형 없이 그대로 다음 세대로 옮긴다
        # (deep copy — 이후 다른 개체의 변이·교차가 이 리스트를 실수로 공유해 건드리지 않도록).
        elite_n = min(ELITE_COUNT, pop_size_free, len(evaluated))
        new_free = [_clone_genome(g) for _, g in evaluated[:elite_n]]
        while len(new_free) < pop_size_free:
            child = _crossover_genomes(tournament(), tournament(), rng)
            if rng.random() < MUTATION_RATE:
                child = new_random_genome() if rng.random() < BIG_JUMP_RATE else _mutate_genome(
                    child, rng, poly_m, envelope_edges, to_m, envelope_cache, max_floors_cap, max_buildings,
                    primary_combo_key, combo_bias, pack_params)
            new_free.append(child)
        free_pool = new_free

    elapsed_ms = round((time.time() - t0) * 1000)
    return {
        'globalBest': global_best,
        'generationsRun': generation, 'populationSize': pop_size_free,
        'elapsedMs': elapsed_ms, 'siteStats': site_stats
    }


def _run_ga_restarts(poly_m, envelope_edges, to_m, pack_params, legal_bcr_max, far_cap_target,
                      land_area, max_floors_cap, seed_val, ga_restarts, wall_clock_budget_s,
                      envelope_cache=None, building_cache=None, progress_callback=None):
    """run_ga_search를 ga_restarts번 독립적으로 재시작해(예산은 재시작 수만큼 나눠 쓴다) 살아남은
    후보들을 모두 반환한다 — 재시작마다 초기 개체군이 달라 지역 최적해에 갇히는 것을 줄인다.
    optimize_massing이 이 함수를 comboBias를 바꿔가며(순수 조합 1회, 필요시 혼합 1회) 호출한다.
    envelope_cache/building_cache를 넘기면(순수/혼합 두 라운드·재시작 전체가 같은 대지·같은
    카탈로그를 쓰므로 공유해도 안전하다) 재시작마다, 라운드마다 매번 새로 계산하지 않고
    이미 본 동/높이 조합을 재사용한다. progress_callback이 있으면 run_ga_search가 보고하는
    세대별 정보에 restart/totalRestarts(몇 번째 재시작인지)를 덧붙여 그대로 전달한다.

    재시작 i의 최우수 유전자를 재시작 i+1의 초기 개체군에 시딩한다(S2, cross-restart
    seeding) — 완전히 새로운 무작위 개체군으로만 다시 시작하면 이전 재시작이 이미 찾은
    좋은 해가 버려지므로, 그 해를 다음 재시작의 출발점 중 하나로 이어받아 개선을 누적한다."""
    restart_min_gen = max(15, MIN_GENERATIONS // ga_restarts)
    restart_max_gen = max(restart_min_gen + PLATEAU_LIMIT, MAX_GENERATIONS // ga_restarts)
    restart_wall_clock = wall_clock_budget_s / ga_restarts

    candidates = []
    stats = []
    seed_genome = None
    for i in range(ga_restarts):
        rng = random.Random(seed_val + i) if seed_val is not None else random.Random()
        restart_progress_cb = None
        if progress_callback is not None:
            def restart_progress_cb(info, _i=i):
                progress_callback({**info, 'restart': _i + 1, 'totalRestarts': ga_restarts})
        search = run_ga_search(
            poly_m, envelope_edges, to_m, pack_params, legal_bcr_max, far_cap_target,
            land_area, max_floors_cap, rng,
            pop_size_free=POP_SIZE_FREE,
            min_generations=restart_min_gen if ga_restarts > 1 else MIN_GENERATIONS,
            plateau_limit=PLATEAU_LIMIT,
            max_generations=restart_max_gen if ga_restarts > 1 else MAX_GENERATIONS,
            wall_clock_budget_s=restart_wall_clock if ga_restarts > 1 else wall_clock_budget_s,
            envelope_cache=envelope_cache, building_cache=building_cache, progress_callback=restart_progress_cb,
            seed_genome=seed_genome
        )
        stats.append({
            'restart': i + 1, 'generationsRun': search['generationsRun'],
            'populationSize': search['populationSize'], 'elapsedMs': search['elapsedMs']
        })
        if search['globalBest'] is not None:
            ga_result, ga_genome = search['globalBest']
            seed_genome = ga_genome
            ga_rows = genome_result_to_rows(ga_result, pack_params)
            ga_validation = validate_placement(ga_rows, poly_m, gap_ratio=INTER_BUILDING_GAP_RATIO)
            if ga_validation['ok']:
                candidates.append({
                    'rows': ga_rows,
                    'minFloors': ga_result['minFloors'], 'maxFloors': ga_result['maxFloors'],
                    'rotationDeg': ga_result['rotationDeg'], 'achievedFar': ga_result['achievedFar'],
                    'achievedBcr': ga_result['achievedBcr'], 'achievedHouseholds': ga_result['achievedHouseholds'],
                    'footprintAreaM2': ga_result['footprintAreaM2'], 'northSetback': ga_result['northSetback'],
                    'buildingGap': ga_result['buildingGap'], 'assumedHeightM': ga_result['assumedHeightM'],
                    'setbackDetails': ga_result['setbackDetails'], 'unitsPerFloor': ga_result['unitsPerFloor'],
                    'southScore': ga_result['southScore'], 'balanceScore': ga_result['balanceScore'],
                    'facingAvoidanceScore': ga_result['facingAvoidanceScore'], 'floorSmoothScore': ga_result['floorSmoothScore'],
                    'gridRegularityScore': ga_result['gridRegularityScore'],
                    # evaluate_genome이 세대 내부 경쟁(선택압)에 쓰는 것과 같은 순수도 가중 점수 —
                    # achievedHouseholds(실제 값, 화면 표시용)와 별도로 보관해, 재시작·순수/혼합
                    # 라운드를 가로지르는 "어느 후보가 최종 채택되는가" 비교에도 똑같이 써야 한다
                    # (아래 optimize_massing 참고).
                    'effectiveScore': ga_result['sortKey'][0],
                    'validation': ga_validation
                })
    return candidates, stats


def optimize_massing(buildable_envelope_geojson, envelope_edges, request_params, progress_callback=None):
    """
    Step 5 오케스트레이터: 화면에서 사용자가 도형을 보고 다중선택한 조합들(comboModes,
    9종 카탈로그의 부분집합 — 예전 '자동' 옵션은 없고, 화면이 항상 1개 이상을 보낸다)만
    배치 후보로 삼아 run_ga_search를 실행한다. 허용된 조합이 여러 개여도 GA는 유전자마다
    그중 하나를 "지배 조합"으로 골라 대체로 반복 사용하고(_random_genome의
    dominantComboKey — 실제 설계 사례처럼 한 배치안 안에서는 형태가 섞이지 않는 경향을
    만든다), 개체군 전체는 서로 다른 지배 조합을 동시에 시도해 그중 세대수가 가장 높은
    쪽으로 자연히 수렴한다 — 그래서 여러 조합을 골라도 "허용된 조합 안에서 자유롭게
    섞어 실제로 배치해낸다"는 요구사항이 별도의 순수/혼합 2라운드 없이 한 번의 탐색으로
    충족된다. 결과 품질(최대 용적률)을 우선해 GA를 GA_RESTARTS번 독립적으로 재시작하고
    (예산은 재시작 수만큼 나눠 쓴다), 그중 세대수가 가장 높은 배치를 최종 채택한다 —
    재시작마다 초기 개체군이 달라 지역 최적해에 갇히는 것을 줄인다.

    progress_callback(선택)이 있으면 _run_ga_restarts가 보고하는 세대별 정보를 그대로 전달한다.
    """
    land_area = num(request_params.get('landArea'))
    if land_area <= 0:
        return {'error': 'landArea required', 'rows': [], 'maxRows': 0, 'noFit': True}

    lat0 = _avg_lat_of_geojson(buildable_envelope_geojson)
    to_m, to_ll = geo_utils.make_meter_converters(lat0)

    poly_m = geojson_to_meter_ring(buildable_envelope_geojson, to_m)
    if not poly_m or len(poly_m) < 3:
        return {'error': 'invalid envelope', 'rows': [], 'maxRows': 0, 'noFit': True}

    # comboModes: 화면에서 도형을 보고 다중선택한 조합 목록(9종 카탈로그의 부분집합).
    # 유효하지 않은 값은 걸러내고, 비어 있으면(구버전 호출부·요청 누락 등에 대한 방어적
    # 폴백일 뿐 — 화면은 항상 1개 이상을 보낸다) 9종 전체를 허용한다.
    requested_combo_modes = request_params.get('comboModes')
    if isinstance(requested_combo_modes, list):
        allowed_combo_keys = [k for k in requested_combo_modes if k in UNIT_COMBO_BUILDERS]
    else:
        allowed_combo_keys = []
    if not allowed_combo_keys:
        allowed_combo_keys = list(UNIT_COMBO_KEYS)
    combo_mode_label = (
        '/'.join(UNIT_COMBO_DISPLAY_NAMES.get(k, k) for k in allowed_combo_keys)
        if len(allowed_combo_keys) < len(UNIT_COMBO_KEYS) else '9종 조합 자유 혼합'
    )

    legal_bcr_max = num(request_params.get('legalBcrMax')) or 60
    legal_far_max = num(request_params.get('legalFarMax')) or 250
    relaxed_far_limit = num(request_params.get('relaxedFarLimit'))
    far_cap_target = relaxed_far_limit if relaxed_far_limit > 0 else legal_far_max
    avg_far_area_per_household = num(request_params.get('avgFarAreaPerHousehold')) or 110

    # 50층 초과는 사용자가 화면에서 "50층 초과 허용" 체크박스를 켰을 때만 탐색 범위에 포함한다
    # (프런트 체크박스는 UX 게이트일 뿐, 여기서 서버 쪽에서도 동일한 제한을 다시 강제한다).
    allow_over_50 = bool(request_params.get('allowOver50Floors'))
    requested_cap = int(num(request_params.get('maxFloorsCap')) or ABSOLUTE_MAX_FLOORS)
    max_floors_cap = min(requested_cap, ABSOLUTE_MAX_FLOORS)
    if not allow_over_50:
        max_floors_cap = min(max_floors_cap, 50)
    max_floors_cap = max(1, max_floors_cap)

    building_gap_ratio = request_params.get('buildingGapRatio')
    building_gap_ratio = num(building_gap_ratio) if building_gap_ratio not in (None, '') else 0.5

    # 정북일조(건축법 시행령 제86조①)는 전용주거·일반주거지역에만 있는 규정 — 그 외 지역(준주거 등)은
    # 대지 자체가 이 조항 미적용 대상이다(면제가 아니라 아예 적용 안 됨, 사용자 법조문 확인 2026-07-26).
    # zoneName이 안 넘어오면(구버전 호출부 등) 기존 동작대로 항상 적용한다.
    zone_name = request_params.get('zoneName')
    apply_north_setback = (zone_name in NORTH_SETBACK_APPLICABLE_ZONES) if zone_name else True

    base_unit_width = num(request_params.get('standardUnitWidth')) or 15
    # 세대타입별 공급면적 비례 폭을 미리 붙여서 넘긴다 — 84/59 등 타입이 섞여도 실제 크기 차이가
    # 유닛 박스 폭에 반영되도록(calculator.js와 동일 로직).
    unit_type_list_scaled = attach_per_type_unit_widths(request_params.get('unitTypeList') or [], base_unit_width)

    base_pack_params = {
        'bldgDepth': num(request_params.get('standardBuildingDepth')) or 10,
        'unitWidth': base_unit_width,
        'core': num(request_params.get('coreWidth')) or 10,
        # primaryComboKey는 이제 쓰지 않는다(다중선택은 "이 조합들 안에서만" 이라는 하드
        # 제약이지, "이 조합 하나를 우선하되 부족하면 그 밖도 허용"이라는 예전의 소프트
        # 편향과 다르다) — allowedComboKeys가 그 하드 제약이고, 그 안에서 어느 조합을
        # 우선할지는 유전자별 dominantComboKey가 자연 선택으로 결정한다.
        'primaryComboKey': None,
        'allowedComboKeys': allowed_combo_keys,
        'unitTypeList': unit_type_list_scaled,
        'h1Mm': request_params.get('floorHeight1Mm'), 'h2Mm': request_params.get('floorHeight2Mm'),
        'h3Mm': request_params.get('floorHeight3Mm'), 'htypMm': request_params.get('floorHeightTypicalMm'),
        'northSetbackRatio': num(request_params.get('northSetbackRatio')) or 0.5,
        'buildingGapRatio': building_gap_ratio,
        'applyNorthSetback': apply_north_setback,
        'avgFarAreaPerHousehold': avg_far_area_per_household,
        'landArea': land_area,
        'maxFloorsCap': max_floors_cap,
    }

    seed_val = int(num(request_params.get('gaSeed'))) or None
    ga_restarts = max(1, int(num(request_params.get('gaRestarts')) or 2))
    wall_clock_budget_s = num(request_params.get('gaWallClockS')) or WALL_CLOCK_BUDGET_S  # 테스트용 오버라이드

    t0_total = time.time()

    shared_envelope_cache = {}
    shared_building_cache = {}

    # allowedComboKeys(하드 제약)는 이미 base_pack_params에 들어 있고, 그 안에서 어느 조합을
    # 우선할지는 유전자별 dominantComboKey가 세대를 거치며 자연 선택으로 정하므로(V1, 위
    # docstring 참고) 예전처럼 "순수 라운드 → 부족하면 혼합 라운드"를 따로 나눌 필요가 없다
    # — comboBias는 항상 DOMINANT_COMBO_BIAS_AUTO(유전자 내부 순도 유지용)로 고정하고 한
    # 번만 탐색한다.
    search_pack_params = {**base_pack_params, 'comboBias': DOMINANT_COMBO_BIAS_AUTO}
    candidates, per_restart_stats = _run_ga_restarts(
        poly_m, envelope_edges, to_m, search_pack_params, legal_bcr_max, far_cap_target,
        land_area, max_floors_cap, seed_val, ga_restarts, wall_clock_budget_s,
        envelope_cache=shared_envelope_cache, building_cache=shared_building_cache, progress_callback=progress_callback
    )

    total_elapsed_ms = round((time.time() - t0_total) * 1000)
    search_stats = {
        'algorithm': 'genetic', 'restarts': ga_restarts,
        'restartsEvaluated': per_restart_stats,
        'generationsRun': max((s['generationsRun'] for s in per_restart_stats), default=0),
        'populationSize': per_restart_stats[0]['populationSize'] if per_restart_stats else 0,
        'elapsedMs': total_elapsed_ms
    }

    if not candidates:
        return {
            'rows': [], 'maxRows': 0, 'unitsPerFloor': 0, 'totalUnitsPerFloorAllRows': 0,
            'chosenFloors': 0, 'minFloors': 0, 'maxFloors': 0, 'rotationDeg': 0, 'achievedFar': 0, 'achievedBcr': 0, 'achievedHouseholds': 0,
            'farCapTarget': far_cap_target, 'farUtilizationRatio': 0,
            'buildingShape': combo_mode_label, 'noFit': True, 'searchStats': search_stats
        }

    # effectiveScore(순수도 가중 점수)로 정렬한다 — achievedHouseholds(원 세대수)로만 정렬하면
    # 혼합(2차) 라운드가 순수(1차) 라운드보다 세대수가 조금이라도 많은 순간 선택한 조합을
    # 완전히 밀어내는 결과가 나온다(각 라운드 내부의 세대 간 경쟁에서만 순수도 가중치가
    # 적용되고, 라운드/재시작을 가로지르는 이 최종 비교에서는 빠져 있던 게 원인 — "조합을
    # 선택했는데 선택하지 않은 조합이 결과에 나온다"는 문제의 실제 원인이었다).
    candidates.sort(key=lambda c: c['effectiveScore'], reverse=True)
    best = candidates[0]
    validation = best['validation']

    capped_at_50 = (not allow_over_50) and max_floors_cap <= 50 and best['maxFloors'] >= max_floors_cap

    # 변별 기준선·적용배수·요구 이격거리에, 실제 배치된 동까지의 최단거리(shapely)를 더해 보고한다.
    building_shapes_m = [ShapelyPolygon(r['pathM']) for r in best['rows'] if r.get('pathM') and len(r['pathM']) >= 3]
    setback_report = []
    for detail in best['setbackDetails']:
        edge = next((e for e in (envelope_edges or []) if e.get('index') == detail['edgeIndex']), None)
        actual_distance = None
        if edge and building_shapes_m:
            edge_line = LineString([to_m(*edge['p1']), to_m(*edge['p2'])])
            actual_distance = min(edge_line.distance(bshape) for bshape in building_shapes_m)
        setback_report.append({**detail, 'actualDistanceM': round(actual_distance, 2) if actual_distance is not None else None})

    if len(building_shapes_m) >= 2:
        min_gap = min(
            building_shapes_m[i].distance(building_shapes_m[j])
            for i in range(len(building_shapes_m)) for j in range(i + 1, len(building_shapes_m))
        )
        setback_report.append({
            'referenceLine': '동간 거리(인동간격)', 'ratio': INTER_BUILDING_GAP_RATIO,
            'requiredSetbackM': round(best['buildingGap'], 2), 'actualDistanceM': round(min_gap, 2)
        })

    rows_ll = []
    for row in best['rows']:
        rows_ll.append({
            'width': row['width'], 'combo': row['combo'], 'buildingCount': row['buildingCount'],
            'unitsThisRow': row['unitsThisRow'],
            'segments': [{'type': s['type'], 'pathLL': [list(to_ll(*pt)) for pt in s['pathM']]} for s in row['segments']],
            'buildingLabels': [{'text': bl['text'], 'positionLL': list(to_ll(*bl['positionM']))} for bl in row['buildingLabels']],
            'pathLL': [list(to_ll(*pt)) for pt in row['pathM']]
        })

    combo_counts = Counter(row['combo'] for row in best['rows'])
    if len(combo_counts) == 1:
        adopted_combo_label = next(iter(combo_counts))
    else:
        dominant, _ = combo_counts.most_common(1)[0]
        adopted_combo_label = f"{dominant} 위주 (혼합 {len(combo_counts)}종)"

    return {
        'rows': rows_ll,
        'maxRows': len(rows_ll),
        'unitsPerFloor': best['unitsPerFloor'],
        'totalUnitsPerFloorAllRows': best['unitsPerFloor'],
        'bldgDepth': base_pack_params['bldgDepth'], 'buildingGap': round(best['buildingGap'], 2), 'northSetback': round(best['northSetback'], 2),
        'assumedHeightM': round(best['assumedHeightM'], 2),
        'buildingShape': adopted_combo_label, 'frontSource': 'genetic',
        'frontLabel': f"유전 알고리즘 탐색 채택 (회전 {round(best['rotationDeg'])}도) [{adopted_combo_label}]",
        'chosenFloors': best['maxFloors'], 'minFloors': best['minFloors'], 'maxFloors': best['maxFloors'], 'rotationDeg': round(best['rotationDeg']),
        'achievedFar': round(best['achievedFar'], 2), 'achievedBcr': round(best['achievedBcr'], 2),
        'achievedHouseholds': best['achievedHouseholds'],
        'farCapTarget': round(far_cap_target, 2),
        'farUtilizationRatio': round(best['achievedFar'] / far_cap_target, 4) if far_cap_target > 0 else 0,
        'validated': validation['ok'], 'validationViolations': validation['violations'],
        'cappedAt50': capped_at_50,
        'setbackReport': setback_report,
        'searchStats': search_stats,
        'bestScoreBreakdown': {
            'achievedHouseholds': best['achievedHouseholds'],
            'southScore': round(best['southScore'], 3),
            'balanceScore': round(best['balanceScore'], 3),
            'facingAvoidanceScore': round(best['facingAvoidanceScore'], 3),
            'floorSmoothScore': round(best['floorSmoothScore'], 3),
            'gridRegularityScore': round(best['gridRegularityScore'], 3)
        }
    }
