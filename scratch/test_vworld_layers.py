import requests
import json

lat, lon = 37.5167836, 127.0360016
key = "967BF2B7-4517-38BD-93CD-E59683605BD5"
url = "https://api.vworld.kr/req/data"

layers = ["LT_C_UQ111", "LT_C_UQ112", "LT_C_UM001"] # UM001 = 국토이용정보체계-용도지역지구

for layer in layers:
    print(f"\n--- Layer: {layer} ---")
    params = {
        "service": "data",
        "request": "GetFeature",
        "data": layer,
        "key": key,
        "geomFilter": f"POINT({lon} {lat})",
        "crs": "EPSG:4326",
        "format": "json",
        "domain": "http://localhost:5000"
    }
    resp = requests.get(url, params=params)
    resp.encoding = 'utf-8'
    data = resp.json()
    if 'response' in data and data['response']['status'] == 'OK':
        features = data['response']['result']['featureCollection']['features']
        for f in features:
            print("Properties:", f.get("properties", {}))
    else:
        print("Error or no data:", data)
