# 스파이폴 게임 상태와 규칙. 서버를 끄면 사라지는 메모리 저장 방식 (수업 한 시간 용도라 DB 불필요).
# 반 전체가 한 게임: 모두 같은 장소를 받고, 스파이만 장소를 모른다.
# 질문 차례: 질문자가 휴대폰에서 친구를 고르고 말로 질문 → 대답한 친구가 "답변했어요"를 누르면 다음 질문자가 된다.
# 누구나 한 판에 한 번 "지목 투표"를 열 수 있고, 판이 끝나면 점수가 쌓인다 (선생님 화면 랭킹).
import math
import os
import random
import re
import secrets
import threading
import time

from . import app

MAX_NAME = 12
MIN_PLAYERS = 3
MINUTE_OPTIONS = (5, 7, 10)
DEFAULT_MINUTES = 7
VOTE_SECONDS = 45         # 투표 제한시간
LAST_CHANCE_SECONDS = 40  # 잡힌 스파이가 장소를 맞히는 제한시간 (선생님 화면 공개 연출 시간 포함)
PACK_OPTIONS = {12: '12곳', 20: '20곳', 0: '전체'}  # 이번 판 장소 후보 개수 (0 = 전체)
DEFAULT_PACK = 12
MAX_SPIES = 3
ACCUSE_SECONDS = 25       # 지목 투표 제한시간 (그동안 질문 시간은 멈춘다)

# 점수표 (판이 끝나면 누적, 선생님 화면 랭킹에 표시)
POINTS = {
    'spy_hidden': 4,    # 스파이: 판이 끝날 때까지 안 들킴
    'spy_guess': 3,     # 스파이: 질문 시간에 장소를 맞힘 (+ 빨리 맞힌 보너스 1~3)
    'spy_last': 3,      # 스파이: 투표로 잡혔지만 마지막 기회에 장소를 맞힘
    'vote_spy': 2,      # 시민: 시간이 끝난 뒤 투표에서 스파이를 고름
    'accuse_spy': 2,    # 시민: 지목 투표로 스파이를 잡을 때 찬성함 (+ 빨리 잡은 보너스 1~3)
    'accuser': 1,       # 시민: 그 지목 투표를 처음 연 사람 추가 점수
    'citizen_win': 1,   # 시민: 시민 팀 승리
}

# 질문·대답 예시 (한글). 질문하는 학생 휴대폰과 선생님 화면에 몇 개씩 보여준다.
QUESTIONS = [
    '여기서 보통 뭘 입어?', '여기 자주 와?', '여기 시끄러워?', '여기선 돈이 필요해?', '여기 보통 누구랑 와?',
    '보통 몇 시에 와?', '실내야, 실외야?', '여기 있으면 기분이 어때?', '여기서 음식을 먹을 수 있어?', '여기 안전해?',
    '여기서 아이들을 볼 수 있어?', '여기 얼마나 오래 있어?', '여기서 무슨 소리가 들려?', '표가 필요해?',
    '여기 더워, 추워?', '여기 반려동물을 데려올 거야?', '여기 사람들은 열심히 일해?', '여기는 커, 작아?',
    '여기서 잘 수 있어?', '여기 뭐가 좋아?', '집에서 멀어?', '여기선 특별한 옷이 필요해?',
    '여기 냄새는 어때?', '여기 가면 사진 찍어?', '어른이랑 같이 가야 해?', '여기 일하는 사람이 많아?',
]
ANSWERS = ['응 / 아니', '가끔', '상황에 따라 달라', '그런 편이야', '글쎄...', '당연하지!', '그건 비밀이야~', '사람마다 달라']

_locations = None


def load_locations() -> list:
    """data/locations.txt -> [{'name', 'meaning', 'icon', 'roles': [{'name', 'meaning'}]}]"""
    global _locations
    if _locations is not None:
        return _locations
    locs = []
    with open(os.path.join(app.root_path, 'data', 'locations.txt'), encoding='utf-8') as f:
        for raw in f:
            line = raw.rstrip('\r\n')
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            en, _, rest = line.strip().partition('=')
            ko, _, icon = rest.partition('=')
            item = {'name': en.strip(), 'meaning': ko.strip()}
            if line[0] in ' \t':
                if locs:
                    locs[-1]['roles'].append(item)
            else:
                locs.append(dict(item, icon=icon.strip() or '📍', roles=[]))
    _locations = [loc for loc in locs if len(loc['roles']) >= 4]
    # 장소 그림: static/img/places/<이름>.webp (작은 그림은 thumb/ 안에). 없으면 이모지만 쓴다.
    for loc in _locations:
        slug = re.sub(r'[^a-z0-9]+', '-', loc['name'].lower()).strip('-')
        has = os.path.exists(os.path.join(app.root_path, 'static', 'img', 'places', f'{slug}.webp'))
        loc['img'] = f'/static/img/places/{slug}.webp' if has else None
        loc['thumb'] = f'/static/img/places/thumb/{slug}.webp' if has else None
    return _locations


def loc_pub(loc) -> dict:
    """화면에 보낼 장소 정보 (역할 목록 제외)."""
    return {'name': loc['name'], 'meaning': loc['meaning'], 'icon': loc['icon'], 'img': loc.get('img'), 'thumb': loc.get('thumb')}


def auto_spies(n: int) -> int:
    """참가 인원에 맞는 스파이 수: 8명까지 1명, 9명 이상 2명 (보통 4~11명이 한다)."""
    return 1 if n <= 8 else 2


def speed_bonus(left, limit) -> int:
    """질문 시간이 많이 남았을수록 큰 보너스: 2/3 넘게 남음 +3, 1/3 넘게 +2, 그 외 +1."""
    if not left or not limit:
        return 1
    f = left / limit
    return 3 if f >= 2 / 3 else 2 if f >= 1 / 3 else 1


class Game:
    def __init__(self, name: str, minutes: int = DEFAULT_MINUTES, pack: int = DEFAULT_PACK):
        self.name = name
        self.lock = threading.RLock()
        self.teacher_key = secrets.token_urlsafe(9)  # 이 값을 가진 화면만 선생님 버튼·정답 보기 가능
        self.players = {}  # pid -> {'id', 'name', 'online', 'spied'(스파이 해 본 횟수), 'score'(누적 점수)}
        self.next_id = 1
        self.round = 0
        self.minutes = minutes if minutes in MINUTE_OPTIONS else DEFAULT_MINUTES
        self.pack = pack if pack in PACK_OPTIONS else DEFAULT_PACK
        self.spy_setting = 0  # 0 = 인원에 맞춰 자동
        self.show_meaning = True
        self.event_seq = 0
        self.new_round()

    # ---------- 판 관리 ----------
    def new_round(self):
        with self.lock:
            self.round += 1
            self.phase = 'lobby'  # lobby -> play -> vote -> (last) -> over
            self._pick_candidates()
            self.location = None
            self.roles = {}       # pid -> {'spy': bool, 'role': {'name','meaning'} 또는 None}
            self.spies = []
            self.out = set()      # 정체가 드러난 스파이 (장소를 틀림 / 지목 투표로 잡힘)
            self.accused_out = set()  # 그중 지목 투표로 잡힌 스파이
            self.turn = None      # {'asker', 'from', 'target', 'stage'('choose'|'answer'), 'seq', 'q', 'seed'}
            self.history = []     # [{'asker', 'target'}] (pid)
            self.asked = {}       # pid -> 이번 판에 질문 받은 횟수
            self.deadline = None
            self.paused_left = None
            self.time_limit = 0
            self.accusing = None    # 진행 중인 지목 투표 {'by', 'target', 'votes': {pid: bool}, 'deadline', 'seq'}
            self.accused_by = set()  # 이번 판에 지목 투표를 이미 연 학생 (한 판에 한 번)
            self.accuse_log = []  # [{'seq', 'by', 'target', 'result'('fail'|'spy'|'citizen'), 'opposed', 'timeout'}]
            self.play_left = None  # 지목 투표 동안 멈춰 둔 질문 시간
            self.votes = {}
            self.vote_n = 0
            self.tally = []
            self.caught = []
            self.last_guesses = {}
            self.events = []      # 스파이 추측 기록 [{'seq', 'pid', 'guess', 'correct', 'when'('play'|'last')}]
            self.points = []      # 이번 판에 받은 점수 [{'pid', 'pts', 'why'}]
            self.winner = None
            self.win_reason = None
            self.log = []
            self.timeouts = getattr(self, 'timeouts', 0)
            self._log(f'{self.round}번째 판 준비! QR로 들어온 뒤 선생님이 시작해요.')

    def _pick_candidates(self):
        locs = load_locations()
        n = self.pack if self.pack and self.pack < len(locs) else len(locs)
        self.candidates = sorted(random.sample(locs, n), key=lambda x: x['name'])

    def set_options(self, minutes=None, pack=None, spies=None) -> str:
        with self.lock:
            if self.phase != 'lobby':
                return '설정은 게임 시작 전(대기 화면)에만 바꿀 수 있어요.'
            if minutes is not None:
                if int(minutes) not in MINUTE_OPTIONS:
                    return '시간을 다시 골라 주세요.'
                self.minutes = int(minutes)
            if pack is not None:
                if int(pack) not in PACK_OPTIONS:
                    return '장소 개수를 다시 골라 주세요.'
                self.pack = int(pack)
                self._pick_candidates()
            if spies is not None:
                spies = int(spies)
                if not 0 <= spies <= MAX_SPIES:
                    return '스파이 수를 다시 골라 주세요.'
                self.spy_setting = spies
        return None

    def reshuffle(self) -> str:
        with self.lock:
            if self.phase != 'lobby':
                return '게임 시작 전에만 장소 후보를 바꿀 수 있어요.'
            self._pick_candidates()
        return None

    def reset_scores(self):
        with self.lock:
            for p in self.players.values():
                p['score'] = 0
            self.points = []
            self._log('선생님이 점수를 모두 0점으로 바꿨어요.')

    def spy_count(self) -> int:
        if self.phase != 'lobby':
            return len(self.spies)
        n = len(self.players)
        want = self.spy_setting or auto_spies(n)
        # 시민이 스파이보다 최소 2명은 많아야 게임이 된다
        return max(1, min(want, (n - 1) // 2)) if n >= MIN_PLAYERS else want

    def start(self) -> str:
        with self.lock:
            if self.phase != 'lobby':
                return '이미 시작했어요.'
            pids = list(self.players)
            if len(pids) < MIN_PLAYERS:
                return f'최소 {MIN_PLAYERS}명이 들어와야 시작할 수 있어요.'
            k = self.spy_count()
            # 스파이를 덜 해 본 학생이 먼저 뽑힌다 (같으면 랜덤)
            random.shuffle(pids)
            pids.sort(key=lambda p: self.players[p].get('spied', 0))
            self.spies = pids[:k]
            for p in self.spies:
                self.players[p]['spied'] = self.players[p].get('spied', 0) + 1
            self.location = random.choice(self.candidates)
            self.role_bag = []
            for pid in self.players:
                self._deal(pid)
            self.phase = 'play'
            self._set_timer(self.minutes * 60)
            self._new_turn(self._random_asker())
            self._log(f'게임 시작! 스파이 {k}명이 숨어 있어요. 첫 질문은 {self._nm(self.turn["asker"])}.')
        return None

    def _deal(self, pid):
        """역할 카드 나눠주기. 시민은 장소의 역할을 골고루 돌려가며 받는다."""
        if pid in self.spies:
            self.roles[pid] = {'spy': True, 'role': None}
            return
        if not self.role_bag:
            self.role_bag = random.sample(self.location['roles'], len(self.location['roles']))
        self.roles[pid] = {'spy': False, 'role': self.role_bag.pop()}

    # ---------- 참가자 ----------
    def join(self, pid: str, name: str) -> str:
        name = (name or '').strip()[:MAX_NAME]
        if not pid:
            return '다시 접속해 주세요.'
        if not name:
            return '이름을 입력해 주세요.'
        with self.lock:
            for other_pid, p in self.players.items():
                if other_pid != pid and p['name'] == name:
                    return '같은 이름이 이미 있어요. 다른 이름을 써 주세요. (예: 김민수2)'
            p = self.players.get(pid)
            if p:
                p['name'] = name
            else:
                self.players[pid] = {'id': self.next_id, 'name': name, 'online': 1, 'spied': 0, 'score': 0}
                self.next_id += 1
                # 게임 도중 들어온 학생은 시민으로 참가 (투표·결과 단계면 다음 판부터)
                if self.phase == 'play':
                    self._deal(pid)
                    self._log(f'{name} 학생이 중간에 들어왔어요.')
        return None

    def kick(self, pid):
        with self.lock:
            if pid not in self.players:
                return
            a = self.accusing
            del self.players[pid]
            self.roles.pop(pid, None)
            self.votes.pop(pid, None)
            for k, v in list(self.votes.items()):
                if v == pid:
                    del self.votes[k]
            if self.phase != 'play':
                return
            if a and pid in (a['target'], a['by']):
                self._accuse_end(False)
            if pid in self.spies:
                self.out.add(pid)  # 나간 스파이는 더 이상 게임에 영향을 주지 않는다
                if self._check_all_spies_out():
                    return
            self._fix_turn(pid)
            if self.accusing:
                self._accuse_check()

    def _fix_turn(self, pid):
        """pid가 나가거나 정체가 드러났을 때 질문 차례가 멈추지 않게 정리한다."""
        t = self.turn
        if not t:
            return
        if t['asker'] == pid:
            self._new_turn(self._random_asker())
        elif t.get('target') == pid:
            self._new_turn(t['asker'], t.get('from'))  # 질문자가 다른 친구를 다시 고른다
        elif t.get('from') == pid:
            t['from'] = None

    def _active(self):
        """이번 판에 역할을 받고 아직 정체가 드러나지 않은 학생 (질문·투표 대상)."""
        return [pid for pid in self.roles if pid in self.players and pid not in self.out]

    def _new_turn(self, asker, frm=None):
        """질문 차례를 asker에게 (친구 고르기 단계). seq가 바뀌면 선생님 화면이 새 연출을 보여준다."""
        self.event_seq += 1
        self.turn = {'asker': asker, 'from': frm, 'target': None, 'stage': 'choose',
                     'seq': self.event_seq, 'q': random.randrange(len(QUESTIONS)), 'seed': random.random()}
        return self.turn

    def _random_asker(self, exclude=None):
        pool = [p for p in self._active() if p != exclude and self.players[p]['online'] > 0] \
            or [p for p in self._active() if p != exclude]
        if not pool:
            return None
        # 질문을 덜 받은 학생이 먼저
        low = min(self.asked.get(p, 0) for p in pool)
        return random.choice([p for p in pool if self.asked.get(p, 0) == low])

    # ---------- 질문 차례 ----------
    # 1) 질문자가 친구를 고르고 바로 말로 질문 (choose → answer)
    # 2) 질문 받은 친구가 대답하고 "답변했어요" → 그 친구가 다음 질문자(choose)
    def _turn_check(self, pid, stage, who='asker'):
        if self.phase != 'play':
            return '지금은 질문 시간이 아니에요.'
        if self.accusing:
            return '지목 투표가 끝날 때까지 기다려 주세요.'
        if self.paused_left is not None:
            return '선생님이 시간을 멈췄어요.'
        t = self.turn
        if not t or t.get(who) != pid or t['stage'] not in stage:
            return '지금은 내 차례가 아니에요.'
        return None

    def ask(self, pid, target_id) -> str:
        """질문할 친구 고르기 = 그 친구에게 질문 시작."""
        with self.lock:
            err = self._turn_check(pid, ('choose',))
            if err:
                return err
            target = self.pid_of(target_id)
            active = self._active()
            if not target or target not in active or target == pid:
                return '그 친구에게는 질문할 수 없어요.'
            if target == self.turn.get('from') and len(active) > 2:
                return '방금 나에게 질문한 친구에게는 다시 질문할 수 없어요.'
            self.history.append({'asker': pid, 'target': target})
            self.asked[target] = self.asked.get(target, 0) + 1
            self.event_seq += 1
            self.turn.update(target=target, stage='answer', seq=self.event_seq)
        return None

    def unpick(self, pid) -> str:
        """잘못 골랐을 때 (상대가 대답하기 전) 다시 고르기."""
        with self.lock:
            err = self._turn_check(pid, ('answer',))
            if err:
                return err
            target = self.turn['target']
            if self.history and self.history[-1] == {'asker': pid, 'target': target}:
                self.history.pop()
                self.asked[target] = max(0, self.asked.get(target, 1) - 1)
            self.turn.update(target=None, stage='choose')
        return None

    def answered(self, pid) -> str:
        """질문 받은 친구가 "답변했어요"를 눌렀다 → 그 친구가 다음 질문자."""
        with self.lock:
            err = self._turn_check(pid, ('answer',), who='target')
            if err:
                return err
            self._new_turn(pid, self.turn['asker'])
        return None

    def set_asker(self, pid=None) -> str:
        """선생님이 질문자를 지정 (pid 없으면 랜덤). 막혔을 때 쓰는 버튼."""
        with self.lock:
            if self.phase != 'play':
                return '게임 중에만 할 수 있어요.'
            if self.accusing:
                return '지목 투표가 끝난 뒤에 바꿔 주세요.'
            if pid is None:
                pid = self._random_asker(exclude=self.turn and self.turn['asker'])
            if pid not in self._active():
                return '이 학생은 지금 질문할 수 없어요.'
            self._new_turn(pid)
            self._log(f'선생님이 질문자를 {self._nm(pid)}(으)로 바꿨어요.')
        return None

    # ---------- 지목 투표 (원작 규칙: 누구나 한 판에 한 번, 지목당한 사람 빼고 모두 찬성해야 성공) ----------
    def accuse(self, pid, target_id) -> str:
        with self.lock:
            if self.phase != 'play':
                return '질문 시간에만 지목할 수 있어요.'
            if self.accusing:
                return '이미 지목 투표가 진행 중이에요.'
            if self.paused_left is not None:
                return '선생님이 시간을 멈췄어요.'
            active = self._active()
            if pid not in active:
                return '이번 판에는 지목할 수 없어요.'
            if pid in self.accused_by:
                return '지목은 한 판에 한 번만 할 수 있어요.'
            target = self.pid_of(target_id)
            if not target or target not in active or target == pid:
                return '그 친구는 지목할 수 없어요.'
            self.accused_by.add(pid)
            self.play_left = self.time_left()
            self.deadline = None  # 지목 투표 동안 질문 시간은 멈춘다
            self.event_seq += 1
            self.accusing = {'by': pid, 'target': target, 'votes': {pid: True},
                           'deadline': time.time() + ACCUSE_SECONDS, 'seq': self.event_seq}
            self._log(f'🚨 {self._nm(pid)}이(가) {self._nm(target)}을(를) 스파이로 지목했어요!')
            self._accuse_check()
        return None

    def _accuse_voters(self):
        a = self.accusing
        return [p for p in self._active() if p != a['target'] and (self.players[p]['online'] > 0 or p == a['by'])]

    def accuse_vote(self, pid, agree) -> str:
        with self.lock:
            a = self.accusing
            if self.phase != 'play' or not a:
                return '지금은 지목 투표 중이 아니에요.'
            if pid == a['target']:
                return '지목당한 사람은 투표할 수 없어요.'
            if pid not in self._active():
                return '이번 판에는 투표할 수 없어요.'
            if pid in a['votes']:
                return '이미 투표했어요.'
            a['votes'][pid] = bool(agree)
            if not agree:
                self._accuse_end(False)
            else:
                self._accuse_check()
        return None

    def _accuse_check(self):
        a = self.accusing
        if a and all(a['votes'].get(p) for p in self._accuse_voters()):
            self._accuse_end(True)

    def _accuse_end(self, success, timeout=False):
        a = self.accusing
        self.accusing = None
        target = a['target']
        opposed = [p for p, v in a['votes'].items() if v is False]
        result = 'fail' if not success else ('spy' if target in self.spies else 'citizen')
        self.event_seq += 1
        self.accuse_log.append({'seq': self.event_seq, 'by': a['by'], 'target': target, 'result': result,
                                'opposed': opposed, 'timeout': timeout})
        if result == 'citizen':
            self._finish('spy', f'{self._nm(target)}은(는) 시민이었어요! 엉뚱한 사람을 지목해서 스파이 승리!')
            return
        if result == 'spy':
            bonus = speed_bonus(self.play_left, self.time_limit)
            for p, v in a['votes'].items():
                if v and p in self.players and p not in self.spies:
                    self._award(p, POINTS['accuse_spy'] + bonus, f'지목 투표로 스파이를 잡음 (빨리 잡은 보너스 +{bonus})')
            if a['by'] not in self.spies:
                self._award(a['by'], POINTS['accuser'], '스파이를 처음 지목함')
            self.out.add(target)
            self.accused_out.add(target)
            self._log(f'🎯 지목 성공! {self._nm(target)}은(는) 스파이였어요!')
            if self._check_all_spies_out():
                return
            self._fix_turn(target)
        else:
            why = '시간 안에 모두 찬성하지 않았어요' if timeout else f'{", ".join(self._nm(p) for p in opposed)} 반대'
            self._log(f'지목 투표 무산 ({why}). 질문을 계속해요.')
        # 멈춰 둔 질문 시간을 다시 흐르게
        self.deadline = time.time() + (self.play_left or 0)
        self.play_left = None

    # ---------- 스파이의 장소 추측 ----------
    def spy_guess(self, pid, loc_name) -> str:
        with self.lock:
            loc = next((c for c in self.candidates if c['name'] == loc_name), None)
            if not loc:
                return '장소를 다시 골라 주세요.'
            if self.phase == 'play':
                if pid not in self.spies or pid in self.out:
                    return '스파이만 장소를 맞힐 수 있어요.'
                if self.accusing:
                    return '지목 투표가 끝난 뒤에 맞힐 수 있어요.'
                if self.paused_left is not None:
                    return '선생님이 시간을 멈췄어요.'
                correct = loc is self.location
                self._event(pid, loc_name, correct, 'play')
                if correct:
                    bonus = speed_bonus(self.time_left(), self.time_limit)
                    self._award(pid, POINTS['spy_guess'] + bonus, f'질문 시간에 장소를 맞힘 (빨리 맞힌 보너스 +{bonus})')
                    self._finish('spy', f'스파이 {self._nm(pid)}이(가) 장소를 맞혔어요!')
                else:
                    self.out.add(pid)
                    self._log(f'스파이 {self._nm(pid)}이(가) "{loc_name}"(이)라고 추측했지만 틀렸어요!')
                    if not self._check_all_spies_out():
                        self._fix_turn(pid)
                return None
            if self.phase == 'last':
                if pid not in self.caught or pid not in self.spies:
                    return '잡힌 스파이만 마지막 추측을 할 수 있어요.'
                if pid in self.last_guesses:
                    return '이미 추측했어요.'
                self.last_guesses[pid] = loc_name
                self._event(pid, loc_name, loc is self.location, 'last')
                if len(self.last_guesses) >= len([p for p in self.caught if p in self.spies and p in self.players]):
                    self._resolve()
                return None
            return '지금은 장소를 맞힐 수 없어요.'

    def _check_all_spies_out(self) -> bool:
        if self.phase == 'play' and all(p in self.out for p in self.spies):
            self._finish('citizen', '스파이를 모두 찾아냈어요!' if self.accused_out else '스파이가 모두 장소를 틀려서 정체가 드러났어요!')
            return True
        return False

    def _event(self, pid, guess, correct, when):
        self.event_seq += 1
        self.events.append({'seq': self.event_seq, 'pid': pid, 'guess': guess, 'correct': correct, 'when': when})

    # ---------- 시간이 끝난 뒤 투표 ----------
    def start_vote(self, by_timeout=False) -> str:
        with self.lock:
            if self.phase != 'play':
                return '게임 중에만 투표를 시작할 수 있어요.'
            if self.accusing:
                return '지목 투표가 끝난 뒤에 시작해 주세요.'
            self.phase = 'vote'
            self.votes = {}
            self.vote_n = len([p for p in self.spies if p not in self.out])
            self.turn = None
            self._set_timer(VOTE_SECONDS)
            self._log('⏰ 시간 끝! 투표를 시작해요.' if by_timeout else '선생님이 투표를 시작했어요.')
        return None

    def vote(self, pid, target_id) -> str:
        with self.lock:
            if self.phase != 'vote':
                return '지금은 투표 시간이 아니에요.'
            active = self._active()
            if pid not in active:
                return '이번 판에는 투표할 수 없어요.'
            target = self.pid_of(target_id)
            if not target or target not in active or target == pid:
                return '그 친구에게는 투표할 수 없어요.'
            self.votes[pid] = target
            voters = [p for p in active if self.players[p]['online'] > 0]
            if all(p in self.votes for p in voters):
                self._finish_vote()
        return None

    def _finish_vote(self):
        count = {}
        for t in self.votes.values():
            if t in self.players:
                count[t] = count.get(t, 0) + 1
        order = list(count)
        random.shuffle(order)  # 동표는 랜덤
        order.sort(key=lambda p: -count[p])
        self.tally = [{'pid': p, 'votes': count[p]} for p in order]
        self.caught = order[:self.vote_n]
        caught_spies = [p for p in self.caught if p in self.spies]
        names = ', '.join(self._nm(p) for p in self.caught) or '없음'
        self._log(f'투표 결과: {names}')
        if caught_spies:
            self.phase = 'last'
            self.last_guesses = {}
            self._set_timer(LAST_CHANCE_SECONDS)
        else:
            self._resolve()

    def _resolve(self):
        # 투표에서 스파이를 고른 시민에게 점수
        for voter, target in self.votes.items():
            if voter in self.players and voter not in self.spies and target in self.spies:
                self._award(voter, POINTS['vote_spy'], '투표에서 스파이를 골라냄')
        caught_spies = [p for p in self.caught if p in self.spies]
        lucky = [p for p in caught_spies if self.last_guesses.get(p) == self.location['name']]
        need = math.ceil(self.vote_n / 2) if self.vote_n else 1
        for p in lucky:
            self._award(p, POINTS['spy_last'], '잡혔지만 마지막 기회에 장소를 맞힘')
        if lucky:
            self._finish('spy', f'잡혔지만 {self._nm(lucky[0])}이(가) 장소를 맞혀서 스파이 역전승!')
        elif len(caught_spies) >= need:
            self._finish('citizen', f'스파이 {", ".join(self._nm(p) for p in caught_spies)}을(를) 찾아냈어요!')
        elif caught_spies:
            self._finish('spy', f'스파이 {len(caught_spies)}명만 잡혔어요. (절반 이상 잡아야 시민 승리)')
        else:
            names = ', '.join(self._nm(p) for p in self.spies if p not in self.out)
            self._finish('spy', f'진짜 스파이 {names}을(를) 찾지 못했어요!')

    def _finish(self, winner, reason):
        if self.phase == 'over':
            return
        self.phase = 'over'
        self.winner = winner
        self.win_reason = reason
        self.deadline = None
        self.paused_left = None
        self.accusing = None
        self.turn = None
        guessed = {e['pid'] for e in self.events if e['correct']}
        for p in self.spies:  # 판이 끝날 때까지 정체가 안 드러난 스파이
            if p not in self.out and p not in self.caught and p not in guessed:
                self._award(p, POINTS['spy_hidden'], '끝까지 안 들킴')
        if winner == 'citizen':
            for p, r in self.roles.items():
                if not r['spy']:
                    self._award(p, POINTS['citizen_win'], '시민 팀 승리')
        self._log(('🕵️ 스파이 승리! ' if winner == 'spy' else '🎉 시민 승리! ') + reason)

    def _award(self, pid, pts, why):
        p = self.players.get(pid)
        if p and pts:
            p['score'] = p.get('score', 0) + pts
            self.points.append({'pid': pid, 'pts': pts, 'why': why})

    # ---------- 제한시간 ----------
    def _set_timer(self, seconds):
        self.time_limit = seconds
        self.deadline = time.time() + seconds
        self.paused_left = None

    def time_left(self):
        if self.paused_left is not None:
            return self.paused_left
        if self.deadline is None:
            return None
        return max(0.0, self.deadline - time.time())

    def toggle_pause(self) -> str:
        with self.lock:
            if self.phase not in ('play', 'vote', 'last'):
                return '지금은 시간을 멈출 수 없어요.'
            if self.accusing:
                return '지목 투표 중에는 시간이 이미 멈춰 있어요.'
            if self.paused_left is None:
                self.paused_left = self.time_left()
                self.deadline = None
                self._log('⏸ 선생님이 시간을 멈췄어요.')
            else:
                self.deadline = time.time() + self.paused_left
                self.paused_left = None
                self._log('▶ 시간이 다시 흘러요.')
        return None

    def check_timeout(self) -> bool:
        with self.lock:
            if self.accusing:
                if time.time() >= self.accusing['deadline']:
                    self._accuse_end(False, timeout=True)
                    return True
                return False
            if self.deadline is None or time.time() < self.deadline:
                return False
            self.timeouts += 1
            if self.phase == 'play':
                self.start_vote(by_timeout=True)
            elif self.phase == 'vote':
                self._finish_vote()
            elif self.phase == 'last':
                self._resolve()
            else:
                self.deadline = None
            return True

    # ---------- 화면에 보낼 상태 ----------
    def pid_of(self, pid_id):
        try:
            pid_id = int(pid_id)
        except (TypeError, ValueError):
            return None
        return next((pid for pid, p in self.players.items() if p['id'] == pid_id), None)

    def _nm(self, pid):
        p = self.players.get(pid)
        return p['name'] if p else '(나간 학생)'

    def _log(self, text):
        self.log.append({'time': time.strftime('%H:%M:%S'), 'text': text})
        self.log = self.log[-60:]

    def _pub(self, pid):
        """다른 사람에게 보여도 되는 학생 정보 (pid는 숨기고 번호만)."""
        p = self.players.get(pid)
        return {'id': p['id'], 'name': p['name']} if p else {'id': None, 'name': '(나간 학생)'}

    def state(self, me=None, teacher=False, host=False) -> dict:
        with self.lock:
            over = self.phase == 'over'
            reveal = self.phase in ('last', 'over')  # 투표로 잡힌 학생의 정체 공개
            gains = {}
            for pt in self.points:
                gains[pt['pid']] = gains.get(pt['pid'], 0) + pt['pts']
            players = []
            for pid, p in self.players.items():
                r = self.roles.get(pid)
                item = {
                    'id': p['id'], 'name': p['name'], 'online': p['online'] > 0,
                    'inRound': r is not None, 'out': pid in self.out,
                    'asked': self.asked.get(pid, 0),
                    'voted': self.phase == 'vote' and pid in self.votes,
                    'score': p.get('score', 0), 'gain': gains.get(pid, 0),
                }
                if pid in self.out or (reveal and pid in self.caught) or over:
                    item['spy'] = bool(r and r['spy'])
                if over and r:
                    item['role'] = r['role']
                if teacher:
                    item['pid'] = pid
                players.append(item)
            players.sort(key=lambda x: x['id'])

            turn = None
            if self.turn and self.turn.get('asker'):
                t = self.turn
                turn = {'asker': self._pub(t['asker']),
                        'from': self._pub(t['from']) if t.get('from') else None,
                        'target': self._pub(t['target']) if t.get('target') else None,
                        'stage': t['stage'], 'seq': t['seq'], 'question': QUESTIONS[t.get('q', 0)]}

            events = []
            for e in self.events:
                show = e['when'] == 'play' or over
                events.append({'seq': e['seq'], 'by': self._pub(e['pid']), 'when': e['when'],
                               'guess': e['guess'] if show else None,
                               'correct': e['correct'] if show else None})

            s = {
                'name': self.name, 'round': self.round, 'phase': self.phase,
                'minutes': self.minutes, 'pack': self.pack, 'spySetting': self.spy_setting,
                'spyCount': self.spy_count(), 'hiddenSpies': len([p for p in self.spies if p not in self.out]),
                'minPlayers': MIN_PLAYERS, 'showMeaning': self.show_meaning,
                'candidates': [loc_pub(c) for c in self.candidates],
                'players': players, 'turn': turn,
                'questions': len(self.history),
                'history': [{'asker': self._pub(h['asker']), 'target': self._pub(h['target'])} for h in self.history[-12:]],
                'events': events,
                'accuseLog': [{'seq': a['seq'], 'by': self._pub(a['by']), 'target': self._pub(a['target']),
                               'result': a['result'], 'timeout': a['timeout'],
                               'opposed': [self._pub(p) for p in a['opposed']]} for a in self.accuse_log],
                'points': [dict(self._pub(pt['pid']), pts=pt['pts'], why=pt['why']) for pt in self.points],
                'timeLeft': self.time_left(), 'timeLimit': self.time_limit, 'paused': self.paused_left is not None,
                'timeouts': self.timeouts,
                'voteCount': len(self.votes), 'voteNeed': len([p for p in self._active() if self.players[p]['online'] > 0]),
                'voteN': self.vote_n,
                'host': host,
                'log': self.log[-30:],
            }
            a = self.accusing
            if a:
                voters = self._accuse_voters()
                s['accuse'] = {'by': self._pub(a['by']), 'target': self._pub(a['target']), 'seq': a['seq'],
                               'agree': len([p for p in voters if a['votes'].get(p)]), 'need': len(voters)}
                # 지목 투표 동안은 화면 시계가 투표 남은 시간을 보여준다
                s['timeLeft'] = max(0.0, a['deadline'] - time.time())
                s['timeLimit'] = ACCUSE_SECONDS
                s['paused'] = False
            if reveal:
                s['tally'] = [dict(self._pub(t['pid']), votes=t['votes'], spy=t['pid'] in self.spies) for t in self.tally]
                s['caught'] = [dict(self._pub(p), spy=p in self.spies) for p in self.caught]
                s['lastWaiting'] = [self._pub(p) for p in self.caught
                                    if p in self.spies and p not in self.last_guesses and p in self.players]
            if over:
                loc = self.location
                s['location'] = dict(loc_pub(loc), roles=loc['roles']) if loc else None
                s['winner'] = self.winner
                s['winReason'] = self.win_reason
                s['spies'] = [dict(self._pub(p), out=p in self.out, accused=p in self.accused_out, caught=p in self.caught,
                                   guess=self.last_guesses.get(p)) for p in self.spies]
            if host and self.location and self.phase != 'lobby':
                # 선생님 화면 맨 아래(스크롤해야 보이는 곳)에만 쓰는 정답
                loc = self.location
                s['secret'] = {
                    'location': loc_pub(loc),
                    'spies': [dict(self._pub(p), out=p in self.out) for p in self.spies],
                    'roles': [dict(self._pub(p), spy=r['spy'], role=r['role']) for p, r in self.roles.items() if p in self.players],
                }
            if me and me in self.players:
                p = self.players[me]
                r = self.roles.get(me)
                mine = {'id': p['id'], 'name': p['name'], 'inRound': r is not None,
                        'spy': bool(r and r['spy']), 'out': me in self.out,
                        'score': p.get('score', 0), 'gain': gains.get(me, 0),
                        'canAccuse': self.phase == 'play' and not a and me in self._active() and me not in self.accused_by,
                        'usedAccuse': me in self.accused_by}
                if r and not r['spy']:
                    mine['role'] = r['role']
                    mine['location'] = loc_pub(self.location)
                if a:
                    mine['accuseRole'] = 'by' if me == a['by'] else 'target' if me == a['target'] \
                        else 'voter' if me in self._accuse_voters() else None
                    mine['accuseVote'] = a['votes'].get(me)
                if self.phase == 'vote' and me in self.votes:
                    mine['vote'] = self.players[self.votes[me]]['id'] if self.votes[me] in self.players else None
                if self.phase == 'last':
                    mine['lastChance'] = me in self.caught and me in self.spies and me not in self.last_guesses
                s['me'] = mine
                t = self.turn
                if t and t.get('asker') == me:
                    s['myTurn'] = True
                    rnd = random.Random(t['seed'])  # 같은 차례 동안은 예시가 바뀌지 않게
                    s['askSample'] = rnd.sample(QUESTIONS, 3)
                if t and t.get('target') == me:
                    s['beingAsked'] = t['stage']  # 'answer' = 대답할 차례
                    s['answerSample'] = random.Random(t['seed']).sample(ANSWERS, 4)
            return s


games = {}
_games_lock = threading.Lock()


def get_game(name):
    if not name:
        return None
    return games.get(str(name))


def create_game(name: str, minutes: int, pack: int):
    """새 게임을 만든다. 이미 있는 코드면 (기존 게임, False)."""
    with _games_lock:
        g = games.get(name)
        if g is not None:
            return g, False
        g = games[name] = Game(name, minutes, pack)
        return g, True
