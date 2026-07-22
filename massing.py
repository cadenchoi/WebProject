"""
massing.py
공동주택 주동(Mass) 자동 배치·최적화 알고리즘.

static/js/calculator.js의 개략 배치 시뮬레이션(estimatePolygonLayout 등)은 고정된 목표
세대수를 맞추는 데 필요한 층수를 한 번의 그리디 패킹으로 근사할 뿐, 회전각·위치·층수를
실제로 바꿔가며 법정 용적률 한도를 최대한 활용하는 탐색은 하지 않는다.

이 모듈은 그 위에 얹는 진짜 탐색 루프: 대지의 건축가능영역(도로/인접대지 이격 적용됨,
app.py의 /api/buildable-envelope 결과) 위에서 회전각 후보 여러 개 × 층수 1~상한 × (판상형의
경우) 밴드 시작 오프셋 몇 개를 전수 평가해, 법정 건폐율/용적률 상한을 넘지 않으면서
용적률을 가장 많이 활용하는 조합을 채택한다 — "이 대지에서 법적으로 지을 수 있는 최대
수용력"을 산출하는 것이 목표다 (입력된 목표 세대수는 참고하지 않는다).

호수 조합(2/3/4/5호)·주동 형상(판상형/L자형/타워형)은 화면에서 선택한 값을 고정 입력으로
쓰고, 회전각·오프셋·층수만 탐색한다 (1차 버전 스코프).
"""
import math
import time
from shapely.geometry import Polygon as ShapelyPolygon, LineString

import geo_utils

IN_ROW_BUILDING_GAP = 6  # 같은 행(밴드) 안 동 사이 최소 이격(단변/측벽 간, m) — calculator.js와 동일 상수
ABSOLUTE_MAX_FLOORS = 70  # 어떤 경우에도 넘지 않는 절대 안전 상한 (calculator.js의 기존 1~70층 클램프와 동일)


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


def polygon_width_x(poly):
    xs = [p[0] for p in poly]
    return max(xs) - min(xs)


def _x_range_at_y(poly, y):
    """폴리곤 경계가 수평선 y와 만나는 x 교점들의 [min,max] 범위."""
    xs = []
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 <= y <= y2) or (y2 <= y <= y1):
            if abs(y2 - y1) < 1e-9:
                xs.append(x1)
                xs.append(x2)
            else:
                t = (y - y1) / (y2 - y1)
                xs.append(x1 + t * (x2 - x1))
    return (min(xs), max(xs)) if xs else None


def band_safe_x_range(local_poly, y0, y1):
    """
    밴드[y0,y1] 구간에서 y0선과 y1선 모두를 가로지르는 x범위의 교집합을 반환한다.
    회전한(축과 어긋난) 폴리곤을 수평 밴드로 자르면 사다리꼴이 되는데, 이때
    폭을 단순 bounding-box(polygon_width_x)로 재면 밴드 중간 어딘가에서 폭이 더
    좁아지는 구간을 놓쳐 건물이 실제 대지 경계 밖으로 튀어나갈 수 있다 — 위/아래
    두 수평선에서의 x범위를 각각 구해 교집합(둘 다 만족하는 안전한 폭)만 사용해 방지.
    """
    r0 = _x_range_at_y(local_poly, y0)
    r1 = _x_range_at_y(local_poly, y1)
    if not r0 or not r1:
        return None
    lo, hi = max(r0[0], r1[0]), min(r0[1], r1[1])
    return (lo, hi) if hi > lo else None


def point_in_polygon(pt, poly):
    px, py = pt
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


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


def clip_daylight_setback_edges(poly_m, edges_info, to_m, assumed_height_m, north_setback_ratio, building_gap_ratio):
    """
    높이비례 채광 이격을 모든 변(도로 포함)에 적용한다(이 층수 기준으로 매번 새로 계산) — 이 검증을
    통과하지 못하는 (회전각, 층수) 조합은 optimize_massing에서 반드시 배제된다.
    (clipped_poly, setback_details) 튜플을 반환한다 — setback_details는 변별로 기준선·적용배수·
    요구 이격거리를 담아, 화면에서 "어느 기준선에서 몇 배(H×ratio)를 적용해 몇 m를 요구했는지"
    투명하게 보여줄 수 있게 한다.

    · 정북 방향(isNorth): 정북일조 비율(north_setback_ratio). 면제(northExempt, 북측이 비주거지역)
      조건이 있다 — 정북일조에만 있는 예외.
    · 그 외 인접대지경계선(동/서/남측): 인동간격/채광사선 비율(building_gap_ratio), 면제 없이 항상 적용.
    · 도로변: 공동주택 채광사선 규정상 도로 건너편에도 건물이 있을 수 있다고 보고, 대지경계선이 아닌
      "도로 중심선"을 기준점으로 인동간격 비율을 적용한다 — 도로 폭의 절반은 이미 이격거리로 인정되므로
      대지경계선에서 추가로 필요한 후퇴는 max(0, height*ratio - 도로폭/2)이다. 도로폭 실측값이 없으면
      보수적으로 크레딧을 주지 않는다(0으로 간주, 즉 전체 height*ratio를 대지경계선부터 그대로 요구).
      /api/buildable-envelope에서 이미 적용된 도로폭 기반 고정 후퇴(건축법 제46조)와는 별개로 추가된다.

    이전 버전은 정북 변만 재클리핑해서 나머지 변(동/서/남측·도로변)은 건물이 아무리 높아져도 이격이
    늘지 않는 버그가 있었다 — 구석에 극단적으로 높은 동 하나를 배치해 용적률을 채우는 비현실적인
    결과(예: 63층 단일동)가 "적합"으로 잘못 통과되는 원인이었다.
    """
    result = poly_m
    centroid = polygon_centroid_approx(poly_m)
    setback_details = []
    for edge in (edges_info or []):
        edge_type = edge.get('type')
        if edge_type not in ('adjacent', 'road'):
            continue
        is_north = edge.get('isNorth')

        if edge_type == 'adjacent' and is_north and edge.get('northExempt'):
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

def _peek_next_unit_type_index(unit_type_list, assigned_counts):
    total = sum(num(t.get('count')) for t in unit_type_list) or 1
    best_idx, best_score = 0, float('inf')
    for idx, t in enumerate(unit_type_list):
        ratio = num(t.get('count')) / total
        score = assigned_counts[idx] / ratio if ratio > 0 else float('inf')
        if score < best_score:
            best_score, best_idx = score, idx
    return best_idx


def peek_next_unit_type(unit_type_list, assigned_counts):
    """pick_next_unit_type과 동일한 선택이지만 assigned_counts를 바꾸지 않는다(폭 계산용 사전 조회)."""
    if not unit_type_list:
        return {'name': '유닛', 'supplyArea': 0}
    return unit_type_list[_peek_next_unit_type_index(unit_type_list, assigned_counts)]


def pick_next_unit_type(unit_type_list, assigned_counts):
    if not unit_type_list:
        return {'name': '유닛', 'supplyArea': 0}
    idx = _peek_next_unit_type_index(unit_type_list, assigned_counts)
    assigned_counts[idx] += 1
    return unit_type_list[idx]


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


def split_total_into_wings(n):
    """목표 총 세대수 N을 N1+N2=N(각 날개 최소 1세대)로 나누는 후보, 균형분할 우선."""
    candidates = [(n1, n - n1) for n1 in range(1, n)]
    candidates.sort(key=lambda p: abs(p[0] - p[1]))
    return candidates


def _make_local_frame(poly, stack_dir, width_dir):
    origin = polygon_centroid_approx(poly)

    def to_local(p):
        return (
            (p[0] - origin[0]) * width_dir[0] + (p[1] - origin[1]) * width_dir[1],
            (p[0] - origin[0]) * stack_dir[0] + (p[1] - origin[1]) * stack_dir[1],
        )

    def to_world(lx, ly):
        return (
            origin[0] + lx * width_dir[0] + ly * stack_dir[0],
            origin[1] + lx * width_dir[1] + ly * stack_dir[1],
        )

    def to_path_m(x0, x1, y0, y1):
        return [to_world(lx, ly) for (lx, ly) in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]]

    return to_local, to_world, to_path_m


def layout_in_direction(poly, stack_dir, width_dir, params, y_offset=0.0):
    """판상형: 밴드(행)로 슬라이싱해 각 행에 코어+N호 조합 동을 옆으로 채운다. layoutInDirection 포팅."""
    bldg_depth, building_gap = params['bldgDepth'], params['buildingGap']
    unit_width, core = params['unitWidth'], params['core']
    combos, unit_type_list = params['combos'], params['unitTypeList']

    to_local, to_world, to_path_m = _make_local_frame(poly, stack_dir, width_dir)
    local_poly = [to_local(p) for p in poly]
    ys = [p[1] for p in local_poly]
    min_y, max_y = min(ys), max(ys)

    types = unit_type_list if unit_type_list else [{'name': '유닛', 'supplyArea': 0, 'count': 1}]
    assigned_counts = [0] * len(types)

    rows = []
    y = min_y + y_offset
    guard = 0
    while y + bldg_depth <= max_y and guard < 200:
        guard += 1
        band = clip_polygon_by_halfplane(
            clip_polygon_by_halfplane(local_poly, (0, y), (0, 1)),
            (0, y + bldg_depth), (0, -1)
        )
        safe_range = band_safe_x_range(local_poly, y, y + bldg_depth) if len(band) >= 3 else None
        if safe_range:
            band_min_x, band_max_x = safe_range
            w = band_max_x - band_min_x
            # 동 하나는 세대타입 하나로 채워지므로(아래 pick_next_unit_type 1회/동), 폭 적합 여부를
            # 판단할 때부터 그 동에 배정될 타입의 공급면적 비례 폭을 미리 조회해서 써야 실제
            # 그려지는 폭과 어긋나지 않는다 — 맞는 조합을 찾는 즉시 타입 배정도 함께 확정한다.
            buildings = []
            used_width = 0.0
            while True:
                gap_needed = IN_ROW_BUILDING_GAP if buildings else 0
                remaining = w - used_width - gap_needed
                candidate_type = peek_next_unit_type(types, assigned_counts)
                type_width = num(candidate_type.get('unitWidth')) or unit_width
                picked = None
                for N in combos:
                    need = core + N * type_width
                    if need <= remaining:
                        picked = {'N': N, 'need': need}
                        break
                if not picked:
                    break
                picked['unitType'] = pick_next_unit_type(types, assigned_counts)  # 위에서 미리 본 타입과 동일
                buildings.append(picked)
                used_width += gap_needed + picked['need']
                if len(buildings) > 20:
                    break

            if buildings:
                bx = band_min_x + (w - used_width) / 2
                segments, building_labels = [], []
                units_this_row = 0
                footprint_area = 0.0

                for i, b in enumerate(buildings):
                    if i > 0:
                        bx += IN_ROW_BUILDING_GAP
                    unit_type = b['unitType']
                    unit_box_width = b['need'] / b['N']
                    cx = bx
                    for _u in range(b['N']):
                        segments.append({'type': 'unit', 'pathM': to_path_m(cx, cx + unit_box_width, y, y + bldg_depth)})
                        cx += unit_box_width
                    center_local = (bx + b['need'] / 2, y + bldg_depth / 2)
                    area_py = round(num(unit_type.get('supplyArea')) * 0.3025) if num(unit_type.get('supplyArea')) > 0 else None
                    building_labels.append({
                        'text': f"{unit_type['name']} {area_py}평" if area_py else unit_type['name'],
                        'positionM': to_world(*center_local)
                    })
                    bx += b['need']
                    units_this_row += b['N']
                    footprint_area += bldg_depth * b['need']

                outer_start = band_min_x + (w - used_width) / 2
                rows.append({
                    'width': round(w * 10) / 10,
                    'combo': '+'.join(str(b['N']) for b in buildings),
                    'buildingCount': len(buildings),
                    'unitsThisRow': units_this_row,
                    'segments': segments,
                    'buildingLabels': building_labels,
                    'pathM': to_path_m(outer_start, outer_start + used_width, y, y + bldg_depth),
                    'footprintAreaM2': footprint_area
                })
        y += bldg_depth + building_gap

    return {
        'rows': rows,
        'totalUnitsPerFloorAllRows': sum(r['unitsThisRow'] for r in rows),
        'footprintAreaM2': sum(r['footprintAreaM2'] for r in rows)
    }


def estimate_l_shape_layout(poly, stack_dir, width_dir, params):
    """L자형: 격자 앵커마다 목표 호수(총 세대수) N을 N1+N2로 분할해 맞는 첫 조합 채택. estimateLShapeLayout 포팅."""
    bldg_depth, building_gap = params['bldgDepth'], params['buildingGap']
    unit_width, core = params['unitWidth'], params['core']
    combos, unit_type_list = params['combos'], params['unitTypeList']

    to_local, to_world, to_path_m = _make_local_frame(poly, stack_dir, width_dir)
    local_poly = [to_local(p) for p in poly]
    xs, ys = [p[0] for p in local_poly], [p[1] for p in local_poly]
    min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)

    types = unit_type_list if unit_type_list else [{'name': '유닛', 'supplyArea': 0, 'count': 1}]
    assigned_counts = [0] * len(types)
    target_totals = sorted(combos, reverse=True)

    # 그리드 셀 크기(안전 여백)는 실제 배정될 수 있는 타입 중 가장 넓은 타입 기준으로 잡아야
    # 한다 — 타입별 폭이 평균(unit_width)보다 큰 타입이 배정될 경우에도 다음 앵커와 겹치지
    # 않도록 보수적으로 계산(공급면적 비례 폭 도입으로 폭이 균일하지 않게 됐기 때문).
    max_type_width = max((num(t.get('unitWidth')) or unit_width for t in types), default=unit_width)
    max_wing_units = max(1, max(target_totals) - 1)
    cell_size = core + max_wing_units * max_type_width + building_gap

    rows = []
    ay, guard_y = min_y, 0
    while ay + bldg_depth <= max_y and guard_y < 100:
        guard_y += 1
        ax, guard_x = min_x, 0
        while ax + bldg_depth <= max_x and guard_x < 100:
            guard_x += 1
            # 이 동 전체가 세대타입 하나로 채워지므로(아래 pick_next_unit_type 1회), 배정될 타입을
            # 미리 조회해 그 타입의 공급면적 비례 폭으로 l1/l2를 계산한다.
            candidate_type = peek_next_unit_type(types, assigned_counts)
            type_width = num(candidate_type.get('unitWidth')) or unit_width
            best = None
            for N in target_totals:
                for (n1, n2) in split_total_into_wings(N):
                    l1 = core + n1 * type_width
                    l2 = core + n2 * type_width
                    verts = [
                        (ax, ay), (ax + l1, ay), (ax + l1, ay + bldg_depth),
                        (ax + bldg_depth, ay + bldg_depth), (ax + bldg_depth, ay + l2), (ax, ay + l2)
                    ]
                    if all(point_in_polygon(v, local_poly) for v in verts):
                        best = {'N': N, 'n1': n1, 'n2': n2, 'l1': l1, 'l2': l2}
                        break
                if best:
                    break

            if best:
                N, n1, n2, l1, l2 = best['N'], best['n1'], best['n2'], best['l1'], best['l2']
                unit_type = pick_next_unit_type(types, assigned_counts)  # 위에서 미리 본 타입과 동일
                segments = []
                box_a = l1 / n1
                for u in range(n1):
                    segments.append({'type': 'unit', 'pathM': to_path_m(ax + u * box_a, ax + (u + 1) * box_a, ay, ay + bldg_depth)})
                box_b = (l2 - bldg_depth) / n2
                for u in range(n2):
                    segments.append({'type': 'unit', 'pathM': to_path_m(ax, ax + bldg_depth, ay + bldg_depth + u * box_b, ay + bldg_depth + (u + 1) * box_b)})

                area_py = round(num(unit_type.get('supplyArea')) * 0.3025) if num(unit_type.get('supplyArea')) > 0 else None
                label_txt = f"{unit_type['name']} {area_py}평 (L자 {N}호)" if area_py else f"{unit_type['name']} (L자 {N}호)"
                rows.append({
                    'width': round(max(l1, l2) * 10) / 10,
                    'combo': f'L{N}({n1}+{n2})',
                    'buildingCount': 1,
                    'unitsThisRow': n1 + n2,
                    'segments': segments,
                    'buildingLabels': [{'text': label_txt, 'positionM': to_world(ax + l1 / 2, ay + bldg_depth / 2)}],
                    'pathM': to_path_m(ax, ax + max(l1, bldg_depth), ay, ay + max(l2, bldg_depth)),
                    'footprintAreaM2': bldg_depth * (l1 + l2 - bldg_depth)
                })
            ax += cell_size
        ay += cell_size

    return {
        'rows': rows,
        'totalUnitsPerFloorAllRows': sum(r['unitsThisRow'] for r in rows),
        'footprintAreaM2': sum(r['footprintAreaM2'] for r in rows)
    }


def estimate_tower_layout(poly, stack_dir, width_dir, params):
    """타워형: 코어 1개 + 앞줄(ceil(N/2))·뒷줄(floor(N/2)) 두 줄. estimateTowerLayout 포팅."""
    bldg_depth, building_gap = params['bldgDepth'], params['buildingGap']
    unit_width, core = params['unitWidth'], params['core']
    combos, unit_type_list = params['combos'], params['unitTypeList']

    to_local, to_world, to_path_m = _make_local_frame(poly, stack_dir, width_dir)
    local_poly = [to_local(p) for p in poly]
    xs, ys = [p[0] for p in local_poly], [p[1] for p in local_poly]
    min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)

    types = unit_type_list if unit_type_list else [{'name': '유닛', 'supplyArea': 0, 'count': 1}]
    assigned_counts = [0] * len(types)
    target_totals = sorted(combos, reverse=True)

    # L자형과 동일한 이유로, 그리드 안전 여백은 가장 넓은 타입 기준으로 잡는다.
    max_type_width = max((num(t.get('unitWidth')) or unit_width for t in types), default=unit_width)
    max_front_units = math.ceil(max(target_totals) / 2)
    tower_width_max = core + max_front_units * max_type_width
    tower_depth = 2 * bldg_depth
    step_x = tower_width_max + building_gap
    step_y = tower_depth + building_gap

    rows = []
    cy, guard_y = min_y, 0
    while cy + tower_depth <= max_y and guard_y < 200:
        guard_y += 1
        cx, guard_x = min_x, 0
        while cx + tower_width_max <= max_x and guard_x < 200:
            guard_x += 1
            # 이 타워 전체가 세대타입 하나로 채워지므로(아래 pick_next_unit_type 1회), 배정될 타입을
            # 미리 조회해 그 타입의 공급면적 비례 폭으로 tower_width를 계산한다.
            candidate_type = peek_next_unit_type(types, assigned_counts)
            type_width = num(candidate_type.get('unitWidth')) or unit_width
            best = None
            for N in target_totals:
                front, back = math.ceil(N / 2), N // 2
                tower_width = core + max(front, back) * type_width
                corners = [(cx, cy), (cx + tower_width, cy), (cx + tower_width, cy + tower_depth), (cx, cy + tower_depth)]
                if all(point_in_polygon(c, local_poly) for c in corners):
                    best = {'N': N, 'front': front, 'back': back, 'towerWidth': tower_width}
                    break

            if best:
                N, front, back, tower_width = best['N'], best['front'], best['back'], best['towerWidth']
                unit_type = pick_next_unit_type(types, assigned_counts)  # 위에서 미리 본 타입과 동일
                segments = []
                box_front = tower_width / front
                for u in range(front):
                    segments.append({'type': 'unit', 'pathM': to_path_m(cx + u * box_front, cx + (u + 1) * box_front, cy + bldg_depth, cy + tower_depth)})
                if back > 0:
                    box_back = tower_width / back
                    for u in range(back):
                        segments.append({'type': 'unit', 'pathM': to_path_m(cx + u * box_back, cx + (u + 1) * box_back, cy, cy + bldg_depth)})

                area_py = round(num(unit_type.get('supplyArea')) * 0.3025) if num(unit_type.get('supplyArea')) > 0 else None
                label_txt = f"{unit_type['name']} {area_py}평 (타워 {N}호)" if area_py else f"{unit_type['name']} (타워 {N}호)"
                rows.append({
                    'width': round(tower_width * 10) / 10,
                    'combo': f'{N}(타워{front}+{back})',
                    'buildingCount': 1,
                    'unitsThisRow': N,
                    'segments': segments,
                    'buildingLabels': [{'text': label_txt, 'positionM': to_world(cx + tower_width / 2, cy + tower_depth / 2)}],
                    'pathM': to_path_m(cx, cx + tower_width, cy, cy + tower_depth),
                    'footprintAreaM2': tower_width * tower_depth
                })
            cx += step_x
        cy += step_y

    return {
        'rows': rows,
        'totalUnitsPerFloorAllRows': sum(r['unitsThisRow'] for r in rows),
        'footprintAreaM2': sum(r['footprintAreaM2'] for r in rows)
    }


_PACK_FUNCS = {'판상형': layout_in_direction, 'L자형': estimate_l_shape_layout, '타워형': estimate_tower_layout}


def validate_placement(rows, envelope_pts, min_gap=IN_ROW_BUILDING_GAP):
    """방어적 재검증: 팩킹 로직이 이미 행/날개별 간격을 구조적으로 보장하므로,
    여기서는 건축가능영역 포함 여부와 건물 간 최소 이격만 shapely로 다시 확인한다."""
    if len(envelope_pts) < 3:
        return {'ok': False, 'violations': ['invalid-envelope']}
    envelope_shape = ShapelyPolygon(envelope_pts).buffer(0.01)
    building_shapes = [ShapelyPolygon(r['pathM']) for r in rows if r.get('pathM') and len(r['pathM']) >= 3]

    violations = []
    for shp in building_shapes:
        if not shp.is_valid or shp.area <= 0:
            continue
        if not envelope_shape.contains(shp.buffer(-0.01)):
            violations.append('envelope-containment')
            break
    for i in range(len(building_shapes)):
        for j in range(i + 1, len(building_shapes)):
            d = building_shapes[i].distance(building_shapes[j])
            if 0 < d < min_gap - 0.05:
                violations.append(f'gap-{i}-{j}:{round(d, 2)}m')
    return {'ok': len(violations) == 0, 'violations': violations}


# ─────────────────────────────────────────────────────────────
# Step 4~5: 층수 후보별 평가 + 전수 탐색 오케스트레이터
# ─────────────────────────────────────────────────────────────

def evaluate_floor_candidate(road_clipped_poly_m, edges_info, to_m, floors, orientation, params):
    """
    한 (회전각, 층수) 조합의 평가: height -> northSetback/buildingGap 재계산 -> 이 층수 기준
    모든 인접대지경계선(도로 제외) 재클리핑 -> 패킹 -> achievedFar/Bcr/Households 산출.
    판상형은 밴드 시작 오프셋 3개(0, 1/3, 2/3 지점)도 함께 시도해 그 중 최선을 반환한다.
    """
    height = compute_assumed_height_m(floors, params['h1Mm'], params['h2Mm'], params['h3Mm'], params['htypMm'])
    north_setback_ratio = params['northSetbackRatio']
    building_gap_ratio = params['buildingGapRatio']
    building_gap = height * (building_gap_ratio or 0.5)
    north_setback = max(1.5, height * (north_setback_ratio or 0.5))

    envelope_this_floor, setback_details = clip_daylight_setback_edges(
        road_clipped_poly_m, edges_info, to_m, height, north_setback_ratio, building_gap_ratio
    )
    if len(envelope_this_floor) < 3:
        return None

    pack_params = dict(params)
    pack_params['buildingGap'] = building_gap

    shape_mode = params['buildingShapeMode']
    pack_fn = _PACK_FUNCS.get(shape_mode, layout_in_direction)
    stack_dir, width_dir = orientation['stackDir'], orientation['widthDir']

    if shape_mode == '판상형':
        offset_base = pack_params['bldgDepth'] + building_gap
        offsets = [0.0, offset_base / 3, 2 * offset_base / 3]
    else:
        offsets = [0.0]

    best = None
    for off in offsets:
        if shape_mode == '판상형':
            result = pack_fn(envelope_this_floor, stack_dir, width_dir, pack_params, y_offset=off)
        else:
            result = pack_fn(envelope_this_floor, stack_dir, width_dir, pack_params)

        units_per_floor = result['totalUnitsPerFloorAllRows']
        if units_per_floor <= 0 or params['landArea'] <= 0:
            continue
        households = floors * units_per_floor
        far = floors * units_per_floor * params['avgFarAreaPerHousehold'] / params['landArea'] * 100
        bcr = result['footprintAreaM2'] / params['landArea'] * 100

        if best is None or far > best['achievedFar']:
            best = {
                'rows': result['rows'], 'unitsPerFloor': units_per_floor,
                'achievedHouseholds': households, 'achievedFar': far, 'achievedBcr': bcr,
                'footprintAreaM2': result['footprintAreaM2'],
                'northSetback': north_setback, 'buildingGap': building_gap,
                'assumedHeightM': height, 'setbackDetails': setback_details
            }
    return best


def optimize_massing(buildable_envelope_geojson, envelope_edges, request_params):
    """
    Step 5 오케스트레이터: 회전각 후보 × 층수(1~상한) 전수 평가 중, 법정 건폐율/용적률을
    넘지 않으면서 달성 용적률이 최대인 조합을 채택해 layoutInfo와 동일한 스키마로 반환한다.
    """
    land_area = num(request_params.get('landArea'))
    if land_area <= 0:
        return {'error': 'landArea required', 'rows': [], 'maxRows': 0, 'noFit': True}

    lat0 = _avg_lat_of_geojson(buildable_envelope_geojson)
    to_m, to_ll = geo_utils.make_meter_converters(lat0)

    poly_m = geojson_to_meter_ring(buildable_envelope_geojson, to_m)
    if not poly_m or len(poly_m) < 3:
        return {'error': 'invalid envelope', 'rows': [], 'maxRows': 0, 'noFit': True}

    orientations = derive_orientation_candidates(envelope_edges, to_m)

    combo_mode = request_params.get('unitComboMode', 'auto')
    combos = [5, 4, 3, 2] if combo_mode == 'auto' else [int(num(combo_mode)) or 4]
    shape_mode = request_params.get('buildingShapeMode') or '판상형'
    if shape_mode == 'auto':
        shape_mode = '판상형'  # 1차 버전: 형상은 탐색하지 않고 고정값 사용, auto는 판상형으로 간주

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

    base_unit_width = num(request_params.get('standardUnitWidth')) or 15
    # 세대타입별 공급면적 비례 폭을 미리 붙여서 넘긴다 — 84/59 등 타입이 섞여도 실제 크기 차이가
    # 유닛 박스 폭에 반영되도록(calculator.js와 동일 로직).
    unit_type_list_scaled = attach_per_type_unit_widths(request_params.get('unitTypeList') or [], base_unit_width)

    pack_params = {
        'bldgDepth': num(request_params.get('standardBuildingDepth')) or 10,
        'unitWidth': base_unit_width,
        'core': num(request_params.get('coreWidth')) or 10,
        'combos': combos,
        'unitTypeList': unit_type_list_scaled,
        'buildingShapeMode': shape_mode,
        'h1Mm': request_params.get('floorHeight1Mm'), 'h2Mm': request_params.get('floorHeight2Mm'),
        'h3Mm': request_params.get('floorHeight3Mm'), 'htypMm': request_params.get('floorHeightTypicalMm'),
        'northSetbackRatio': num(request_params.get('northSetbackRatio')) or 0.5,
        'buildingGapRatio': building_gap_ratio,
        'avgFarAreaPerHousehold': avg_far_area_per_household,
        'landArea': land_area,
    }

    best = None
    best_validation = None
    candidates_evaluated = 0
    candidates_rejected_by_validation = 0
    t0 = time.time()

    for orientation in orientations:
        for floors in range(1, max_floors_cap + 1):
            result = evaluate_floor_candidate(poly_m, envelope_edges, to_m, floors, orientation, pack_params)
            candidates_evaluated += 1
            if result is None:
                continue
            if result['achievedBcr'] > legal_bcr_max + 0.01:
                continue
            if result['achievedFar'] > far_cap_target + 0.01:
                continue

            better = (
                best is None
                or result['achievedFar'] > best['achievedFar'] + 1e-6
                or (abs(result['achievedFar'] - best['achievedFar']) < 1e-6 and floors > best['floors'])
                or (abs(result['achievedFar'] - best['achievedFar']) < 1e-6 and floors == best['floors']
                    and result['footprintAreaM2'] < best['footprintAreaM2'])
            )
            if not better:
                continue

            # 인동간격·채광사선(도로중심선 기준 포함)·정북일조 이격을 여기서 다시 한번 기하학적으로
            # 검증한다 — 팩킹 로직의 근사 오차 등으로 이 조건을 만족하지 못하면, 아무리 용적률이
            # 높아도 이 후보는 채택하지 않고 건너뛴다("위반 대안은 생성하지 않는다"를 최종 채택
            # 단계에서도 강제). 이전 버전은 "최고점(best)"만 맨 마지막에 한 번 검증해 결과에
            # validated:false로 표시만 하고 그대로 반환했었다 — 이제는 매 후보가 최고점을 갱신할
            # 때마다 즉시 검증해서, 불합격한 후보는 애초에 최고점으로 채택되지 않는다.
            candidate_validation = validate_placement(result['rows'], poly_m)
            if not candidate_validation['ok']:
                candidates_rejected_by_validation += 1
                continue

            best = {**result, 'floors': floors, 'rotationDeg': orientation['rotationDeg'], 'frontSource': orientation['frontSource']}
            best_validation = candidate_validation

    elapsed_ms = round((time.time() - t0) * 1000)
    search_stats = {
        'candidatesEvaluated': candidates_evaluated,
        'candidatesRejectedByValidation': candidates_rejected_by_validation,
        'elapsedMs': elapsed_ms
    }

    if best is None:
        return {
            'rows': [], 'maxRows': 0, 'unitsPerFloor': 0, 'totalUnitsPerFloorAllRows': 0,
            'chosenFloors': 0, 'rotationDeg': 0, 'achievedFar': 0, 'achievedBcr': 0, 'achievedHouseholds': 0,
            'farCapTarget': far_cap_target, 'farUtilizationRatio': 0,
            'buildingShape': shape_mode, 'noFit': True, 'searchStats': search_stats
        }

    validation = best_validation  # 채택 시점에 이미 검증을 통과한 후보만 best가 될 수 있다
    capped_at_50 = (not allow_over_50) and max_floors_cap <= 50 and best['floors'] >= max_floors_cap

    # 변별 기준선·적용배수·요구 이격거리(clip 단계에서 이미 계산됨)에, 실제 배치된 동까지의
    # 최단거리(shapely)를 더해 "기준점과 유닛과의 실제 거리 및 몇 배를 적용했는지"를 함께 보고한다.
    building_shapes_m = [ShapelyPolygon(r['pathM']) for r in best['rows'] if r.get('pathM') and len(r['pathM']) >= 3]
    setback_report = []
    for detail in best['setbackDetails']:
        edge = next((e for e in (envelope_edges or []) if e.get('index') == detail['edgeIndex']), None)
        actual_distance = None
        if edge and building_shapes_m:
            edge_line = LineString([to_m(*edge['p1']), to_m(*edge['p2'])])
            actual_distance = min(edge_line.distance(bshape) for bshape in building_shapes_m)
        setback_report.append({**detail, 'actualDistanceM': round(actual_distance, 2) if actual_distance is not None else None})

    # 동간 거리(인동간격): rows[]의 각 항목은 판상형은 밴드(행) 하나 전체, L자형/타워형은 동 하나에
    # 해당하므로, 서로 다른 항목 간 최소거리를 재면 "실제 확보된 동간 거리"가 된다(같은 행 내부의
    # 좁은 단변 간격은 한 항목의 pathM 안에 이미 합쳐져 있어 여기 잡히지 않는다).
    inter_building_gap_report = None
    if len(building_shapes_m) >= 2:
        min_gap = min(
            building_shapes_m[i].distance(building_shapes_m[j])
            for i in range(len(building_shapes_m)) for j in range(i + 1, len(building_shapes_m))
        )
        inter_building_gap_report = {
            'referenceLine': '동간 거리(인동간격)', 'ratio': building_gap_ratio,
            'requiredSetbackM': round(best['buildingGap'], 2), 'actualDistanceM': round(min_gap, 2)
        }
        setback_report.append(inter_building_gap_report)

    rows_ll = []
    for row in best['rows']:
        rows_ll.append({
            'width': row['width'], 'combo': row['combo'], 'buildingCount': row['buildingCount'],
            'unitsThisRow': row['unitsThisRow'],
            'segments': [{'type': s['type'], 'pathLL': [list(to_ll(*pt)) for pt in s['pathM']]} for s in row['segments']],
            'buildingLabels': [{'text': bl['text'], 'positionLL': list(to_ll(*bl['positionM']))} for bl in row['buildingLabels']],
            'pathLL': [list(to_ll(*pt)) for pt in row['pathM']]
        })

    return {
        'rows': rows_ll,
        'maxRows': len(rows_ll),
        'unitsPerFloor': best['unitsPerFloor'],
        'totalUnitsPerFloorAllRows': best['unitsPerFloor'],
        'bldgDepth': pack_params['bldgDepth'], 'buildingGap': round(best['buildingGap'], 2), 'northSetback': round(best['northSetback'], 2),
        'assumedHeightM': round(best['assumedHeightM'], 2),
        'buildingShape': shape_mode, 'frontSource': best['frontSource'],
        'frontLabel': f"정밀 탐색 채택 (회전 {best['rotationDeg']}도, {best['frontSource']} 기준)",
        'chosenFloors': best['floors'], 'rotationDeg': best['rotationDeg'],
        'achievedFar': round(best['achievedFar'], 2), 'achievedBcr': round(best['achievedBcr'], 2),
        'achievedHouseholds': best['achievedHouseholds'],
        'farCapTarget': round(far_cap_target, 2),
        'farUtilizationRatio': round(best['achievedFar'] / far_cap_target, 4) if far_cap_target > 0 else 0,
        'validated': validation['ok'], 'validationViolations': validation['violations'],
        'cappedAt50': capped_at_50,
        'setbackReport': setback_report,
        'searchStats': search_stats
    }
