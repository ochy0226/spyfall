// 선생님 중계 화면: 참가하지 않고 질문 차례·시간·투표·결과를 실시간으로 보여준다 (장소와 스파이는 끝날 때까지 안 보임)
const GAME = $('#app').dataset.game;
const socket = io(location.origin, { path: '/socket.io/' });
let state = null;
let resultShownRound = null;
const seenPlayers = new Set();
let playersPainted = false; // 처음 화면을 열 때는 이미 있던 학생에게 입장 애니메이션을 주지 않는다

$('#rulesBody').innerHTML = rulesHTML();

socket.on('connect', () => {
  socket.emit('watch', { game: GAME }, res => {
    if (res && res.error) location.href = '/teacher';
  });
});
socket.on('disconnect', () => toast('서버 연결이 끊겼어요. 다시 연결하는 중...', 'error'));
socket.on('state', s => {
  const prev = state;
  state = s;
  syncTimer(s);
  render(s, prev);
  queueEffects(prev, s);
});

function act(action, extra) {
  socket.emit('teacher', Object.assign({ action }, extra || {}), res => {
    if (res && res.error) toast(res.error, 'error');
  });
}

$('#btnMeaning').onclick = () => act('toggle_meaning');
$('#btnPause').onclick = () => act('pause');
$('#btnAsker').onclick = () => act('asker');
$('#btnVote').onclick = () => {
  if (confirm('질문 시간을 끝내고 바로 투표를 시작할까요?')) act('vote');
};
$('#btnNewRound').onclick = () => {
  if (state && ['play', 'vote', 'last'].includes(state.phase) && !confirm('지금 판을 그만두고 새 판을 준비할까요?')) return;
  closeModal('resultModal');
  act('new_round');
};

document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]');
  if (a) act(a.dataset.act);
  const o = e.target.closest('[data-opt]');
  if (o) act('options', { [o.dataset.opt]: Number(o.dataset.val) });
  const k = e.target.closest('[data-kick]');
  if (k && confirm('이 학생을 내보낼까요? (다시 들어올 수 있어요)')) act('kick', { pid: k.dataset.kick });
  const q = e.target.closest('[data-asker]');
  if (q) act('asker', { pid: q.dataset.asker });
});

const name = p => esc(p ? p.name : '');

function render(s, prev) {
  const live = ['play', 'vote', 'last'].includes(s.phase);
  $('#roundNo').textContent = s.round + '번째 판';
  $('#btnMeaning').textContent = s.showMeaning ? '뜻 숨기기' : '뜻 보이기';
  $('#btnPause').disabled = !live;
  $('#btnPause').textContent = s.paused ? '▶ 시간 계속' : '⏸ 시간 멈춤';
  $('#btnAsker').disabled = s.phase !== 'play';
  $('#btnVote').disabled = s.phase !== 'play';
  document.body.classList.toggle('no-meaning', !s.showMeaning && s.phase !== 'over');

  renderStage(s, prev);
  renderLocations(s);
  renderPlayers(s);

  $('#qCount').textContent = s.questions ? s.questions + '개' : '';
  const base = s.questions - s.history.length;
  $('#historyList').innerHTML = s.history.length
    ? s.history.map((h, i) => `<li><span class="no">${base + i + 1}</span>${name(h.asker)} <i>➜</i> ${name(h.target)}</li>`).reverse().join('')
    : '<li class="muted">아직 없어요</li>';
  $('#logList').innerHTML = s.log.slice().reverse()
    .map(l => `<li><time>${esc(l.time)}</time>${esc(l.text)}</li>`).join('');

  // 대기 중이거나 아직 아무도 안 들어왔으면 QR을 크게
  $('#joinPanel').classList.toggle('big', s.phase === 'lobby' || s.players.length === 0);

  // 게임 도중 끝난 경우는 연출(투표 공개 → 장소 공개) 뒤에 queueEffects가 결과를 띄운다
  if (s.phase === 'over' && resultShownRound !== s.round && !(prev && prev.round === s.round && prev.phase !== 'over')) {
    showResult(s);
  }
  if (s.phase !== 'over') closeModal('resultModal');
}

function seg(opt, items, cur) {
  return `<div class="seg">${items.map(([v, label]) =>
    `<button class="${v === cur ? 'on' : ''}" data-opt="${opt}" data-val="${v}">${label}</button>`).join('')}</div>`;
}

function renderStage(s, prev) {
  const el = $('#stage');
  el.classList.toggle('dark', s.phase === 'vote' || s.phase === 'last');
  if (s.phase === 'lobby') {
    const n = s.players.length;
    const autoN = s.spySetting === 0 ? s.spyCount : null;
    el.innerHTML = `<div class="grow">
        <div class="s-title">🕵️ 우리 반에 스파이가 숨어 있다!</div>
        <div class="s-sub">QR로 입장한 학생 <b>${n}명</b> · ${n < s.minPlayers ? `최소 ${s.minPlayers}명이 들어오면 시작할 수 있어요` : '모두 들어왔으면 ▶ 게임 시작!'}</div>
        <div class="settings" style="margin-top:14px">
          <span class="lbl">스파이</span>${seg('spies', [[0, `자동${autoN ? ` (${autoN}명)` : ''}`], [1, '1명'], [2, '2명'], [3, '3명']], s.spySetting)}
          <span class="lbl">시간</span>${seg('minutes', [[5, '5분'], [7, '7분'], [10, '10분']], s.minutes)}
          <span class="lbl">장소 후보</span><div>${seg('pack', [[12, '12곳'], [20, '20곳'], [0, '전체']], s.pack)}
            <button class="link" data-act="reshuffle">🔀 다른 장소로 바꾸기</button></div>
        </div>
      </div>
      <div class="lobby-go">
        <button class="btn primary start" data-act="start" ${n < s.minPlayers ? 'disabled' : ''}>▶ 게임 시작</button>
        <div class="muted" style="text-align:center;font-size:13px">스파이 ${s.spyCount}명 · ${s.minutes}분</div>
      </div>`;
    return;
  }
  if (s.phase === 'play') {
    const t = s.turn;
    let qa;
    if (!t) {
      qa = `<div class="s-title">질문할 학생이 없어요</div><div class="s-sub">🎲 질문자 바꾸기를 눌러 주세요.</div>`;
    } else if (t.stage === 'asking') {
      qa = `<div class="qa"><span class="who">🎤 ${name(t.asker)}</span><span class="arrow">➜</span><span class="who">${name(t.target)}</span></div>
        <div class="q-example">💬 질문 예시: <b>${esc(t.question)}</b></div>
        <div class="s-sub"><b>${name(t.asker)}</b> 학생이 질문하는 중<span class="dots"></span> 다 물어보면 휴대폰에서 "질문했어요"</div>`;
    } else if (t.stage === 'answer') {
      qa = `<div class="qa"><span class="who">${name(t.asker)}</span><span class="arrow">➜</span><span class="who">💬 ${name(t.target)}</span></div>
        <div class="s-sub"><b>${name(t.target)}</b> 학생이 대답하는 중<span class="dots"></span> 다 대답하면 휴대폰에서 "답변했어요" → 다음 질문자가 돼요</div>`;
    } else {
      qa = `<div class="qa"><span class="who">🎤 ${name(t.asker)}</span><span class="arrow">➜</span><span class="who wait">?</span></div>
        <div class="s-sub"><b>${name(t.asker)}</b> 학생이 휴대폰에서 질문할 친구를 고르는 중${t.from ? ` · 방금 질문한 ${name(t.from)} 학생은 고를 수 없어요` : ''}</div>`;
    }
    el.innerHTML = `${clockHTML('질문 시간')}<div class="grow">${qa}</div>
      <div class="stats"><div class="stat spy"><b>${s.hiddenSpies}</b><span>숨은 스파이</span></div>
      <div class="stat"><b>${s.questions}</b><span>질문 수</span></div></div>`;
    if (prev && prev.turn && t && prev.turn.seq !== t.seq) {
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
      if (t.stage === 'asking') sound('ask');
    }
    return;
  }
  if (s.phase === 'vote') {
    const active = s.players.filter(p => p.inRound && !p.out);
    const pct = s.voteNeed ? Math.round(s.voteCount / s.voteNeed * 100) : 0;
    el.innerHTML = `${clockHTML('투표 시간')}<div class="grow">
        <div class="s-title">🗳 스파이는 누구일까?</div>
        <div class="s-sub">휴대폰에서 스파이라고 생각하는 친구 1명에게 투표! 표를 가장 많이 받은 <b style="color:#fff">${s.voteN}명</b>의 정체가 공개돼요.</div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="s-sub" style="margin-top:6px">투표 ${s.voteCount} / ${s.voteNeed}명</div>
        <div class="vote-chips">${active.map(p => `<span class="${p.voted ? 'on' : ''}">${p.voted ? '✓ ' : ''}${esc(p.name)}</span>`).join('')}</div>
      </div>`;
    return;
  }
  if (s.phase === 'last') {
    const waiting = (s.lastWaiting || []).map(p => `<b style="color:#fff">${esc(p.name)}</b>`).join(', ');
    el.innerHTML = `${clockHTML('마지막 기회')}<div class="grow">
        <div class="s-title">😱 잡힌 스파이의 마지막 기회!</div>
        <div class="s-sub">${waiting || '스파이'} 학생이 장소를 고르는 중<span class="dots"></span><br>
          장소를 맞히면 <b style="color:#ff9c92">스파이 역전승!</b> 아래 장소 중 어디일까요?</div>
      </div>`;
    return;
  }
  // over
  const spyWin = s.winner === 'spy';
  el.innerHTML = `<div class="grow">
      <div class="s-title" style="color:${spyWin ? 'var(--spy)' : 'var(--citizen)'}">${spyWin ? '🕵️ 스파이 승리!' : '🎉 시민 승리!'}</div>
      <div class="s-sub">${esc(s.winReason)}<br>장소는 <b>${esc(s.location.name)}</b> (${esc(s.location.meaning)}) · 스파이: <b>${s.spies.map(p => esc(p.name)).join(', ')}</b></div>
    </div>
    <div class="lobby-go"><button class="btn" data-open="resultModal">결과 보기</button>
      <button class="btn primary" onclick="$('#btnNewRound').click()">새 판 시작</button></div>`;
}

function renderLocations(s) {
  const wrong = new Set(s.events.filter(e => e.guess && !e.correct).map(e => e.guess));
  const answer = s.phase === 'over' && s.location ? s.location.name : null;
  $('#locTitle').textContent = s.phase === 'lobby' ? `오늘의 장소 후보 ${s.candidates.length}곳 · 미리 읽어 봐요!` : `장소 후보 ${s.candidates.length}곳`;
  $('#locNote').textContent = s.phase === 'lobby' ? '이 중 한 곳이 비밀 장소가 돼요' : (wrong.size ? '줄 그은 곳 = 스파이가 틀린 장소' : '');
  $('#locGrid').innerHTML = s.candidates.map(c =>
    `<div class="loc ${c.name === answer ? 'answer' : ''} ${wrong.has(c.name) ? 'wrong' : ''}">${locHTML(c)}</div>`).join('');
}

function renderPlayers(s) {
  $('#playerCount').textContent = s.players.length + '명';
  const asker = s.phase === 'play' && s.turn ? s.turn.asker.id : null;
  $('#playerList').innerHTML = s.players.length ? s.players.map(p => {
    const cls = [];
    if (!p.online) cls.push('off');
    if (p.id === asker) cls.push('asker');
    if (p.spy) cls.push('outspy');  // 서버는 정체가 공개된 학생에게만 spy 값을 보낸다
    if (s.phase !== 'lobby' && !p.inRound) cls.push('spect');
    if (playersPainted && !seenPlayers.has(p.id)) cls.push('new');
    const tag = p.out ? '<span class="tag">들킴</span>' : p.spy ? '<span class="tag">스파이</span>' : '';
    const cnt = s.phase !== 'lobby' && p.inRound ? `<span class="cnt" title="질문 받은 횟수">${p.asked}</span>` : '';
    const mic = s.phase === 'play' && p.inRound && !p.out ? `<button data-asker="${esc(p.pid)}" title="질문자로 지정">🎤</button>` : '';
    return `<li class="${cls.join(' ')}"><span class="nm">${esc(p.name)}</span>${tag}${cnt}${mic}
      <button data-kick="${esc(p.pid)}" title="내보내기">✕</button></li>`;
  }).join('') : '<li class="empty">아직 아무도 없어요. QR을 찍어 주세요!</li>';
  s.players.forEach(p => seenPlayers.add(p.id));
  playersPainted = true;
}

function resultHTML(s) {
  const spyWin = s.winner === 'spy';
  const max = Math.max(1, ...(s.tally || []).map(t => t.votes));
  const spyRows = s.spies.map(p => {
    const how = p.out ? '장소를 틀리게 추측해서 들킴' : p.caught ? (p.guess ? `투표로 잡힘 · 마지막 추측: ${esc(p.guess)}` : '투표로 잡힘') : '끝까지 숨었어요!';
    return `<div class="spy-row"><b>🕵️ ${esc(p.name)}</b><small>${how}</small></div>`;
  }).join('');
  const tally = (s.tally || []).slice(0, 8).map(t => `<div class="row ${t.spy ? 'spy' : ''}"><span class="nm">${esc(t.name)}${t.spy ? ' 🕵️' : ''}</span>
      <span class="bar"><i style="width:${t.votes / max * 100}%"></i></span><b>${t.votes}</b></div>`).join('') || '<div class="muted">투표 없이 끝났어요</div>';
  const roles = s.players.filter(p => p.inRound).map(p => p.spy
    ? `<div class="spy"><b>${esc(p.name)}</b><span>🕵️ 스파이</span></div>`
    : `<div><b>${esc(p.name)}</b><span>${esc(p.role ? p.role.meaning : '')}</span></div>`).join('');
  return `<div class="result-head ${s.winner}"><div class="big">${spyWin ? '🕵️' : '🎉'}</div>
      <h2>${spyWin ? '스파이 승리!' : '시민 승리!'}</h2><p class="sub" style="margin:0">${esc(s.winReason)}</p></div>
    <div class="result-loc"><small>비밀 장소</small><span class="big-ic">${esc(s.location.icon)}</span><span class="en">${esc(s.location.name)}</span><span class="ko">${esc(s.location.meaning)}</span></div>
    <div class="result-cols">
      <div><h3>스파이 ${s.spies.length}명</h3><div class="spy-list">${spyRows}</div></div>
      <div><h3>투표 결과</h3><div class="tally">${tally}</div></div>
    </div>
    <div style="margin-top:18px"><h3 style="font-size:14px;color:var(--muted);margin:0 0 8px">우리 반 역할 카드</h3><div class="role-grid">${roles}</div></div>
    <div class="modal-actions"><button class="btn" data-close="resultModal">닫기</button>
      <button class="btn primary" onclick="$('#btnNewRound').click()">새 판 시작</button></div>`;
}

function showResult(s) {
  resultShownRound = s.round;
  $('#resultBody').innerHTML = resultHTML(s);
  openModal('resultModal');
}

// ---------------- 실시간 중계 연출 ----------------
// 상태가 바뀔 때마다 이전 상태와 비교해서 "스파이 추측 → 투표 공개 → 장소 공개" 순서로 큰 화면 연출을 보여준다.
const fxQueue = [];
let fxBusy = false;

function queueEffects(prev, s) {
  if (!prev) return;
  if (prev.round !== s.round) {
    fxQueue.push({ kind: 'round', s });
    return runFx();
  }
  const seen = new Set(prev.events.map(e => e.seq));
  if (prev.phase === 'lobby' && s.phase === 'play') fxQueue.push({ kind: 'start', s });
  s.events.filter(e => !seen.has(e.seq) && e.when === 'play').forEach(e => fxQueue.push({ kind: 'guess', e, s }));
  if (prev.phase === 'play' && s.phase === 'vote') fxQueue.push({ kind: 'vote', timeout: s.timeouts > prev.timeouts });
  if (prev.phase === 'vote' && (s.phase === 'last' || s.phase === 'over') && s.caught) fxQueue.push({ kind: 'tally', s });
  if (prev.phase === 'vote' && s.phase === 'last') fxQueue.push({ kind: 'last', s });
  if (prev.phase === 'last' && s.phase === 'over') {
    s.events.filter(e => e.when === 'last' && e.guess).forEach(e => fxQueue.push({ kind: 'lastguess', e }));
    if (s.timeouts > prev.timeouts && !s.events.some(e => e.when === 'last')) fxQueue.push({ kind: 'lasttimeout' });
  }
  if (prev.phase !== 'over' && s.phase === 'over') {
    // 아직 정체가 안 드러난 스파이가 있으면 장소 공개 전에 먼저 크게 공개한다
    const hidden = s.spies.filter(p => !p.out && !p.caught);
    if (hidden.length && !s.events.some(e => e.when === 'play' && e.correct)) fxQueue.push({ kind: 'spyreveal', spies: hidden });
    fxQueue.push({ kind: 'win', s });
  }
  runFx();
}

function runFx() {
  if (fxBusy || !fxQueue.length) return;
  fxBusy = true;
  const job = fxQueue.shift();
  const box = $('#fx');
  let ms = 2400;
  const later = [];  // 연출 중간에 이어서 보여줄 것들 (타이머)
  if (job.kind === 'round') {
    box.innerHTML = `<div class="fx-band ink">${job.s.round}번째 판 준비!<small>오늘의 장소 후보를 읽어 보고 ▶ 게임 시작</small></div>`;
    sound('turn');
    ms = 1800;
  } else if (job.kind === 'start') {
    box.innerHTML = `<div><div class="fx-big">🕵️ 스파이 ${job.s.spyCount}명이<br>숨어들었다!</div>
      <div class="fx-sub">휴대폰에서 내 카드를 눌러 확인하세요 · 친구에게 보여주면 안 돼요!</div>
      <div class="fx-sub" style="opacity:.8">첫 질문: 🎤 ${name(job.s.turn && job.s.turn.asker)}</div></div>`;
    sound('start');
    ms = 3600;
  } else if (job.kind === 'guess') {
    const e = job.e;
    const c = job.s.candidates.find(x => x.name === e.guess) || { name: e.guess, meaning: '' };
    box.innerHTML = `<div><div class="fx-label">🚨 스파이 등장! <b>${name(e.by)}</b> 학생이 정체를 밝혔어요</div>
      <div class="fx-guess">${esc(c.icon || '')} "${esc(c.name)}?"<small>${esc(c.meaning)}</small></div>
      <div id="fxVerdict"></div></div>`;
    sound('drum');
    later.push(setTimeout(() => {
      $('#fxVerdict').innerHTML = e.correct
        ? '<div class="fx-verdict good">정답! 🕵️ 스파이 승리</div>'
        : '<div class="fx-verdict bad">땡! 틀렸어요 ❌</div><div class="fx-sub">스파이 정체가 드러났어요. 남은 스파이를 찾아라!</div>';
      sound(e.correct ? 'spywin' : 'bad');
    }, 2200));
    ms = 5200;
  } else if (job.kind === 'vote') {
    box.innerHTML = `<div class="fx-band">${job.timeout ? '⏰ 시간 끝!' : '🗳 투표 시작!'}<small>휴대폰에서 스파이라고 생각하는 친구에게 투표하세요</small></div>`;
    sound('alarm');
    ms = 2400;
  } else if (job.kind === 'tally') {
    const caught = job.s.caught;
    const votes = Object.fromEntries((job.s.tally || []).map(t => [t.id, t.votes]));
    if (!caught.length) {
      box.innerHTML = `<div><div class="fx-big">🤷 아무도<br>안 잡혔어요</div><div class="fx-sub">투표가 없었어요</div></div>`;
      ms = 2400;
    } else {
      box.innerHTML = `<div><div class="fx-label">🗳 표를 가장 많이 받은 ${caught.length > 1 ? caught.length + '명' : '사람'}은...</div>
        <div class="fx-cards">${caught.map((p, i) => `<div class="fx-pcard" id="pc${i}">
          <div class="face front"><div class="ic">❔</div><div class="nm">${esc(p.name)}</div><div class="votes">${votes[p.id] || 0}표</div></div>
          <div class="face back ${p.spy ? 'spy' : 'citizen'}"><div class="ic">${p.spy ? '🕵️' : '🙂'}</div><div class="nm">${esc(p.name)}</div>
            <div class="what">${p.spy ? '스파이였다!' : '시민이었다...'}</div></div></div>`).join('')}</div></div>`;
      sound('drum');
      caught.forEach((p, i) => later.push(setTimeout(() => {
        $('#pc' + i).classList.add('flipped');
        sound(p.spy ? 'good' : 'bad');
      }, 1800 + i * 1500)));
      ms = 1800 + caught.length * 1500 + 1800;
    }
  } else if (job.kind === 'last') {
    const names = (job.s.lastWaiting || []).map(p => esc(p.name)).join(', ');
    box.innerHTML = `<div class="fx-band gold">마지막 기회!<small>잡힌 스파이 ${names} · 장소를 맞히면 역전승!</small></div>`;
    sound('alarm');
    ms = 2600;
  } else if (job.kind === 'lastguess') {
    const e = job.e;
    box.innerHTML = `<div><div class="fx-label">🕵️ ${name(e.by)}의 마지막 추측은...</div>
      <div class="fx-guess">"${esc(e.guess)}?"</div><div id="fxVerdict"></div></div>`;
    sound('drum');
    later.push(setTimeout(() => {
      $('#fxVerdict').innerHTML = e.correct ? '<div class="fx-verdict good">정답! 역전승 🕵️</div>' : '<div class="fx-verdict bad">땡! ❌</div>';
      sound(e.correct ? 'spywin' : 'bad');
    }, 2000));
    ms = 4200;
  } else if (job.kind === 'spyreveal') {
    box.innerHTML = `<div><div class="fx-label">🕵️ 진짜 스파이는...</div>
      <div class="fx-cards">${job.spies.map((p, i) => `<div class="fx-pcard" id="sr${i}">
        <div class="face front"><div class="ic">❔</div><div class="nm">???</div></div>
        <div class="face back spy"><div class="ic">🕵️</div><div class="nm">${esc(p.name)}</div><div class="what">스파이!</div></div></div>`).join('')}</div></div>`;
    sound('drum');
    job.spies.forEach((p, i) => later.push(setTimeout(() => { $('#sr' + i).classList.add('flipped'); sound('spywin'); }, 1600 + i * 1200)));
    ms = 1600 + job.spies.length * 1200 + 1800;
  } else if (job.kind === 'lasttimeout') {
    box.innerHTML = `<div class="fx-band ink">⏰ 시간 초과!<small>잡힌 스파이가 장소를 고르지 못했어요</small></div>`;
    ms = 2000;
  } else if (job.kind === 'win') {
    const s = job.s, spyWin = s.winner === 'spy';
    box.innerHTML = `<div><div class="fx-label">비밀 장소는...</div>
      <div class="fx-loc"><span class="big-ic">${esc(s.location.icon)}</span><span class="en">${esc(s.location.name)}</span><span class="ko">${esc(s.location.meaning)}</span></div>
      <div class="fx-verdict ${spyWin ? 'bad' : 'good'}">${spyWin ? '🕵️ 스파이 승리!' : '🎉 시민 승리!'}</div>
      <div class="fx-sub" style="font-size:clamp(26px,3.2vw,52px)">🕵️ 스파이는 <b style="color:#ff9c92">${s.spies.map(p => esc(p.name)).join(', ')}</b></div></div>`;
    sound('win');
    confetti(spyWin ? 'spy' : 'citizen');
    ms = 4200;
  }
  box.classList.remove('hidden');
  const done = () => {
    clearTimeout(timer);
    later.forEach(clearTimeout);
    box.onclick = null;
    box.classList.add('hidden');
    if (job.kind === 'win' && state && state.phase === 'over' && state.round === job.s.round) showResult(state);
    fxBusy = false;
    setTimeout(runFx, 150);
  };
  const timer = setTimeout(done, ms);
  box.onclick = done; // 클릭하면 바로 넘기기
}

// 승리 축하 꽃가루
function confetti(side) {
  const cv = document.createElement('canvas');
  cv.className = 'confetti';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  const W = cv.width = innerWidth, H = cv.height = innerHeight;
  const colors = side === 'spy' ? ['#20242f', '#c8372d', '#e9a817', '#ffffff'] : ['#1f8a5b', '#8fe0b6', '#e9a817', '#ffffff'];
  const ps = Array.from({ length: 220 }, () => ({
    x: Math.random() * W, y: -20 - Math.random() * H * 0.6, vx: (Math.random() - .5) * 3, vy: 2 + Math.random() * 4,
    r: 5 + Math.random() * 7, a: Math.random() * Math.PI, va: (Math.random() - .5) * .3,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    ctx.clearRect(0, 0, W, H);
    ps.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.vy += .04; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
      ctx.fillStyle = p.c; ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
      ctx.restore();
    });
    if (now - start < 4500) requestAnimationFrame(frame); else cv.remove();
  })(start);
}

// 효과음 (파일 없이 브라우저에서 바로 만든 소리). 버튼으로 켜고 끈다.
let audio = null;
let soundOn = false;
try { soundOn = localStorage.getItem('sf_sound') === '1'; } catch (e) { /* 무시 */ }

function updateSoundBtn() { $('#btnSound').textContent = soundOn ? '🔊 효과음' : '🔇 효과음'; }
updateSoundBtn();
$('#btnSound').onclick = () => {
  soundOn = !soundOn;
  try { localStorage.setItem('sf_sound', soundOn ? '1' : '0'); } catch (e) { /* 무시 */ }
  updateSoundBtn();
  if (soundOn) sound('ask');
};

const SOUNDS = {
  ask: [[660, .1], [880, .16]],
  good: [[523, .09], [659, .09], [784, .22]],
  bad: [[233, .18, 'sawtooth'], [196, .32, 'sawtooth']],
  turn: [[440, .08], [554, .14]],
  tick: [[1046, .06]],
  drum: [[110, .08, 'square'], [110, .08, 'square'], [110, .08, 'square'], [123, .08, 'square'], [131, .08, 'square'], [147, .3, 'square']],
  alarm: [[880, .14, 'square'], [660, .14, 'square'], [880, .14, 'square'], [660, .2, 'square']],
  start: [[392, .12], [330, .12], [262, .12], [196, .4, 'sawtooth']],
  spywin: [[196, .2, 'sawtooth'], [233, .2, 'sawtooth'], [294, .5, 'sawtooth']],
  win: [[523, .12], [659, .12], [784, .12], [1047, .45]],
};

function sound(nm) {
  if (!soundOn || !SOUNDS[nm]) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    let t = audio.currentTime + .02;
    for (const [f, d, type] of SOUNDS[nm]) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type || 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(.0001, t);
      g.gain.exponentialRampToValueAtTime(.22, t + .02);
      g.gain.exponentialRampToValueAtTime(.0001, t + d);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + d + .05);
      t += d * .9;
    }
  } catch (e) { /* 소리가 안 나도 게임은 계속 */ }
}

// 질문 시간은 마지막 10초, 투표·마지막 기회는 마지막 5초부터 째깍 소리
function onTimerSecond(sec, phase) {
  if (sec > 0 && sec <= (phase === 'play' ? 10 : 5)) sound('tick');
}
