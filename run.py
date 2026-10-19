# 스파이폴 수업용 실행 파일 (Windows, Docker 없이). start.bat이 이 파일을 실행한다.
# 1) 인터넷 주소(cloudflared 터널)를 만들고  2) 게임 서버를 켜고  3) 선생님 화면을 브라우저로 연다.
# 이 창 하나만 닫으면 서버와 인터넷 주소가 같이 꺼진다.
# (.bat 파일에 한글을 넣으면 cmd가 잘못 읽어서, 실행 로직은 여기 파이썬에 둔다)
import atexit
import os
import re
import subprocess
import threading
import time
import urllib.request
import webbrowser

from spyfall import app, socketio
from spyfall.routes import lan_ip

PORT = int(os.getenv('PORT', '5001'))  # 코드네임(5000)과 동시에 켤 수 있게 5001
HERE = os.path.dirname(os.path.abspath(__file__))
CLOUDFLARED = os.path.join(HERE, '..', 'tools', 'cloudflared.exe')
DEV = os.getenv('SPYFALL_DEV') == '1'  # 개발 확인용: 터널·브라우저 없이 서버만
CLOUD = os.getenv('SPYFALL_CLOUD') == '1'  # Render 같은 인터넷 서버: 이미 고정 주소가 있으니 터널·브라우저 없이 서버만


def start_tunnel():
    """cloudflared로 인터넷 주소를 만든다. 성공하면 app.config['TUNNEL_URL']에 넣는다."""
    if not os.path.exists(CLOUDFLARED):
        print(f'  cloudflared.exe가 없어서 같은 와이파이에서만 접속할 수 있어요. ({CLOUDFLARED})', flush=True)
        return
    proc = subprocess.Popen(
        [CLOUDFLARED, 'tunnel', '--url', f'http://localhost:{PORT}', '--no-autoupdate'],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace')
    atexit.register(proc.terminate)
    deadline = time.time() + 40
    for line in proc.stdout:
        m = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)
        if m:
            app.config['TUNNEL_URL'] = m.group(0)
            break
        if time.time() > deadline:
            break
    # 남은 로그는 계속 읽어서 버린다 (안 읽으면 cloudflared가 멈춘다)
    threading.Thread(target=lambda: [None for _ in proc.stdout], daemon=True).start()


def wait_until_reachable(url: str, limit: int = 40):
    """새 인터넷 주소는 몇 초 지나야 접속된다. 실제로 열릴 때까지 기다린 뒤 선생님 화면을 연다."""
    for _ in range(limit):
        try:
            with urllib.request.urlopen(url + '/', timeout=5) as r:
                if r.status == 200:
                    return
        except Exception:  # 아직 주소가 퍼지지 않음
            pass
        time.sleep(1)


def startup():
    print('  인터넷 주소를 만드는 중... (최대 30초)', flush=True)
    start_tunnel()
    url = app.config.get('TUNNEL_URL')
    print()
    if url:
        wait_until_reachable(url)
        print(f'  학생 접속 주소 (와이파이/데이터 상관없음):  {url}')
    else:
        print('  인터넷 주소를 만들지 못했어요. 같은 와이파이에서만 접속할 수 있어요.')
        print(f'  학생 접속 주소 (같은 와이파이):  http://{lan_ip()}:{PORT}')
    print(f'  선생님 화면:  http://localhost:{PORT}/teacher')
    print('  끄려면 이 창을 닫으세요.', flush=True)
    print()
    if os.getenv('SPYFALL_NO_BROWSER') != '1':
        webbrowser.open(f'http://localhost:{PORT}/teacher')


if __name__ == '__main__':
    print()
    print('  스파이폴 영어 게임 서버를 켜는 중이에요.', flush=True)
    if not DEV and not CLOUD:
        threading.Thread(target=startup, daemon=True).start()
    socketio.run(app, host='0.0.0.0', port=PORT, allow_unsafe_werkzeug=True, log_output=DEV)
