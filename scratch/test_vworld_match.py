import requests

def fix_vworld_zone_name(broken_name):
    if not broken_name:
        return broken_name
    zones = [
        "제1종전용주거지역", "제2종전용주거지역",
        "제1종일반주거지역", "제2종일반주거지역", "제3종일반주거지역",
        "준주거지역", "중심상업지역", "일반상업지역", "근린상업지역", "유통상업지역",
        "전용공업지역", "일반공업지역", "준공업지역",
        "보전녹지지역", "생산녹지지역", "자연녹지지역"
    ]
    for z in zones:
        simulated = z.encode('euc-kr').decode('utf-8', errors='replace')
        if broken_name == simulated:
            return z
    return broken_name

lat, lon = 37.5167836, 127.0360016
key = "967BF2B7-4517-38BD-93CD-E59683605BD5"

url = "https://api.vworld.kr/req/data"
params = {
    "service": "data",
    "request": "GetFeature",
    "data": "LT_C_UQ111",
    "key": key,
    "geomFilter": f"POINT({lon} {lat})",
    "crs": "EPSG:4326",
    "format": "json",
    "domain": "http://localhost:5000"
}

resp = requests.get(url, params=params)
data = resp.json()
features = data.get('response', {}).get('result', {}).get('featureCollection', {}).get('features', [])
if features:
    raw_name = features[0].get('properties', {}).get('uname')
    fixed_name = fix_vworld_zone_name(raw_name)
    print("Raw name hex:", raw_name.encode('utf-8').hex())
    print("Fixed name:", fixed_name)
    # Check if they match
    simulated_3 = "제3종일반주거지역".encode('euc-kr').decode('utf-8', errors='replace')
    print("Simulated '제3종일반주거지역' hex:", simulated_3.encode('utf-8').hex())
    print("Do they match?", raw_name == simulated_3)
