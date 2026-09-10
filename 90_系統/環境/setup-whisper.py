"""Explicit macOS-only setup, isolated under repository .cache; no global install."""
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import tarfile
import urllib.request
import venv

root = Path(__file__).resolve().parents[2]
config = json.loads(Path(__file__).with_name('whisper-cpp.json').read_text())
cache = root / '.cache/whisper-cpp'


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def download(name, url, expected):
    target = cache / name
    if target.exists() and digest(target) == expected:
        return target
    temporary = cache / (name + '.download')
    try:
        urllib.request.urlretrieve(url, temporary)
        if digest(temporary) != expected:
            raise RuntimeError('SHA-256 mismatch: ' + name)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def main():
    if platform.system() != 'Darwin':
        raise RuntimeError('出片工具只支援 macOS；Linux 容器僅作開發測試')
    subprocess.run(['xcrun', '--find', 'clang'], check=True, stdout=subprocess.DEVNULL)
    cache.mkdir(parents=True, exist_ok=True)
    source_archive = download('source.tar.gz', config['sourceURL'], config['sourceSHA256'])
    download('ggml-base-q5_1.bin', config['modelURL'], config['modelSHA256'])
    source = cache / 'source'
    marker = source / '.workbench-commit'
    if source.exists():
        if not marker.exists() or marker.read_text() != config['commit']:
            raise RuntimeError('已有不同或未知原始碼，請保留後移開 .cache/whisper-cpp/source 再安裝')
    else:
        with tarfile.open(source_archive) as archive:
            archive.extractall(cache, filter='data')
        (cache / ('whisper.cpp-' + config['commit'])).rename(source)
        marker.write_text(config['commit'])
    tools = cache / 'build-tools'
    if not (tools / 'bin/python').exists():
        venv.create(tools, with_pip=True)
    subprocess.run([str(tools / 'bin/python'), '-m', 'pip', 'install', 'cmake==' + config['cmake']], check=True)
    cmake = str(tools / 'bin/cmake')
    subprocess.run([cmake, '-S', str(source), '-B', str(source / 'build'), '-DCMAKE_BUILD_TYPE=Release', '-DGGML_METAL=OFF', '-DWHISPER_COREML=OFF', '-DGGML_CUDA=OFF'], check=True)
    subprocess.run([cmake, '--build', str(source / 'build'), '--config', 'Release', '--target', 'whisper-cli', '-j', '4'], check=True)
    print('whisper-cli 與 Base Q5_1 已安裝於專案 .cache，未修改全機工具。')


if __name__ == '__main__':
    main()
