import codecs

def get_broken_string(text):
    euckr_bytes = text.encode('euc-kr')
    return euckr_bytes.decode('utf-8', errors='replace')

zones = [
    "제1종전용주거지역", "제2종전용주거지역",
    "제1종일반주거지역", "제2종일반주거지역", "제3종일반주거지역",
    "준주거지역", "중심상업지역", "일반상업지역", "근린상업지역", "유통상업지역",
    "전용공업지역", "일반공업지역", "준공업지역",
    "보전녹지지역", "생산녹지지역", "자연녹지지역",
    "개발제한구역"
]

with codecs.open('scratch/mapping.txt', 'w', 'utf-8') as f:
    for z in zones:
        broken = get_broken_string(z)
        f.write(f"    '{broken}': '{z}',\n")
