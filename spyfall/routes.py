import io
import os
import random
import socket
from urllib.parse import quote, unquote

import qrcode
import qrcode.image.svg
from flask import render_template, redirect, url_for, request, Response

from . import app
from .game import MINUTE_OPTIONS, DEFAULT_MINUTES, PACK_OPTIONS, DEFAULT_PACK, get_game, create_game


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return '127.0.0.1'


def public_base_url() -> str:
    """학생이 접속할 주소. 인터넷 주소(run.py가 만든 터널)가 있으면 그것을, 없으면 같은 와이파이용 주소를 쓴다."""
    if os.getenv('PUBLIC_URL'):
        return os.getenv('PUBLIC_URL').rstrip('/')
    if app.config.get('TUNNEL_URL'):
        return app.config['TUNNEL_URL'].rstrip('/')
    host = request.host
    hostname, _, port = host.partition(':')
    if hostname in ('localhost', '127.0.0.1'):
        return f'http://{lan_ip()}' + (f':{port}' if port else '')
    scheme = request.headers.get('X-Forwarded-Proto', request.scheme)
    return f'{scheme}://{host}'


def join_url(name: str) -> str:
    return f'{public_base_url()}/g/{quote(name)}'


@app.route('/')
def home():
    code = request.args.get('code', '').strip()
    if code:
        return redirect(url_for('play', name=code))
    return render_template('home.html', error=request.args.get('error'))


@app.route('/teacher', methods=['GET', 'POST'])
def teacher_new():
    if request.method == 'POST':
        name = request.form.get('name', '').strip()[:20] or str(random.randint(1000, 9999))
        try:
            minutes = int(request.form.get('minutes', DEFAULT_MINUTES))
            pack = int(request.form.get('pack', DEFAULT_PACK))
        except ValueError:
            minutes, pack = DEFAULT_MINUTES, DEFAULT_PACK
        create_game(name, minutes, pack)
        return redirect(url_for('teacher_view', name=name))
    return render_template('teacher_new.html', minutes=MINUTE_OPTIONS, default_minutes=DEFAULT_MINUTES,
                           packs=PACK_OPTIONS, default_pack=DEFAULT_PACK, suggested=str(random.randint(1000, 9999)))


@app.route('/t/<name>')
def teacher_view(name):
    if not get_game(name):
        return redirect(url_for('teacher_new'))
    return render_template('teacher.html', name=name, join_url=unquote(join_url(name)),
                           minutes=MINUTE_OPTIONS, packs=PACK_OPTIONS)


@app.route('/g/<name>')
def play(name):
    if not get_game(name):
        return redirect(url_for('home', error=f'"{name}" 게임을 찾을 수 없어요. 코드를 확인해 주세요.'))
    return render_template('play.html', name=name)


@app.route('/qr/<name>.svg')
def qr(name):
    img = qrcode.make(join_url(name), image_factory=qrcode.image.svg.SvgPathImage, border=1)
    buf = io.BytesIO()
    img.save(buf)
    return Response(buf.getvalue(), mimetype='image/svg+xml', headers={'Cache-Control': 'no-store'})


@app.errorhandler(404)
def error_404(_):
    return redirect(url_for('home'))
