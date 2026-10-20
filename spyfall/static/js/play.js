// 학생 휴대폰 화면
const GAME = $('#app').dataset.game;

function storage(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch (e) { return null; }
}

// 이 브라우저의 고유값. 화면이 꺼졌다 켜져도 같은 학생으로 다시 들어오게 한다.
let PID = storage('sf_pid');
if (!PID) {
  PID = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  storage('sf_pid', PID);
}

const socket = io(location.origin, { path: '/socket.io/' });
let state = null;
let cardOpen = false;
let cardTimer = null;
let cardRound = null;
let pendingConfirm = null;

$('#rulesBody').innerHTML = rulesHTML();
$('#joinName').value = storage('sf_name') || '';

socket.on('connect', () => {
  socket.emit('hello', { game: GAME, pid: PID }, res => {
    if (res && res.error === 'nogame') location.href = '/?error=' + encodeURIComponent('게임이 끝났거나 없는 코드예요.');
  });
});
socket.on('disconnect', () => toast('연결이 끊겼어요. 다시 연결하는 중...', 'error'));
let holdUntil = 0;     // 이 시각까지는 결과를 가리고 "선생님 화면을 보세요"
let holdTimer = null;

socket.on('state', s => {
  const prev = state;
  state = s;
  // 게임 도중 결과가 나오면 선생님 화면의 공개 연출이 끝날 때까지 결과를 가린다
  if (prev && prev.round === s.round && prev.phase !== s.phase && (s.phase === 'last' || s.phase === 'over')) {
    // 선생님 화면 연출 길이에 맞춘다: 투표 공개(+스파이 공개) → 장소 공개
    const fromVote = prev.phase === 'vote' || prev.phase === 'last';
    const ms = s.phase === 'last' ? 3600 + (s.caught || []).length * 1500 : fromVote ? 12000 : 7000;
    holdUntil = performance.now() + ms;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => state && render(state), ms + 50);
  }
  syncTimer(s);
  notify(prev, s);
  render(s);
  if (!s.me && (!prev || $('#joinModal').classList.contains('hidden'))) openModal('joinModal');
});
socket.on('kicked', d => {
  toast(d.msg);
  if (state) state.me = null;
  openModal('joinModal');
});

function send(event, data) {
  return new Promise(resolve => {
    socket.emit(event, data, res => {
      if (res && res.error) toast(res.error, 'error');
      resolve(res || {});
    });
  });
}

// ---------- 입장 ----------
$('#meChip').onclick = () => openModal('joinModal');
$('#btnJoin').onclick = async () => {
  const nm = $('#joinName').value.trim();
  if (!nm) return toast('이름을 입력해 주세요.', 'error');
  const res = await send('join', { name: nm });
  if (res.ok) {
    storage('sf_name', nm);
    closeModal('joinModal');
  }
};
$('#joinName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnJoin').click(); });

// ---------- 확인 창 ----------
function confirmBox(lead, word, mean, okLabel, fn) {
  $('#confirmLead').textContent = lead;
  $('#confirmWord').textContent = word;
  $('#confirmMean').textContent = mean || '';
  $('#btnConfirm').textContent = okLabel;
  pendingConfirm = fn;
  openModal('confirmModal');
}
$('#btnConfirm').onclick = () => {
  closeModal('confirmModal');
  if (pendingConfirm) pendingConfirm();
  pendingConfirm = null;
};

// ---------- 비밀 카드 (누를 때만 보이고 8초 뒤 자동으로 덮인다) ----------
function setCard(open) {
  cardOpen = open;
  $('#rcard').classList.toggle('open', open);
  clearTimeout(cardTimer);
  if (open) cardTimer = setTimeout(() => setCard(false), 8000);
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-guess-open]')) {
    e.stopPropagation();
    openGuess();
    return;
  }
  if (e.target.closest('[data-flip]')) setCard(!cardOpen);
});

function cardFace(s) {
  const me = s.me;
  if (me.spy) {
    const canGuess = s.phase === 'play' && !me.out;
    return `<div class="ic">🕵️</div><div class="loc-en">YOU ARE THE SPY</div><div class="loc-ko">당신은 스파이! 대답을 듣고 장소를 알아내세요</div>
      ${me.out ? '<div class="role" style="background:#3a4050"><b>정체가 드러났어요</b></div>'
        : canGuess ? '<button class="btn stamp" style="margin-top:12px" data-guess-open>🎯 장소 맞히기</button>' : ''}
      <div class="tapnote">다시 누르면 덮여요</div>`;
  }
  return `<div class="loc-ic">${esc(me.location.icon)}</div><div class="loc-en">${esc(me.location.name)}</div><div class="loc-ko">${esc(me.location.meaning)}</div>
    <div class="role"><span>나의 역할</span><b>${esc(me.role.meaning)}</b></div>
    <div class="tapnote">다시 누르면 덮여요</div>`;
}

// ---------- 동작 ----------
function pickGrid(s, opts) {
  const meId = s.me.id;
  const list = s.players.filter(p => p.inRound && !p.out && p.id !== meId);
  const minAsked = Math.min(...list.map(p => p.asked));
  return `<div class="pick-grid">${list.map(p => {
    const cls = [];
    if (opts.current === p.id) cls.push('on');
    if (opts.fresh && p.asked === minAsked) cls.push('fresh');
    const blocked = opts.blocked === p.id && list.length > 1;
    const sub = blocked ? '방금 나에게 질문함' : opts.fresh ? (p.asked ? `질문 ${p.asked}번 받음` : '아직 질문 못 받음') : '';
    return `<button class="${cls.join(' ')}" data-${opts.action}="${p.id}" ${blocked ? 'disabled' : ''}>${esc(p.name)}${sub ? `<small>${sub}</small>` : ''}</button>`;
  }).join('')}</div>`;
}

document.addEventListener('click', e => {
  const a = e.target.closest('[data-ask]');
  if (a) send('ask', { id: Number(a.dataset.ask) });
  if (e.target.closest('[data-turn=answered]')) send('answered');
  if (e.target.closest('[data-turn=unpick]')) send('unpick');
  // 지목 투표: 열기 → 친구 고르기 → 확인 / 찬성·반대
  if (e.target.closest('[data-accuse-open]')) {
    $('#accuseGrid').innerHTML = pickGrid(state, { action: 'accuse' });
    openModal('accuseModal');
  }
  const ac = e.target.closest('[data-accuse]');
  if (ac) {
    const p = state.players.find(x => x.id === Number(ac.dataset.accuse));
    closeModal('accuseModal');
    confirmBox('이 친구를 스파이로 지목할까요? (한 판에 한 번)', p ? p.name : '',
      '지목당한 친구 빼고 모두 찬성하면 정체가 공개돼요. 시민이었으면 스파이가 이겨요!', '지목하기',
      () => send('accuse', { id: Number(ac.dataset.accuse) }));
  }
  const av = e.target.closest('[data-accuse-vote]');
  if (av) send('accuse_vote', { agree: av.dataset.accuseVote === 'yes' });
  const v = e.target.closest('[data-vote]');
  if (v) send('vote', { id: Number(v.dataset.vote) });
  const g = e.target.closest('[data-guess]');
  if (g) {
    const c = state.candidates.find(x => x.name === g.dataset.guess);
    closeModal('guessModal');
    const last = state.phase === 'last';
    confirmBox(last ? '마지막 추측! 이 장소가 맞나요?' : '정말 이 장소로 추측할까요? 틀리면 정체가 드러나요!',
      c.name, c.meaning, '이 장소로!', () => send('guess', { location: c.name }));
  }
});

function openGuess() {
  const wrong = new Set(state.events.filter(e => e.guess && !e.correct).map(e => e.guess));
  $('#guessGrid').innerHTML = state.candidates.map(c =>
    `<button class="loc pick ${wrong.has(c.name) ? 'wrong' : ''}" data-guess="${esc(c.name)}">${locHTML(c)}</button>`).join('');
  openModal('guessModal');
}

// ---------- 그리기 ----------
const name = p => esc(p ? p.name : '');

function status(big, small, opts) {
  opts = opts || {};
  const el = $('#status');
  el.classList.toggle('alert', !!opts.alert);
  el.innerHTML = `<div class="grow"><div class="big">${big}</div>${small ? `<div class="small">${small}</div>` : ''}</div>${opts.clock ? clockHTML(opts.clock) : ''}`;
}

function render(s) {
  const me = s.me;
  $('#meChip').textContent = me ? `👤 ${me.name} · ${me.score}점` : '입장하기';
  document.body.classList.toggle('no-meaning', !s.showMeaning && s.phase !== 'over');

  // 새 판이 되면 카드를 덮는다
  if (cardRound !== s.round) { cardRound = s.round; setCard(false); }
  const hasCard = me && me.inRound && ['play', 'vote', 'last'].includes(s.phase);
  $('#rcard').classList.toggle('hidden', !hasCard);
  if (hasCard) {
    $('#rface').className = 'side face' + (me.spy ? ' spy' : '');
    $('#rface').innerHTML = cardFace(s);
  }

  let boxes = '';
  if (!me) {
    status('입장해 주세요', '이름을 쓰고 들어오면 게임에 참가할 수 있어요.');
  } else if (s.phase === 'lobby') {
    status('⏳ 곧 시작해요<span class="dots"></span>', `선생님이 시작하면 <b>비밀 카드</b>가 나와요. 지금 ${s.players.length}명 입장 · 스파이 ${s.spyCount}명 예정`);
  } else if (!me.inRound) {
    status('👀 이번 판은 구경해요', '중간에 들어와서 다음 판부터 참가해요.', { clock: s.phase === 'over' ? null : '남은 시간' });
  } else if (s.phase === 'play') {
    boxes = renderPlay(s);
  } else if (s.phase === 'vote') {
    boxes = renderVote(s);
  } else if (s.phase === 'last') {
    boxes = renderLast(s);
  }
  if (s.phase === 'over') boxes = renderOver(s);
  $('#boxes').innerHTML = boxes;
  renderLocations(s);
}

function renderPlay(s) {
  const me = s.me, t = s.turn;
  if (me.out) {
    status('😵 정체가 드러났어요', '스파이인 게 밝혀졌어요. 이번 판은 친구들을 구경해요.', { clock: '남은 시간' });
    return '';
  }
  if (s.accuse) return renderAccuse(s);
  const clock = { clock: '남은 시간' };
  if (s.paused) status('⏸ 선생님이 시간을 멈췄어요', '잠시 기다려 주세요.', clock);
  const st = (big, small, alert) => { if (!s.paused) status(big, small, Object.assign({ alert }, clock)); };
  // 스파이든 시민이든 똑같이 보이는 지목 버튼 (한 판에 한 번)
  const accuseBox = me.canAccuse
    ? `<div class="p-box accuse-box"><h3>🚨 스파이 같은 친구가 있나요? <small>한 판에 한 번</small></h3>
        <button class="btn block" data-accuse-open>🚨 스파이 지목하기</button></div>`
    : me.usedAccuse ? '<p class="muted" style="text-align:center;font-size:13px">이번 판 지목 기회를 이미 썼어요.</p>' : '';

  // 내가 질문할 차례: 친구를 고르고 바로 말로 질문
  if (s.myTurn && t.stage === 'choose') {
    st('🎤 내가 질문할 차례!', '친구를 고르고, 그 친구에게 말로 질문해요.', true);
    return `<div class="p-box turn"><h3>누구에게 질문할까요? <small>초록 = 질문을 덜 받은 친구</small></h3>
      ${pickGrid(s, { action: 'ask', fresh: true, blocked: t.from && t.from.id })}
      <h3 style="margin-top:14px">💬 질문 예시 <small>장소가 너무 드러나지 않게!</small></h3>
      <div class="ex-list">${(s.askSample || []).map(q => `<div><b>${esc(q)}</b></div>`).join('')}</div></div>${accuseBox}`;
  }
  if (s.myTurn && t.stage === 'answer') {
    st(`🗣 ${name(t.target)}에게 질문하세요!`, `말로 질문하면 ${name(t.target)}이(가) 대답하고 "답변했어요"를 눌러요.`, true);
    return `<div class="p-box"><div style="text-align:center"><button class="link" data-turn="unpick">잘못 골랐어요 (다시 고르기)</button></div></div>${accuseBox}`;
  }
  // 내가 질문 받는 차례: 대답하고 "답변했어요"
  if (s.beingAsked === 'answer') {
    st(`💬 ${name(t.asker)}이(가) 너에게 질문해요!`, '질문을 듣고 말로 대답한 다음 아래 버튼을 눌러요.', true);
    return `<div class="p-box turn">
      <button class="btn green block" data-turn="answered">✅ 답변했어요</button>
      <p class="muted" style="font-size:13px;margin:8px 0 12px;text-align:center">버튼을 누르면 내가 다음 질문할 친구를 골라요.</p>
      <h3>💬 대답 예시 <small>너무 쉽게 알려 주지 말기!</small></h3>
      <div class="ans-list">${(s.answerSample || []).map(a => `<span>${esc(a)}</span>`).join('')}</div></div>${accuseBox}`;
  }
  // 구경하는 학생 (스파이든 시민이든 같은 문구 — 옆 친구가 봐도 모르게)
  const big = !t ? '질문 시간'
    : t.stage === 'choose' ? `🎤 ${name(t.asker)}이(가) 친구를 고르는 중`
      : `${name(t.asker)} ➜ ${name(t.target)}`;
  const small = t && t.stage === 'answer' ? `${name(t.target)}의 대답을 잘 들어 보세요. 누가 수상한가요?` : '대답을 잘 들어 보세요. 누가 수상한가요?';
  st(big, small);
  return accuseBox;
}

function renderAccuse(s) {
  const a = s.accuse, me = s.me;
  const clock = { clock: '지목 투표' };
  const count = `찬성 ${a.agree} / ${a.need}명`;
  if (me.accuseRole === 'target') {
    status(`😱 ${name(a.by)}이(가) 너를 스파이로 지목했어요!`, `스파이가 아니라고 말로 설명해 보세요. (${count})`, Object.assign({ alert: true }, clock));
    return '';
  }
  if (me.accuseRole === 'by') {
    status(`🚨 ${name(a.target)}을(를) 지목했어요!`, `친구들의 투표를 기다려요. ${count}`, clock);
    return '';
  }
  if (me.accuseRole === 'voter' && me.accuseVote == null) {
    status(`🚨 ${name(a.by)}이(가) ${name(a.target)}을(를) 지목했어요!`, `${name(a.target)}이(가) 스파이일까요? 한 명이라도 반대하면 무산돼요.`, Object.assign({ alert: true }, clock));
    return `<div class="p-box turn"><div class="vote-yn">
        <button class="btn green" data-accuse-vote="yes">👍 찬성<small>스파이 같아요</small></button>
        <button class="btn stamp" data-accuse-vote="no">👎 반대<small>아닌 것 같아요</small></button></div>
      <p class="muted" style="font-size:13px;margin:10px 0 0;text-align:center">모두 찬성하면 ${name(a.target)}의 정체가 공개돼요. 시민이었으면 스파이가 이겨요!</p></div>`;
  }
  status(`🚨 ${name(a.by)} ➜ ${name(a.target)} 지목 투표 중`, me.accuseVote ? `찬성했어요. ${count}` : count, clock);
  return '';
}

function renderVote(s) {
  const me = s.me;
  if (me.out) {
    status('🗳 투표 중', '정체가 드러난 스파이는 투표할 수 없어요.', { clock: '투표 시간' });
    return '';
  }
  status(me.vote ? '✅ 투표했어요!' : '🗳 스파이는 누구?',
    me.vote ? `바꾸려면 다른 친구를 누르세요. (${s.voteCount}/${s.voteNeed}명 투표)` : `스파이라고 생각하는 친구 1명을 눌러요. 표를 많이 받은 ${s.voteN}명의 정체가 공개돼요.`,
    { alert: !me.vote, clock: '투표 시간' });
  return `<div class="p-box"><h3>스파이라고 생각하는 친구</h3>
    ${pickGrid(s, { action: 'vote', current: me.vote })}</div>`;
}

function renderLast(s) {
  const me = s.me;
  const caught = (s.caught || []).map(p => `${esc(p.name)} ${p.spy ? '🕵️' : '🙂'}`).join(', ');
  if (me.lastChance) {
    status('😱 잡혔다! 마지막 기회!', '장소를 맞히면 스파이 역전승! 아래에서 장소를 골라요.', { alert: true, clock: '마지막 기회' });
    const wrong = new Set(s.events.filter(e => e.guess && !e.correct).map(e => e.guess));
    return `<div class="p-box turn"><h3>🎯 비밀 장소는 어디일까?</h3><div class="loc-grid">${s.candidates.map(c =>
      `<button class="loc pick ${wrong.has(c.name) ? 'wrong' : ''}" data-guess="${esc(c.name)}">${locHTML(c)}</button>`).join('')}</div></div>`;
  }
  // 선생님 화면에서 투표 결과를 한 명씩 공개하는 동안은 휴대폰에 미리 보여주지 않는다
  if (performance.now() < holdUntil) {
    status('👀 투표 결과 발표!', '선생님 화면을 보세요<span class="dots"></span>', { clock: '마지막 기회' });
    return '';
  }
  status('😱 잡힌 스파이의 마지막 기회', `투표로 잡힌 사람: ${caught}<br>잡힌 스파이가 장소를 맞히면 역전돼요<span class="dots"></span>`, { clock: '마지막 기회' });
  return '';
}

function renderOver(s) {
  const me = s.me;
  if (performance.now() < holdUntil) {
    status('🥁 두구두구...', '선생님 화면을 보세요! 곧 결과가 나와요<span class="dots"></span>');
    return '';
  }
  const spyWin = s.winner === 'spy';
  const mine = me && me.inRound ? (me.spy === spyWin) : null;
  status(spyWin ? '🕵️ 스파이 승리!' : '🎉 시민 승리!', esc(s.winReason));
  const myRole = !me || !me.inRound ? '' : me.spy ? '내 역할: <b>🕵️ 스파이</b>' : `내 역할: <b>${esc(me.role.meaning)}</b>`;
  return `<div class="p-box p-result ${mine == null ? '' : mine ? 'win' : 'lose'}">
      <div class="big">${mine == null ? '👀' : mine ? '🏆' : '😢'}</div>
      <h2>${mine == null ? '게임 끝!' : mine ? '우리 편 승리!' : '아쉽게 졌어요'}</h2>
      <div class="muted" style="margin-bottom:12px">${myRole}</div>
      <div class="result-loc"><small>비밀 장소</small><span class="big-ic">${esc(s.location.icon)}</span><span class="en">${esc(s.location.name)}</span><span class="ko">${esc(s.location.meaning)}</span></div>
      <div class="spy-reveal">🕵️ 스파이는 <b>${s.spies.map(p => esc(p.name)).join(', ')}</b>${me && me.spy ? ' (나!)' : ''}</div>
      ${me ? myPointsHTML(s, me) : ''}
      <div class="muted" style="margin-top:10px;font-size:13px">선생님이 새 판을 시작하면 새 카드가 나와요.</div></div>`;
}

function myPointsHTML(s, me) {
  const mine = s.points.filter(p => p.id === me.id);
  return `<div class="my-points"><div class="gain">이번 판 <b>+${me.gain}점</b> · 내 점수 <b>${me.score}점</b></div>
    ${mine.map(p => `<div class="why">+${p.pts} ${esc(p.why)}</div>`).join('')}</div>`;
}

function renderLocations(s) {
  const wrong = new Set(s.events.filter(e => e.guess && !e.correct).map(e => e.guess));
  const answer = s.phase === 'over' && s.location && performance.now() >= holdUntil ? s.location.name : null;
  $('#locTitle').textContent = s.phase === 'lobby' ? `오늘의 장소 후보 ${s.candidates.length}곳` : `장소 후보 ${s.candidates.length}곳`;
  $('#locNote').textContent = s.phase === 'lobby' ? '이 중 한 곳이 비밀 장소!' : (wrong.size ? '줄 그은 곳 = 스파이가 틀린 곳' : '');
  $('#locGrid').innerHTML = s.candidates.map(c =>
    `<div class="loc ${c.name === answer ? 'answer' : ''} ${wrong.has(c.name) ? 'wrong' : ''}">${locHTML(c)}</div>`).join('');
}

// 중요한 순간에 진동 + 알림
function notify(prev, s) {
  if (!prev || !s.me) return;
  const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* 무시 */ } };
  if (prev.phase === 'lobby' && s.phase === 'play' && s.me.inRound) { buzz([120, 80, 120]); toast('🃏 비밀 카드가 나왔어요! 눌러서 확인하세요'); }
  if (s.myTurn && !prev.myTurn) buzz(200);
  if (s.beingAsked === 'answer' && prev.beingAsked !== 'answer') { buzz([150, 80, 150]); toast(`💬 ${s.turn.asker.name}이(가) 너에게 질문해요!`); }
  if (s.accuse && !prev.accuse) { buzz([250, 100, 250]); toast(`🚨 ${s.accuse.by.name}이(가) ${s.accuse.target.name}을(를) 지목했어요!`); }
  const newAcc = s.accuseLog.filter(a => !prev.accuseLog.some(b => b.seq === a.seq));
  newAcc.forEach(a => toast(a.result === 'fail' ? '지목 투표가 무산됐어요. 질문을 계속해요!'
    : a.result === 'spy' ? `🎯 ${a.target.name}은(는) 스파이였어요!` : `${a.target.name}은(는) 시민이었어요...`));
  if (prev.phase === 'play' && s.phase === 'vote') { buzz([200, 100, 200]); toast('🗳 투표 시간이에요!'); }
  if (s.me.lastChance && !(prev.me && prev.me.lastChance)) buzz([300, 100, 300]);
}
