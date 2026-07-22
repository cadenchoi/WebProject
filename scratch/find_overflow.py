with open('static/css/style.css', 'r', encoding='utf-8') as f:
    lines = f.readlines()
for i, line in enumerate(lines):
    if 'overflow' in line:
        print(f"Line {i+1}: {line.strip()}")
