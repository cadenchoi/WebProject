import requests
import xml.etree.ElementTree as ET

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
    "format": "xml",
    "domain": "http://localhost:5000"
}
resp = requests.get(url, params=params)
print("XML Response:", resp.text[:500])
