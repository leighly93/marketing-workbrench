"""Read-only macOS production inventory; never loads .env or downloads models."""
import hashlib
import json
import platform
from pathlib import Path
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
    root = Path(__file__).resolve().parents[2]
    binary = root / '.cache/whisper-cpp/source/build/bin/whisper-cli'
    tools['whisper-cli'] = output([str(binary), '--version'])
    model = root / '.cache/whisper-cpp/ggml-base-q5_1.bin'
    model_hash = None
    if model.is_file():
        with model.open('rb') as stream:
            model_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'platform': platform.system(), 'architecture': platform.machine(),
            'macOS': platform.mac_ver()[0], 'tools': tools,
            'baseQ51ModelSHA256': model_hash}


if __name__ == '__main__':
    current = inventory()
    if '--check' in sys.argv:
        expected = json.loads(Path(__file__).with_name('native-observed.json').read_text())
        differences = [key for key in expected if expected[key] != current.get(key)]
        print('原生環境差異：' + (', '.join(differences) if differences else '符合觀測基準'))
        print('此檢查不執行 OCR／轉錄，不代表乾淨機還原或成品驗收。')
        sys.exit(1 if differences else 0)
    print(json.dumps(current, ensure_ascii=False, indent=2, sort_keys=True))
