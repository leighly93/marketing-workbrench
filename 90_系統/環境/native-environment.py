"""Read-only macOS production inventory; never loads .env or downloads models."""
import hashlib
import json
import platform
from pathlib import Path
import shutil
import subprocess
import sys


def output(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def inventory():
    tools = {}
    for name, args in [('node', ['--version']), ('ffmpeg', ['-version']),
                       ('ffprobe', ['-version']), ('tesseract', ['--version']),
                       ('swiftc', ['--version'])]:
        value = output([name, *args])
        tools[name] = value.splitlines()[0] if value else None
    whisper = shutil.which('whisper')
    interpreter = None
    if whisper:
        # pipx/venv console scripts contain an absolute interpreter; never print it.
        first = Path(whisper).read_text().splitlines()[0]
        if first.startswith('#!') and Path(first[2:]).is_file():
            interpreter = first[2:]
    packages = None
    python_version = None
    if interpreter:
        value = output([interpreter, '-c', 'import json,importlib.metadata as m; print(json.dumps({d.metadata["Name"]:d.version for d in m.distributions()}))'])
        packages = json.loads(value) if value else None
        python_version = output([interpreter, '-c', 'import platform; print(platform.python_version())'])
    model = Path.home() / '.cache/whisper/small.pt'
    model_hash = None
    if model.is_file():
        with model.open('rb') as stream:
            model_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'platform': platform.system(), 'architecture': platform.machine(),
            'macOS': platform.mac_ver()[0], 'tools': tools,
            'whisperPython': python_version, 'whisperPackages': packages,
            'smallModelSHA256': model_hash}


if __name__ == '__main__':
    current = inventory()
    if '--check' in sys.argv:
        expected = json.loads(Path(__file__).with_name('native-observed.json').read_text())
        differences = [key for key in expected if expected[key] != current.get(key)]
        print('原生環境差異：' + (', '.join(differences) if differences else '符合觀測基準'))
        print('此檢查不執行 OCR／轉錄，不代表乾淨機還原或成品驗收。')
        sys.exit(1 if differences else 0)
    print(json.dumps(current, ensure_ascii=False, indent=2, sort_keys=True))
