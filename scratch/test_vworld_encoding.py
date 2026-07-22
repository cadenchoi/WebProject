import requests

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
# Let's inspect the raw bytes of the content
raw = resp.content
print("Raw bytes preview:", raw[:100])
try:
    text_euckr = raw.decode('euc-kr')
    print("EUC-KR Decoding preview:", text_euckr[2000:2500])
except Exception as e:
    print("EUC-KR decoding failed:", e)

try:
    text_utf8 = raw.decode('utf-8')
    print("UTF-8 Decoding preview:", text_utf8[2000:2500])
except Exception as e:
    print("UTF-8 decoding failed:", e)
