import requests
import json
import urllib.parse

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
print("Response apparent encoding:", resp.apparent_encoding)
print("Response headers:", resp.headers)

# Let's manually decode the raw content using EUC-KR if it's broken
raw = resp.content
try:
    text = raw.decode('utf-8')
    data = json.loads(text)
    features = data.get('response', {}).get('result', {}).get('featureCollection', {}).get('features', [])
    for f in features:
        print("UTF-8 decoded:", f.get("properties", {}).get("uname"))
except Exception as e:
    print("UTF-8 failed:", e)

try:
    # Sometimes VWorld sends ISO-8859-1 header but body is actually EUC-KR
    # However, json library expects utf-8. Let's see if we can decode it with EUC-KR
    # But wait, EUC-KR JSON might fail if the structure is ascii compatible?
    text = raw.decode('euc-kr')
    data = json.loads(text)
    features = data.get('response', {}).get('result', {}).get('featureCollection', {}).get('features', [])
    for f in features:
        print("EUC-KR decoded:", f.get("properties", {}).get("uname"))
except Exception as e:
    print("EUC-KR failed:", e)
