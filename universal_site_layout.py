"""
범용 임의 다각형 대지 공동주택 자동 배치 알고리즘 (Universal Generative Massing Layout)
================================================================================
임의의 2D 다각형 대지(site_polygon)에 대해, 대한민국 건축법 제86조(일조 등의 확보를 위한
건축물의 높이 제한)와 보편적인 공동주택 배치 원리를 반영해 주동을 자동 배치하고 용적률을
최대화한다. 특정 대지 좌표를 코드에 고정하지 않고, 전부 벡터 기하 연산(Shapely)으로
처리하므로 어떤 형상의 대지가 입력되어도 동일한 로직으로 동작한다.

구성 (Step 1~4):
  Step 1. 범용 대지 벡터 분석(OBB) + 이격 반영 건축가능영역 + 주동 파라메트릭 모듈
  Step 2. 건축법 제86조 자동 검증(정북 이격 / 채광면 이격 / 동간 거리)
  Step 3. 후보지 그리드 탐색 + Greedy 배치 + 적응형 층수 Step-down 알고리즘
  Step 4. Matplotlib 기반 2D 시각화

실행: python universal_site_layout.py
  (임의의 불규칙 다각형 대지를 하나 생성해 전체 파이프라인을 실행하고 결과를 시각화한다.
  실제 서비스에서는 run_layout_pipeline(site_polygon, ...)에 실제 대지 Polygon을 넘기면 된다.)

주의: 이 파일은 이 프로젝트의 기존 massing.py(9종 유닛조합 카탈로그 기반 GA)와는 독립적인
범용 프로토타입이다 — 특정 참조 이미지의 9개 조합에 종속되지 않고, 판상형/L자형/V자형을
파라메트릭하게 생성해 "어떤 모양의 대지에도" 적용 가능한 별도 알고리�즘으로 설계했다.
"""
import math
import random
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import numpy as np
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
from matplotlib.patches import Polygon as MplPolygon
import geopandas as gpd
from shapely.geometry import Polygon, LineString, Point
from shapely.affinity import rotate as shapely_rotate, translate as shapely_translate
from shapely.ops import unary_union

# 한글 라벨(동 이름, 축 제목 등)이 matplotlib 기본 폰트(DejaVu Sans)에는 없어 네모(tofu)로
# 깨지는 것을 방지 — Windows에 기본 내장된 한글 글꼴이 있으면 그것을 사용한다.
for _candidate_font in ('Malgun Gothic', 'AppleGothic', 'NanumGothic'):
    if _candidate_font in {f.name for f in fm.fontManager.ttflist}:
        plt.rcParams['font.family'] = _candidate_font
        break
plt.rcParams['axes.unicode_minus'] = False


# ═══════════════════════════════════════════════════════════════════════════
# 공통 유틸리티 — 방위각 계산
# ═══════════════════════════════════════════════════════════════════════════

def bearing_of(vector, north_vector=(0.0, 1.0)):
    """벡터의 나침반 방위각(도, 0=정북·시계방향 90=정동·180=정남·270=정서)을 north_vector
    기준으로 계산한다. site_polygon의 좌표계가 어떤 방향을 '정북'으로 삼든(기본은 +Y),
    이 함수 하나로 실제 방위각을 일관되게 구할 수 있다."""
    vx, vy = vector
    nx, ny = north_vector
    n_len = math.hypot(nx, ny)
    v_len = math.hypot(vx, vy)
    if n_len < 1e-9 or v_len < 1e-9:
        return 0.0
    n_ang = math.atan2(nx / n_len, ny / n_len)
    v_ang = math.atan2(vx / v_len, vy / v_len)
    return math.degrees(v_ang - n_ang) % 360


# ═══════════════════════════════════════════════════════════════════════════
# Step 1-A. 범용 대지 벡터 분석 (OBB 기반 장축/단축 파악)
# ═══════════════════════════════════════════════════════════════════════════

def analyze_site_axes(site_polygon: Polygon) -> dict:
    """
    site_polygon의 OBB(Oriented Bounding Box, shapely minimum_rotated_rectangle)를 구해
    장축 방향(단위벡터)·단축 방향·각 축 길이를 반환한다. 대지가 사각형이 아니어도(오목
    다각형 포함) 항상 유효한 근사 축을 얻을 수 있는 범용 연산이다 — 특정 좌표나 형상을
    가정하지 않는다.
    """
    obb = site_polygon.minimum_rotated_rectangle
    coords = list(obb.exterior.coords)[:-1]
    if len(coords) != 4:
        # 대지가 이미 선분/점에 가까운 퇴화 케이스 — 임의의 기본 축으로 대체
        return {'obb': obb, 'main_axis': (1.0, 0.0), 'cross_axis': (0.0, 1.0),
                'main_axis_length': 1.0, 'cross_axis_length': 1.0}

    edges = []
    for i in range(4):
        p1 = np.array(coords[i])
        p2 = np.array(coords[(i + 1) % 4])
        length = float(np.linalg.norm(p2 - p1))
        direction = (p2 - p1) / length if length > 1e-9 else np.array([1.0, 0.0])
        edges.append((length, direction))
    edges.sort(key=lambda e: -e[0])
    long_len, long_dir = edges[0]
    short_len = edges[2][0] if len(edges) > 2 else edges[1][0]
    short_dir = np.array([-long_dir[1], long_dir[0]])
    return {
        'obb': obb,
        'main_axis': (float(long_dir[0]), float(long_dir[1])),
        'cross_axis': (float(short_dir[0]), float(short_dir[1])),
        'main_axis_length': long_len,
        'cross_axis_length': short_len,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Step 1-B. 이격 반영 건축가능영역 (Buildable Polygon)
# ═══════════════════════════════════════════════════════════════════════════

def _offset_edge_inward(polygon: Polygon, p1, p2, distance, centroid):
    """polygon의 한 변(p1→p2)에서 안쪽으로 distance만큼 반평면을 잘라낸 결과를 반환한다.
    '안쪽'은 대지 중심(centroid) 쪽으로 법선을 자동 정렬해 판단하므로, 변의 정점 순서가
    시계/반시계 어느 쪽이든 항상 올바르게 동작한다."""
    p1, p2 = np.array(p1), np.array(p2)
    edge = p2 - p1
    length = np.linalg.norm(edge)
    if length < 1e-9 or distance <= 0:
        return polygon
    ux, uy = edge / length
    nx, ny = -uy, ux
    mid = (p1 + p2) / 2
    to_centroid = np.array(centroid) - mid
    if nx * to_centroid[0] + ny * to_centroid[1] < 0:
        nx, ny = -nx, -ny
    line_point = mid + np.array([nx, ny]) * distance
    margin = 1e6
    a = line_point - np.array([ux, uy]) * margin
    b = line_point + np.array([ux, uy]) * margin
    c = b + np.array([nx, ny]) * margin
    d = a + np.array([nx, ny]) * margin
    halfplane = Polygon([tuple(a), tuple(b), tuple(c), tuple(d)])
    clipped = polygon.intersection(halfplane)
    if clipped.is_empty:
        return clipped
    if clipped.geom_type == 'MultiPolygon':
        clipped = max(clipped.geoms, key=lambda g: g.area)
    return clipped


def compute_buildable_polygon(site_polygon: Polygon, road_edges: Optional[List[LineString]] = None,
                               north_vector=(0.0, 1.0),
                               road_setback=3.0, adjacent_setback=1.5, north_min_setback=1.5):
    """
    도로/인접대지 경계선으로부터 법적 이격을 반영한 1차 건축가능영역을 계산한다. 도로에
    접한 변(road_edges에 포함된 변)은 road_setback을, 그 외 변(인접대지 경계선으로 간주)은
    adjacent_setback을 적용한다. 정북 방향에 가장 가까운 변은 최소한의 이격(north_min_setback)
    만 우선 적용하고, 실제 정북일조 이격(높이 비례)은 각 후보 동의 층수가 정해진 뒤
    check_north_setback()에서 별도로 재확인한다(대지 폴리곤 자체를 매 후보 층수마다 다시
    깎지 않고, 후보 동 하나하나의 거리를 직접 재는 방식 — 임의의 오목 다각형에서도 안정적).

    road_edges는 (p1, p2) 좌표쌍 리스트(또는 LineString)로 주며, site_polygon의 실제 변과
    좌표가 근사 일치하는 변을 도로변으로 인식한다.
    """
    road_edge_lines = []
    for e in (road_edges or []):
        if isinstance(e, LineString):
            road_edge_lines.append(e)
        else:
            road_edge_lines.append(LineString(e))

    coords = list(site_polygon.exterior.coords)
    if coords[0] == coords[-1]:
        coords = coords[:-1]
    centroid = (site_polygon.centroid.x, site_polygon.centroid.y)

    result = site_polygon
    n = len(coords)
    north_edge_index = _find_north_edge_index(coords, north_vector)
    for i in range(n):
        p1, p2 = coords[i], coords[(i + 1) % n]
        edge_line = LineString([p1, p2])
        is_road = any(edge_line.distance(rl) < 1.0 or edge_line.hausdorff_distance(rl) < 1.0 for rl in road_edge_lines)
        if i == north_edge_index:
            setback = north_min_setback
        elif is_road:
            setback = road_setback
        else:
            setback = adjacent_setback
        result = _offset_edge_inward(result, p1, p2, setback, centroid)
        if result.is_empty or result.area <= 0:
            break
    return result


def _find_north_edge_index(coords, north_vector):
    """대지 외곽선 중 바깥쪽 법선이 north_vector와 가장 가까운(내적이 최대인) 변의 인덱스를
    정북 인접경계선 후보로 판정한다."""
    n = len(coords)
    centroid = np.mean(np.array(coords), axis=0)
    best_i, best_dot = 0, -1e9
    nx0, ny0 = north_vector
    n_len = math.hypot(nx0, ny0) or 1.0
    nx0, ny0 = nx0 / n_len, ny0 / n_len
    for i in range(n):
        p1 = np.array(coords[i])
        p2 = np.array(coords[(i + 1) % n])
        edge = p2 - p1
        length = np.linalg.norm(edge)
        if length < 1e-9:
            continue
        ux, uy = edge / length
        nx, ny = -uy, ux
        mid = (p1 + p2) / 2
        to_centroid = centroid - mid
        if nx * to_centroid[0] + ny * to_centroid[1] > 0:
            nx, ny = -nx, -ny
        dot = nx * nx0 + ny * ny0
        if dot > best_dot:
            best_dot, best_i = dot, i
    return best_i


# ═══════════════════════════════════════════════════════════════════════════
# Step 1-C. 주동 파라메트릭 모듈 (판상형 / L자형 / V자형)
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class BuildingModule:
    """
    주동 모듈 하나의 정의 — 판상형/L자형/V자형을 동일한 인터페이스로 다룬다.

    local_polygon : 모듈 고유 좌표계(도형 중심이 원점)의 shapely Polygon(회전/이동 전).
    light_faces   : [(nx, ny, ax, ay), ...] — 로컬 좌표계 기준 채광면 목록. 각 항목은
                    (바깥쪽 법선 단위벡터, 벽면 위 대표점) — 판상형은 1개, L자형/V자형은
                    날개마다 1개씩(날개별로 다른 방향을 볼 수 있으므로 리스트로 관리).
    """
    name: str
    local_polygon: Polygon
    light_faces: List[Tuple[float, float, float, float]]

    def aggregate_local_bearing(self, north_vector=(0.0, 1.0)):
        """모든 채광면 법선의 평균 방향(정규화) 방위각 — 모듈 전체를 '대표적으로' 어느
        방향으로 돌려야 채광면들이 대체로 남쪽을 향하는지 판단하는 기준으로 쓴다."""
        nxs = sum(f[0] for f in self.light_faces)
        nys = sum(f[1] for f in self.light_faces)
        if abs(nxs) < 1e-9 and abs(nys) < 1e-9:
            return 0.0
        return bearing_of((nxs, nys), north_vector)

    def place(self, position, rotation_deg):
        """월드 좌표계로 회전(rotation_deg, 도) 후 position으로 평행이동한 결과를 반환한다.
        (world_polygon, world_light_faces) — world_light_faces는 [(nx, ny, ax, ay), ...]."""
        rotated = shapely_rotate(self.local_polygon, rotation_deg, origin=(0, 0), use_radians=False)
        world_polygon = shapely_translate(rotated, xoff=position[0], yoff=position[1])
        rad = math.radians(rotation_deg)
        cos_a, sin_a = math.cos(rad), math.sin(rad)
        world_faces = []
        for nx, ny, ax, ay in self.light_faces:
            wnx = nx * cos_a - ny * sin_a
            wny = nx * sin_a + ny * cos_a
            wax = ax * cos_a - ay * sin_a + position[0]
            way = ax * sin_a + ay * cos_a + position[1]
            world_faces.append((wnx, wny, wax, way))
        return world_polygon, world_faces


def make_slab_module(width: float, depth: float) -> BuildingModule:
    """판상형(직사각형 단순 슬라브) 모듈. 채광면은 로컬 +Y쪽 장변 1개
    (실제 방위는 place()에서 회전각에 따라 결정된다)."""
    hw, hd = width / 2, depth / 2
    poly = Polygon([(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)])
    light_faces = [(0.0, 1.0, 0.0, hd)]
    return BuildingModule('판상형', poly, light_faces)


def make_l_module(wing_a_len: float, wing_b_len: float, depth: float) -> BuildingModule:
    """L자형 모듈 — 코너(꺾이는 지점)를 중심으로 두 날개가 직각으로 만난다. 날개마다
    바깥쪽을 향하는 채광면 1개씩(총 2개) — 코너 세대 채광 확보를 위한 흔한 형태."""
    d = depth
    poly = Polygon([
        (0, 0), (wing_a_len, 0), (wing_a_len, d), (d, d), (d, wing_b_len), (0, wing_b_len)
    ])
    cx, cy = poly.centroid.x, poly.centroid.y
    poly = shapely_translate(poly, xoff=-cx, yoff=-cy)
    light_faces = [
        (0.0, 1.0, wing_a_len / 2 - cx, d - cy),
        (-1.0, 0.0, d - cx, wing_b_len / 2 - cy),
    ]
    return BuildingModule('L자형', poly, light_faces)


def make_v_module(wing_len: float, depth: float, angle_deg: float = 120.0) -> BuildingModule:
    """V자형(꺾인 판상형) 모듈 — 두 날개가 완만한 각도(기본 120도)로 벌어져 코너 세대의
    채광·조망을 동시에 확보하는 흔한 형태. 두 날개를 코너에서 살짝 겹치게 그린 뒤
    union으로 합쳐(9종 카탈로그 조합에서 쓴 것과 동일한 기법) 하나의 깔끔한 폴리곤으로
    만든다 — 두 사각형이 점 하나만 공유하면 shapely 합집합이 지저분해지는 것을 피한다."""
    d = depth
    half_angle = math.radians(angle_deg / 2)
    dir_a = np.array([math.sin(half_angle), math.cos(half_angle)])
    dir_b = np.array([-math.sin(half_angle), math.cos(half_angle)])
    normal_a = np.array([dir_a[1], -dir_a[0]])
    normal_b = np.array([-dir_b[1], dir_b[0]])

    def wing_rect(dir_vec, normal_vec, length, back_extra):
        p_start = -dir_vec * back_extra
        p_end = dir_vec * length
        return Polygon([
            tuple(p_start), tuple(p_end),
            tuple(p_end + normal_vec * d), tuple(p_start + normal_vec * d)
        ])

    back_extra = d * 0.75
    wing_a = wing_rect(dir_a, normal_a, wing_len, back_extra)
    wing_b = wing_rect(dir_b, normal_b, wing_len, back_extra)
    poly = unary_union([wing_a.buffer(0.01), wing_b.buffer(0.01)])
    if poly.geom_type == 'MultiPolygon':
        poly = max(poly.geoms, key=lambda g: g.area)
    cx, cy = poly.centroid.x, poly.centroid.y
    poly = shapely_translate(poly, xoff=-cx, yoff=-cy)

    mid_a = dir_a * (wing_len * 0.5)
    mid_b = dir_b * (wing_len * 0.5)
    light_faces = [
        (normal_a[0], normal_a[1], mid_a[0] + normal_a[0] * d / 2 - cx, mid_a[1] + normal_a[1] * d / 2 - cy),
        (normal_b[0], normal_b[1], mid_b[0] + normal_b[0] * d / 2 - cx, mid_b[1] + normal_b[1] * d / 2 - cy),
    ]
    return BuildingModule('V자형', poly, light_faces)


# ═══════════════════════════════════════════════════════════════════════════
# Step 1-D. 향(Orientation) 제어 — 채광면이 남동~남서(135~225도) 범위를 향하도록 회전
# ═══════════════════════════════════════════════════════════════════════════

SOUTH_FACING_MIN_DEG = 135.0
SOUTH_FACING_MAX_DEG = 225.0


def compute_south_facing_rotation(module: BuildingModule, north_vector=(0.0, 1.0)) -> float:
    """모듈의 채광면 평균 방향이 정남(180도)을 향하도록 필요한 회전각(도)을 계산한다.
    정남을 목표로 삼으면 남동~남서(135~225) 허용범위의 정중앙이라 대지 형상이나 모듈
    형태와 무관하게 항상 범위 안에 든다 — 대지의 장축 방향에 맞추고 싶은 유혹이 있어도,
    실제 설계 원칙(세대 채광이 남향 확보가 최우선)대로 방위각을 우선한다."""
    local_bearing = module.aggregate_local_bearing(north_vector)
    return (180.0 - local_bearing) % 360


def in_south_facing_range(bearing_deg: float) -> bool:
    return SOUTH_FACING_MIN_DEG <= bearing_deg <= SOUTH_FACING_MAX_DEG


# ═══════════════════════════════════════════════════════════════════════════
# Step 2. 건축법 제86조 자동 검증 (정북 이격 / 채광면 이격 / 동간 거리)
# ═══════════════════════════════════════════════════════════════════════════

FLOOR_HEIGHT_M = 3.0          # 층당 가정 높이(단순화 — 실제 설계는 층별 층고가 다를 수 있음)
MIN_SIDE_WALL_GAP = 4.0        # 측벽간 최소 이격(m)
MIN_SIDE_WALL_GAP_WINDOWLESS = 8.0  # 무창 측벽 최소 이격(m) — 조례에 따라 채광창이 없는
                                     # 측벽끼리도 별도의(더 큰) 이격을 요구하는 경우가 있다
MIN_LOW_RISE_SETBACK = 1.5     # H<=10m 구간의 완화된 최소 이격(m) — 시행령의 세부 단계식
                                # 공식(9m 이하 1.5m, 초과분 0.5배 가산)을 이 프로토타입에서는
                                # "10m 이하는 최소 이격, 초과 시 0.5*H"로 단순화했다(요청 스펙
                                # 그대로: "H > 10m 구간"에서 0.5*H를 적용).
FACING_COS_THRESHOLD = 0.5      # 두 벽면이 '마주본다'고 볼 법선-연결벡터 각도 허용치(약 60도)


def height_of_floors(floors: int) -> float:
    return max(1, floors) * FLOOR_HEIGHT_M


def required_north_setback(height_m: float) -> float:
    """정북 방향 이격 요구치 — 건축법 제86조 제1항 취지(H>10m 구간은 0.5*H)를 스펙 그대로
    단순화 적용. 실제 시행령은 9m/높이별 단계식 가산 공식이 더 세부적이므로, 실사용 시에는
    지자체 조례를 재확인해야 한다(이 함수의 docstring에도 명시)."""
    if height_m > 10.0:
        return 0.5 * height_m
    return MIN_LOW_RISE_SETBACK


def required_boundary_daylight_setback(height_m: float) -> float:
    """채광면(대지경계선 방향) 이격 요구치 — 0.5*H, 최소 MIN_LOW_RISE_SETBACK."""
    return max(MIN_LOW_RISE_SETBACK, 0.5 * height_m)


def _wall_faces_point(normal, anchor, target_point, cos_threshold=FACING_COS_THRESHOLD):
    """anchor에서 target_point로의 방향이 normal과 충분히 나란한지(=벽면이 그 점을
    정면으로 바라보는지)를 내적으로 판정한다."""
    dx, dy = target_point[0] - anchor[0], target_point[1] - anchor[1]
    dist = math.hypot(dx, dy)
    if dist < 1e-6:
        return False
    return (dx * normal[0] + dy * normal[1]) / dist > cos_threshold


def classify_facing(faces_a, faces_b, centroid_a, centroid_b):
    """두 동의 채광면 목록(월드 좌표, [(nx,ny,ax,ay),...])을 비교해 관계를 분류한다:
      'mutual'  — 서로의 채광면이 서로를 마주봄 (양�-> 모두 향함)
      'one_way' — 한쪽 채광면만 상대를 향함(반대편은 측벽이거나 다른 방향을 봄)
      'none'    — 어느 채광면도 상대를 향하지 않음(측벽간 거리 규정 적용 대상)
    """
    a_faces_b = any(_wall_faces_point((n[0], n[1]), (n[2], n[3]), centroid_b) for n in faces_a)
    b_faces_a = any(_wall_faces_point((n[0], n[1]), (n[2], n[3]), centroid_a) for n in faces_b)
    if a_faces_b and b_faces_a:
        return 'mutual'
    if a_faces_b or b_faces_a:
        return 'one_way'
    return 'none'


def required_inter_building_gap(height_a, height_b, relation, windowless=False):
    """동간 거리 요구치 — 건축법 제86조 취지의 인동간격 규정을 관계 유형별로 적용한다.
      - mutual (마주보는 채광면)      : 0.5 * max(H1, H2)
      - one_way(한쪽만 상대를 향함)   : max(10, 0.5 * H_low) — 낮은 동 기준(그 동의 채광이
                                        더 취약하므로 낮은 쪽 높이를 기준으로 보호한다)
      - none   (측벽간)               : 4m(무창 측벽이면 8m)
    """
    if relation == 'mutual':
        return 0.5 * max(height_a, height_b)
    if relation == 'one_way':
        return max(10.0, 0.5 * min(height_a, height_b))
    return MIN_SIDE_WALL_GAP_WINDOWLESS if windowless else MIN_SIDE_WALL_GAP


def _violation_is_height_resolvable(violation: str) -> bool:
    """이 위반이 candidate 자신의 층수(=높이)를 낮추면 해소될 가능성이 있는 유형인지
    판정한다 — north-setback/boundary-daylight-setback은 그 자체가 0.5*H 공식이라 항상
    해당되고, 동간 거리 중 'mutual'(0.5*max(H1,H2))·'one_way'(0.5*min(H1,H2))도 후보의
    높이가 낮아지면 요구치가 줄거나(최소한 늘지는 않으니) 완화될 수 있다. 반면
    'buildable-envelope-containment'(평면 형상 자체가 대지를 벗어남)나
    'inter-building(none...'(측벽 고정 4m/8m, 높이와 무관)은 층수를 아무리 낮춰도
    해결되지 않으므로 제외 — 이 경우는 위치를 옮기거나 포기해야 한다."""
    if violation.startswith('north-setback') or violation.startswith('boundary-daylight-setback'):
        return True
    if violation.startswith('inter-building(mutual') or violation.startswith('inter-building(one_way'):
        return True
    return False


@dataclass
class PlacedBuilding:
    module_name: str
    polygon: Polygon
    light_faces: List[Tuple[float, float, float, float]]
    floors: int
    height_m: float
    rotation_deg: float
    position: Tuple[float, float]


def check_legal_constraints(candidate: PlacedBuilding, placed: List[PlacedBuilding],
                             buildable_polygon: Polygon, site_polygon: Polygon,
                             north_edge: Optional[LineString], north_vector=(0.0, 1.0)):
    """candidate 동 하나가 (a) 건축가능영역 포함, (b) 정북 이격, (c) 채광면(대지경계선) 이격,
    (d) 기배치 동들과의 동간 거리를 모두 만족하는지 확인한다. 위반 사유 목록을 반환한다
    (빈 리스트면 적합)."""
    violations = []

    if not buildable_polygon.contains(candidate.polygon.buffer(-0.01)):
        violations.append('buildable-envelope-containment')

    if north_edge is not None:
        dist_to_north = candidate.polygon.distance(north_edge)
        req = required_north_setback(candidate.height_m)
        if dist_to_north < req - 0.05:
            violations.append(f'north-setback(need {req:.1f}m, got {dist_to_north:.1f}m)')

    boundary = site_polygon.exterior
    dist_to_boundary = candidate.polygon.distance(boundary)
    req_boundary = required_boundary_daylight_setback(candidate.height_m)
    if dist_to_boundary < req_boundary - 0.05:
        violations.append(f'boundary-daylight-setback(need {req_boundary:.1f}m, got {dist_to_boundary:.1f}m)')

    cand_centroid = (candidate.polygon.centroid.x, candidate.polygon.centroid.y)
    for other in placed:
        other_centroid = (other.polygon.centroid.x, other.polygon.centroid.y)
        relation = classify_facing(candidate.light_faces, other.light_faces, cand_centroid, other_centroid)
        req_gap = required_inter_building_gap(candidate.height_m, other.height_m, relation)
        actual_gap = candidate.polygon.distance(other.polygon)
        if actual_gap < req_gap - 0.05:
            violations.append(f'inter-building({relation}, need {req_gap:.1f}m, got {actual_gap:.1f}m)')

    return violations


# ═══════════════════════════════════════════════════════════════════════════
# Step 3. 후보지 탐색 + Greedy 배치 + 적응형 층수 Step-down
# ═══════════════════════════════════════════════════════════════════════════

MAX_FLOORS_START = 25   # 각 후보 위치에서 처음 시도하는(용적률 최대화를 위한) 층수
MIN_FLOORS = 3          # Step-down으로도 안 되면 포기하는 최저 층수
FLOOR_STEP = 1
ROW_SIDE_GAP = 4.0       # 같은 행(동-동, 남향 나란히) 안에서 동 사이 최소 여유(측벽 간격 기준)
GRID_SCAN_STEP = 5.0     # 후보 실패 시 커서를 전진시키는 그리드 간격(m) — 모듈 너비 비례
                          # 점프 대신 작은 고정 그리드 간격을 쓰면, 대각선/오목한 대지에서
                          # 폭이 좁고 뾰족한 실제 배치 가능 구간을 건너뛰지 않는다(실측으로
                          # 확인: 폭 비례 점프는 가늘고 긴 대지에서 유효 구간을 통째로
                          # 건너뛰어 배치를 0건으로 만드는 원인이었다).


def _row_extent_along(buildable_polygon: Polygon, row_y: float, cross_dir=(1.0, 0.0), origin=(0.0, 0.0),
                       band_half_height=7.0):
    """buildable_polygon을 row_y(북쪽으로의 거리, origin+north_vector*row_y를 지나는 동서
    방향 띠)와 교차시켜, 그 행에서 실제로 배치 가능한 동서 구간(cross_dir 축 위 좌표
    범위)을 구한다. 폭이 0인 '선(hairline)'이 아니라 band_half_height(건물 깊이의 절반
    가량)만큼의 두께를 가진 띠로 교차시키는 것이 중요하다 — 선으로만 교차하면 그 정확한
    y값에서는 넓어 보여도 건물의 실제 깊이가 걸치는 바로 위/아래에서 대지가 좁아지는
    경우(오목한 형상)를 놓쳐, 나중에 배치 가능 판정에서 반복적으로 포함(containment)
    위반이 나는 원인이 된다. 오목한 대지 형상에서도(교차가 여러 조각으로 나뉠 수 있음)
    가장 넓은 조각을 사용한다."""
    margin = max(buildable_polygon.bounds[2] - buildable_polygon.bounds[0],
                 buildable_polygon.bounds[3] - buildable_polygon.bounds[1]) * 2 + 10
    north_vec = np.array([0.0, 1.0])
    cross = np.array(cross_dir)
    base = np.array(origin) + north_vec * row_y
    p1 = base - cross * margin - north_vec * band_half_height
    p2 = base + cross * margin - north_vec * band_half_height
    p3 = base + cross * margin + north_vec * band_half_height
    p4 = base - cross * margin + north_vec * band_half_height
    band = Polygon([tuple(p1), tuple(p2), tuple(p3), tuple(p4)])
    inter = buildable_polygon.intersection(band)
    if inter.is_empty:
        return None
    if inter.geom_type == 'MultiPolygon':
        inter = max(inter.geoms, key=lambda g: g.area)
    if inter.geom_type != 'Polygon':
        return None
    xs = [pt[0] * cross_dir[0] + pt[1] * cross_dir[1] for pt in inter.exterior.coords]
    return (min(xs), max(xs))


def _attempt_place_with_stepdown(module, rot, place_x, y, placed, buildable_polygon, site_polygon,
                                  north_edge, north_vector, corridor_band):
    """module을 (place_x, y)에 회전 rot으로 두고 MAX_FLOORS_START부터 시도, 높이로 해소
    가능한 위반만 있으면 층수를 낮춰가며(Step-down) 재시도한다. 성공하면 PlacedBuilding,
    끝내 실패하면 None을 반환한다 — 행(row) 배치 루프에서 여러 모듈 후보를 같은 위치에
    돌아가며 시도할 때 공유되는 로직."""
    bearing = module.aggregate_local_bearing(north_vector) + rot
    assert in_south_facing_range(round(bearing % 360, 3)), \
        f'{module.name} rotated to bearing {bearing % 360:.1f}, outside the required 135-225 south-facing range'

    floors = MAX_FLOORS_START
    while floors >= MIN_FLOORS:
        height_m = height_of_floors(floors)
        world_poly, world_faces = module.place((place_x, y), rot)
        if corridor_band.intersects(world_poly.buffer(-0.01)) and \
                corridor_band.intersection(world_poly).area > world_poly.area * 0.15:
            return None  # 중앙 통경축을 크게 침범 — 층수를 낮춰도 해결 안 되므로 즉시 포기
        candidate = PlacedBuilding(module.name, world_poly, world_faces, floors, height_m, rot, (place_x, y))
        violations = check_legal_constraints(candidate, placed, buildable_polygon, site_polygon,
                                              north_edge, north_vector)
        if not violations:
            return candidate
        if all(_violation_is_height_resolvable(v) for v in violations):
            floors -= FLOOR_STEP
            continue
        return None
    return None


def _module_world_bbox_half_extents(module: BuildingModule, rotation_deg: float):
    """모듈을 원점에서 rotation_deg로 두었을 때 월드 좌표계 기준 절반-너비/절반-높이를
    반환한다. L자형/V자형은 두 날개가 대각선으로 벌어져 있어, 단순히 depth/2로 어림하면
    실제 남북 방향 점유폭을 크게 과소평가한다(날개 길이에 따라 depth의 2~3배까지도
    벌어질 수 있음) — 행(row) 배치의 시작 y와 행-간 간격을 이 실측값 기반으로 정해야,
    첫 행이 남쪽 경계에 너무 붙어 모든 후보가 건축가능영역을 벗어나는 문제를 피한다."""
    poly, _ = module.place((0.0, 0.0), rotation_deg)
    minx, miny, maxx, maxy = poly.bounds
    return (maxx - minx) / 2, (maxy - miny) / 2


def place_buildings_on_site(buildable_polygon: Polygon, site_polygon: Polygon,
                             site_axes: dict, north_vector=(0.0, 1.0),
                             module_factories=None, view_corridor_width_ratio=0.16,
                             max_rows=40):
    """
    Step 3 본체 — buildable_polygon 내부를 남->북 방향으로 행(Row) 단위로 그리드
    샘플링하며, 각 행 안에서는 동서 방향으로 Greedy하게 주동을 채워나간다.

    각 후보 위치에서:
      1) MAX_FLOORS_START 층수로 시도.
      2) check_legal_constraints 위반이 전부 '높이를 낮추면 해소 가능한' 유형
         (정북 이격/채광면 경계 이격/동간 거리 mutual·one_way)이면, 그 동의 층수를
         FLOOR_STEP씩 줄여(Step-down) 다시 검사 — 위치를 옮기는 대신 높이를 낮춰 만족시킨다.
      3) 건축가능영역 이탈이나 측벽 이격처럼 높이와 무관한 위반이 하나라도 있으면 그
         위치는 포기하고 다음 후보로.
      4) MIN_FLOORS 밑으로 내려가도 해소가 안 되면 그 위치는 포기.

    대지 중앙부에는 중앙광장/통경축을 위해 폭 view_corridor_width_ratio(단축 길이 대비)의
    동서 방향 띠를 비워둔다.
    """
    minx, miny, maxx, maxy = buildable_polygon.bounds
    origin = (minx, miny)

    if module_factories is None:
        # 모듈 규모는 원본 대지의 OBB 축 길이가 아니라 buildable_polygon 자체의 bounding
        # box 중 더 좁은 변을 기준으로 잡는다 — 오목한 대지는 OBB가 실제 배치 가능한
        # 폭보다 훨씬 크게 나오기 쉬워, OBB 기준으로 모듈을 만들면 실제로는 들어갈 곳이
        # 거의 없는 과대 모듈이 되기 쉽다(예: 오목한 형상에서 실측으로 확인된 문제).
        cross_len = max(20.0, min(maxx - minx, maxy - miny))
        wing_len = max(15.0, min(35.0, cross_len * 0.3))
        module_factories = [
            lambda: make_slab_module(width=wing_len * 1.6, depth=14.0),
            lambda: make_l_module(wing_a_len=wing_len, wing_b_len=wing_len * 0.8, depth=13.0),
            lambda: make_v_module(wing_len=wing_len, depth=13.0, angle_deg=120.0),
        ]

    factory_half_heights = []
    for factory in module_factories:
        probe_module = factory()
        probe_rot = compute_south_facing_rotation(probe_module, north_vector)
        _, half_h = _module_world_bbox_half_extents(probe_module, probe_rot)
        factory_half_heights.append(half_h)
    max_module_half_height = max(factory_half_heights)

    # 중앙광장/통경축: 남북 폭(maxy-miny)의 중앙 부근에 동서 방향 띠를 예약해 세대 간
    # 시야 간섭을 줄이고 개방감을 확보한다.
    corridor_half_width = (maxy - miny) * view_corridor_width_ratio / 2
    corridor_center_y = (miny + maxy) / 2
    corridor_band = Polygon([
        (minx - 1e5, corridor_center_y - corridor_half_width),
        (maxx + 1e5, corridor_center_y - corridor_half_width),
        (maxx + 1e5, corridor_center_y + corridor_half_width),
        (minx - 1e5, corridor_center_y + corridor_half_width),
    ])

    north_edge_coords = _find_north_edge_line(site_polygon, north_vector)
    north_edge = LineString(north_edge_coords) if north_edge_coords else None

    placed: List[PlacedBuilding] = []
    y = miny + max_module_half_height + 3.0
    row_index = 0

    while y < maxy - 4.0 and row_index < max_rows:
        row_index += 1
        row_range = _row_extent_along(buildable_polygon, y - miny, cross_dir=(1.0, 0.0), origin=origin,
                                       band_half_height=max_module_half_height)
        if row_range is None:
            y += max(20.0, max_module_half_height)
            continue
        row_min_x, row_max_x = row_range
        cursor_x = row_min_x + 2.0
        row_tallest_height = None
        row_top_edge = None
        any_placed_this_row = False

        while cursor_x < row_max_x - 2.0:
            # 이 커서 위치에서 모듈 종류(판상형/L자형/V자형)를 하나만 고정해 시도하면, 그
            # 종류가 마침 너무 커서 안 맞을 때 실제로는 더 작은 모듈이 들어갈 수 있는
            # 자리인데도 건너뛰게 된다 — 세 종류를 전부 시도해보고 처음 맞는 것을 채택한다.
            start_idx = (row_index + int(cursor_x)) % len(module_factories)
            accepted = None
            for offset in range(len(module_factories)):
                factory = module_factories[(start_idx + offset) % len(module_factories)]
                module = factory()
                rot = compute_south_facing_rotation(module, north_vector)
                probe_poly, _ = module.place((cursor_x, y), rot)
                pminx, _, pmaxx, _ = probe_poly.bounds
                span_x = pmaxx - pminx
                place_x = cursor_x + span_x / 2
                result = _attempt_place_with_stepdown(module, rot, place_x, y, placed, buildable_polygon,
                                                       site_polygon, north_edge, north_vector, corridor_band)
                if result is not None:
                    accepted = result
                    break

            if accepted is not None:
                placed.append(accepted)
                any_placed_this_row = True
                row_tallest_height = max(row_tallest_height or 0, accepted.height_m)
                _, _, amaxx, atop = accepted.polygon.bounds
                row_top_edge = atop if row_top_edge is None else max(row_top_edge, atop)
                cursor_x = amaxx + ROW_SIDE_GAP
            else:
                cursor_x += GRID_SCAN_STEP

        # 다음 행 시작 y: 이번 행에서 실제 채택된 동들의 북쪽 끝(row_top_edge)에, 인동간격
        # (북쪽 행이 남쪽 행을 바라보는 one_way 관계 — 모든 동이 남향이므로 북쪽 동의
        # 채광면만 남쪽 동을 향한다) 및 다음 행 모듈의 예상 절반-높이를 더한다. 고정된
        # pitch 추정치가 아니라 이번 행에서 실제로 배치된 결과로부터 다음 행 위치를
        # 도출하므로, 층수를 낮췄을 때도 다음 행이 불필요하게 멀어지지 않는다.
        if any_placed_this_row:
            gap_needed = required_inter_building_gap(row_tallest_height, row_tallest_height, 'one_way')
            y = row_top_edge + gap_needed + max_module_half_height
        else:
            y += max(20.0, max_module_half_height)

    return placed, corridor_band


def _find_north_edge_line(site_polygon: Polygon, north_vector):
    coords = list(site_polygon.exterior.coords)
    if coords[0] == coords[-1]:
        coords = coords[:-1]
    idx = _find_north_edge_index(coords, north_vector)
    n = len(coords)
    return [coords[idx], coords[(idx + 1) % n]]


# ═══════════════════════════════════════════════════════════════════════════
# 임의 다각형 대지 테스트 생성기
# ═══════════════════════════════════════════════════════════════════════════

def generate_random_site_polygon(seed=None, avg_radius=90, n_vertices=None, irregularity=0.35) -> Polygon:
    """중심점 주위로 각도를 고르게 나눈 뒤 반지름에 무작위성을 줘, 항상 유효한(자기교차 없는)
    단순 다각형을 생성한다 — 각도순으로 정렬된 점을 잇기만 하면 볼록/오목이 섞인 임의
    형상이라도 자기교차가 생기지 않는다."""
    rng = random.Random(seed)
    if n_vertices is None:
        n_vertices = rng.randint(5, 9)
    angles = sorted(rng.uniform(0, 2 * math.pi) for _ in range(n_vertices))
    points = []
    for ang in angles:
        r = avg_radius * (1 + rng.uniform(-irregularity, irregularity))
        points.append((r * math.cos(ang), r * math.sin(ang)))
    poly = Polygon(points)
    if not poly.is_valid:
        poly = poly.buffer(0)
    return poly


def generate_random_road_edges(site_polygon: Polygon, seed=None, n_road_edges=1):
    """site_polygon 외곽선 중 일부를 무작위로 도로변으로 지정해 반환한다(테스트용)."""
    rng = random.Random(seed)
    coords = list(site_polygon.exterior.coords)[:-1]
    n = len(coords)
    idxs = rng.sample(range(n), min(n_road_edges, n))
    return [(coords[i], coords[(i + 1) % n]) for i in idxs]


# ═══════════════════════════════════════════════════════════════════════════
# Step 4. Matplotlib 기반 2D 시각화
# ═══════════════════════════════════════════════════════════════════════════

def visualize_layout(site_polygon: Polygon, buildable_polygon: Polygon, placed: List[PlacedBuilding],
                      corridor_band: Polygon, north_vector=(0.0, 1.0), title='범용 대지 자동 배치 결과'):
    fig, ax = plt.subplots(figsize=(10, 10))

    def plot_poly(poly, ax, **kwargs):
        if poly is None or poly.is_empty:
            return
        if poly.geom_type == 'MultiPolygon':
            geoms = list(poly.geoms)
        else:
            geoms = [poly]
        for g in geoms:
            xs, ys = g.exterior.xy
            ax.add_patch(MplPolygon(list(zip(xs, ys)), closed=True, **kwargs))

    plot_poly(site_polygon, ax, facecolor='none', edgecolor='black', linewidth=2.0, zorder=1)
    plot_poly(buildable_polygon, ax, facecolor='#eef7ee', edgecolor='#2e7d32', linewidth=1.2,
              linestyle='--', zorder=2)

    corridor_clip = corridor_band.intersection(buildable_polygon)
    plot_poly(corridor_clip, ax, facecolor='#fff3cd', edgecolor='none', alpha=0.6, zorder=3)

    cmap = plt.get_cmap('viridis')
    max_floors_seen = max((p.floors for p in placed), default=1)
    for p in placed:
        color = cmap(0.25 + 0.65 * (p.floors / max(max_floors_seen, 1)))
        plot_poly(p.polygon, ax, facecolor=color, edgecolor='#222222', linewidth=0.8, zorder=4)
        cx, cy = p.polygon.centroid.x, p.polygon.centroid.y
        ax.text(cx, cy, f'{p.floors}F\n{p.module_name}', ha='center', va='center', fontsize=7,
                color='white', zorder=5)
        for nx, ny, ax_, ay in p.light_faces:
            ax.arrow(ax_, ay, nx * 4, ny * 4, head_width=1.2, head_length=1.5,
                      fc='#ff5252', ec='#ff5252', linewidth=0.8, zorder=6)

    minx, miny, maxx, maxy = site_polygon.bounds
    span = max(maxx - minx, maxy - miny)
    arrow_origin = (minx + span * 0.05, maxy - span * 0.12)
    ax.arrow(arrow_origin[0], arrow_origin[1], north_vector[0] * span * 0.06, north_vector[1] * span * 0.06,
              head_width=span * 0.015, head_length=span * 0.02, fc='blue', ec='blue', zorder=7)
    ax.text(arrow_origin[0], arrow_origin[1] - span * 0.03, 'N', color='blue', fontsize=11,
            fontweight='bold', ha='center', zorder=7)

    ax.set_title(f'{title}  (총 {len(placed)}개 동, {sum(p.floors for p in placed)}층 합계)')
    ax.set_aspect('equal', adjustable='box')
    pad = span * 0.08
    ax.set_xlim(minx - pad, maxx + pad)
    ax.set_ylim(miny - pad, maxy + pad)
    ax.set_xlabel('X (m)')
    ax.set_ylabel('Y (m, +Y = 정북)')
    plt.tight_layout()
    return fig, ax


# ═══════════════════════════════════════════════════════════════════════════
# 전체 파이프라인 & 데모 실행
# ═══════════════════════════════════════════════════════════════════════════

def run_layout_pipeline(site_polygon: Polygon, road_edges=None, north_vector=(0.0, 1.0), show_plot=True):
    """Step 1~4를 순서대로 실행하는 엔드투엔드 파이프라인."""
    site_axes = analyze_site_axes(site_polygon)
    buildable = compute_buildable_polygon(site_polygon, road_edges, north_vector)
    if buildable.is_empty or buildable.area <= 0:
        raise ValueError('이격 적용 후 건축가능영역이 남지 않습니다 — 대지가 너무 작거나 좁습니다.')

    placed, corridor_band = place_buildings_on_site(buildable, site_polygon, site_axes, north_vector)

    total_floor_area = sum(p.polygon.area * p.floors for p in placed)
    footprint_area = sum(p.polygon.area for p in placed)
    far = total_floor_area / site_polygon.area * 100
    bcr = footprint_area / site_polygon.area * 100

    print(f'대지면적: {site_polygon.area:.1f} m2')
    print(f'건축가능영역 면적: {buildable.area:.1f} m2 ({buildable.area / site_polygon.area * 100:.1f}%)')
    print(f'배치된 동 수: {len(placed)}')
    for i, p in enumerate(placed):
        print(f'  동{i + 1}: {p.module_name}, {p.floors}층 (H={p.height_m:.1f}m), 위치={p.position}')
    print(f'건폐율(BCR): {bcr:.1f}%')
    print(f'용적률(FAR): {far:.1f}%')

    fig = None
    if show_plot:
        fig, _ = visualize_layout(site_polygon, buildable, placed, corridor_band, north_vector)
    return {
        'siteAxes': site_axes, 'buildable': buildable, 'placed': placed, 'corridorBand': corridor_band,
        'far': far, 'bcr': bcr, 'figure': fig,
    }


def _placed_buildings_to_geodataframe(placed: List[PlacedBuilding]):
    """배치 결과를 geopandas GeoDataFrame으로도 내보낸다(GIS 파이프라인 연계·좌표계 부여
    등에 활용 가능) — 시각화 자체는 matplotlib으로 직접 수행하지만, 요청된 라이브러리
    스택(geopandas) 활용 지점으로 결과를 표준 벡터 데이터 형태로도 제공한다."""
    return gpd.GeoDataFrame({
        'module': [p.module_name for p in placed],
        'floors': [p.floors for p in placed],
        'height_m': [round(p.height_m, 2) for p in placed],
    }, geometry=[p.polygon for p in placed])


if __name__ == '__main__':
    random_site = generate_random_site_polygon(seed=7, avg_radius=95, irregularity=0.4)
    random_roads = generate_random_road_edges(random_site, seed=7, n_road_edges=1)
    result = run_layout_pipeline(random_site, road_edges=random_roads, north_vector=(0.0, 1.0))

    gdf = _placed_buildings_to_geodataframe(result['placed'])
    print(gdf)

    plt.show()
