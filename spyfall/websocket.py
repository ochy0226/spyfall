# 실시간 통신. 학생은 pid(브라우저에 저장된 고유값)로 구분해서, 휴대폰 화면이 꺼졌다 켜져도 자동으로 다시 들어온다.
import threading
import time

from flask import request
from flask_socketio import join_room

from . import socketio
from .game import get_game, games

conns = {}  # sid -> {'game': 이름, 'pid': 학생 pid 또는 None, 'teacher': bool, 'host': 선생님 열쇠가 맞는지}


def broadcast(game):
    """같은 게임의 모든 화면에 상태를 보낸다. 학생마다 자기 역할 카드만 들어 있다."""
    for sid, c in list(conns.items()):
        if c['game'] != game.name:
            continue
        socketio.emit('state', game.state(me=c['pid'], teacher=c['teacher'], host=c.get('host', False)), to=sid)


def _current():
    c = conns.get(request.sid)
    if not c:
        return None, None
    return c, get_game(c['game'])


def _set_online(game, pid, delta):
    p = game.players.get(pid)
    if p:
        p['online'] = max(0, p['online'] + delta)


@socketio.on('watch')
def watch(data):
    """선생님 중계 화면 접속. 게임을 만든 화면의 열쇠(key)가 맞아야 버튼을 쓰고 정답을 볼 수 있다."""
    data = data or {}
    game = get_game(data.get('game'))
    if not game:
        return {'error': 'nogame'}
    host = data.get('key') == game.teacher_key
    conns[request.sid] = {'game': game.name, 'pid': None, 'teacher': True, 'host': host}
    join_room(game.name)
    socketio.emit('state', game.state(teacher=True, host=host), to=request.sid)
    return {'ok': True, 'host': host}


@socketio.on('hello')
def hello(data):
    """학생 화면 접속. 이미 들어와 있던 학생이면 그대로 복귀."""
    data = data or {}
    game = get_game(data.get('game'))
    if not game:
        return {'error': 'nogame'}
    pid = str(data.get('pid') or '')[:64]
    conns[request.sid] = {'game': game.name, 'pid': pid, 'teacher': False}
    join_room(game.name)
    if pid in game.players:
        _set_online(game, pid, +1)
        broadcast(game)
        return {'ok': True, 'joined': True}
    socketio.emit('state', game.state(me=pid), to=request.sid)
    return {'ok': True, 'joined': False}


def _player_action(fn):
    """학생 동작 공통 처리: 게임 찾기 → 실행 → 오류면 알려주고, 성공하면 모두에게 새 상태."""
    c, game = _current()
    if not game or c['teacher']:
        return {'error': '게임을 찾을 수 없어요. 새로고침 해 주세요.'}
    err = fn(game, c['pid'])
    if err:
        return {'error': err}
    broadcast(game)
    return {'ok': True}


@socketio.on('join')
def join(data):
    return _player_action(lambda g, pid: g.join(pid, (data or {}).get('name')))


@socketio.on('ask')
def ask(data):
    return _player_action(lambda g, pid: g.ask(pid, (data or {}).get('id')))


@socketio.on('unpick')
def unpick(*_):
    return _player_action(lambda g, pid: g.unpick(pid))


@socketio.on('answered')
def answered(*_):
    return _player_action(lambda g, pid: g.answered(pid))


@socketio.on('accuse')
def accuse(data):
    return _player_action(lambda g, pid: g.accuse(pid, (data or {}).get('id')))


@socketio.on('accuse_vote')
def accuse_vote(data):
    return _player_action(lambda g, pid: g.accuse_vote(pid, bool((data or {}).get('agree'))))


@socketio.on('guess')
def guess(data):
    return _player_action(lambda g, pid: g.spy_guess(pid, (data or {}).get('location')))


@socketio.on('vote')
def vote(data):
    return _player_action(lambda g, pid: g.vote(pid, (data or {}).get('id')))


@socketio.on('teacher')
def teacher(data):
    """선생님 화면의 버튼: 시작, 설정, 질문자 지정, 투표 시작, 시간 멈춤, 새 판, 내보내기."""
    c, game = _current()
    if not game or not c['teacher']:
        return {'error': '선생님 화면에서만 할 수 있어요.'}
    if not c.get('host'):
        return {'error': '게임을 만든 선생님 화면에서만 바꿀 수 있어요. (보기 전용 화면)'}
    data = data or {}
    action = data.get('action')
    err = None
    if action == 'start':
        err = game.start()
    elif action == 'options':
        try:
            err = game.set_options(data.get('minutes'), data.get('pack'), data.get('spies'))
        except (TypeError, ValueError):
            err = '설정 값을 다시 골라 주세요.'
    elif action == 'reshuffle':
        err = game.reshuffle()
    elif action == 'asker':
        err = game.set_asker(data.get('pid'))
    elif action == 'vote':
        err = game.start_vote()
    elif action == 'pause':
        err = game.toggle_pause()
    elif action == 'toggle_meaning':
        game.show_meaning = not game.show_meaning
    elif action == 'new_round':
        game.new_round()
    elif action == 'reset_scores':
        game.reset_scores()
    elif action == 'kick':
        pid = data.get('pid')
        if pid in game.players:
            game.kick(pid)
            for sid, cc in list(conns.items()):
                if cc['game'] == game.name and cc['pid'] == pid:
                    socketio.emit('kicked', {'msg': '선생님이 다시 들어오라고 했어요.'}, to=sid)
    else:
        err = '알 수 없는 동작이에요.'
    if err:
        return {'error': err}
    broadcast(game)
    return {'ok': True}


@socketio.on('disconnect')
def disconnect(*_):
    c = conns.pop(request.sid, None)
    if not c:
        return
    game = get_game(c['game'])
    if game and c['pid']:
        _set_online(game, c['pid'], -1)
        broadcast(game)


def _timer_loop():
    """0.5초마다 모든 게임의 제한시간을 확인해서, 시간이 지나면 다음 단계로 넘기고 화면을 갱신한다."""
    while True:
        time.sleep(0.5)
        for game in list(games.values()):
            try:
                if game.check_timeout():
                    broadcast(game)
            except Exception as e:  # 한 게임의 오류로 타이머 전체가 멈추지 않게
                print('timer error:', e, flush=True)


threading.Thread(target=_timer_loop, daemon=True).start()
