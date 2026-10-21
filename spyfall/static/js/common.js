// 선생님 화면과 학생 화면이 같이 쓰는 함수들
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function $(sel, root) { return (root || document).querySelector(sel); }

function toast(msg, type) {
  let wrap = $('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function openModal(id) { $('#' + id).classList.remove('hidden'); }
function closeModal(id) { $('#' + id).classList.add('hidden'); }
document.addEventListener('click', e => {
  const open = e.target.closest('[data-open]');
  if (open) openModal(open.dataset.open);
  const close = e.target.closest('[data-close]');
  if (close) closeModal(close.dataset.close);
});

// 스파이 / 시민 포스터 그림 (결과 공개 연출, 결과 화면, 스파이 카드)
const POSTER = { spy: '/static/img/spy.webp', citizen: '/static/img/citizen.webp' };

// 공개 카드 뒷면: 포스터 + 아래 이름 띠
function posterFace(kind, nameHTML, what) {
  return `<div class="face back poster ${kind}" style="background-image:url('${POSTER[kind]}')">
    <div class="pc-band"><div class="nm">${nameHTML}</div>${what ? `<div class="what">${what}</div>` : ''}</div></div>`;
}

function locHTML(c, extra) {
  const pic = c.thumb ? `<img src="${esc(c.thumb)}" alt="">` : esc(c.icon || '📍');
  return `<span class="ic">${pic}</span><span class="tx"><span class="en">${esc(c.name)}</span><span class="ko">${esc(c.meaning)}</span></span>${extra || ''}`;
}

// 큰 장소 그림 (없으면 큰 이모지)
function bigPic(loc) {
  return loc.img ? `<img class="loc-img" src="${esc(loc.img)}" alt="">` : `<span class="big-ic">${esc(loc.icon || '📍')}</span>`;
}

function rulesHTML() {
  return `<div class="rules">
    <ol>
      <li>모두의 휴대폰에 <b>같은 장소</b>와 <b>역할</b>이 나와요. (예: <span class="ex">Hospital</span> 병원 / 역할: 간호사)</li>
      <li>단, <b>스파이 🕵️</b>의 휴대폰에는 장소가 나오지 않아요. 스파이는 보통 1명 (9명 이상이면 2명)!</li>
      <li><b>질문 차례</b>인 사람이 휴대폰에서 친구를 고르고, 그 친구에게 말로 질문해요.
        <br>예) <span class="ex">여기 표가 필요해?</span></li>
      <li>질문 받은 친구는 말로 대답한 뒤 <b>[답변했어요]</b>를 누르고, 이번엔 내가 질문할 친구를 골라요.
        (방금 나에게 질문한 친구는 고를 수 없어요)</li>
      <li>🚨 <b>지목 투표</b>: 질문 시간 중 누구나 한 판에 한 번 "스파이 지목하기"를 할 수 있어요.
        지목당한 친구 빼고 <b>모두 찬성</b>하면 정체 공개 (한 명이라도 반대하면 무산). 시민을 지목하면 스파이가 이겨요!</li>
      <li>시간이 끝나면 <b>스파이라고 생각하는 친구</b>에게 휴대폰으로 투표해요.
        표를 많이 받은 사람(스파이 수만큼)의 정체가 공개돼요.</li>
      <li><b>시민 승리</b>: 숨은 스파이를 <b>절반 이상</b> 찾아내면!<br>
        <b>스파이 승리</b>: 끝까지 숨거나, <b>장소를 맞히면!</b> (잡힌 스파이도 마지막 기회로 장소를 맞히면 역전)</li>
    </ol>
    <div class="tip" style="background:#e9f6ef">
      🏆 <b>점수</b> (판마다 쌓여요)<br>
      · 스파이: 끝까지 안 들킴 <b>+4</b> · 질문 시간에 장소 맞힘 <b>+3</b> (빨리 맞히면 +1~3 더) · 잡혔지만 마지막에 맞힘 <b>+3</b><br>
      · 시민: 투표에서 스파이를 고름 <b>+2</b> · 지목 투표로 스파이를 잡음 <b>+2</b> (빨리 잡으면 +1~3 더, 지목한 사람 +1) · 시민 팀 승리 <b>+1</b>
    </div>
    <div class="tip">
      ✏️ <b>꿀팁</b><br>
      · 시민: 너무 쉽게 대답하면 스파이가 장소를 알아채요. 살짝 애매하게!<br>
      · 스파이: 다른 친구들의 대답을 잘 듣고 장소를 추리해요. 알 것 같으면 언제든 <b>장소 맞히기</b>! (틀리면 정체가 드러나요)<br>
      · 휴대폰 카드는 <b>친구에게 보여주면 안 돼요.</b> 볼 때만 눌러서 확인하세요.
    </div>
  </div>`;
}

// ---------- 제한시간 ----------
// 서버가 보내준 "남은 초"로 이 기기 시계 기준 마감 시각을 잡고, 0.2초마다 [data-timer] 표시를 갱신한다.
let timerEnd = null, timerPaused = null, timerLimit = 60, timerPhase = null, lastWholeSec = null;

function syncTimer(s) {
  timerLimit = s.timeLimit || 60;
  timerPhase = s.phase;
  if (s.timeLeft == null || !['play', 'vote', 'last'].includes(s.phase)) { timerEnd = null; timerPaused = null; }
  else if (s.paused) { timerPaused = s.timeLeft; timerEnd = null; }
  else { timerEnd = performance.now() + s.timeLeft * 1000; timerPaused = null; }
}

function timerLeft() {
  if (timerPaused != null) return timerPaused;
  if (timerEnd == null) return null;
  return Math.max(0, (timerEnd - performance.now()) / 1000);
}

function fmtTime(sec) {
  const t = Math.ceil(sec);
  return t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : String(t);
}

function clockHTML(label) {
  const left = timerLeft();
  const pct = left == null ? 0 : Math.min(100, left / timerLimit * 100);
  return `<div class="clock" data-timer><div class="c-num">${left == null ? '' : (timerPaused != null ? '⏸' : fmtTime(left))}</div>
    <div class="c-lbl">${esc(label || '남은 시간')}</div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
}

setInterval(() => {
  const left = timerLeft();
  const whole = left == null ? null : Math.ceil(left);
  // 질문 시간은 1분 남았을 때, 투표·마지막 기회는 10초 남았을 때부터 경고
  const warnAt = timerPhase === 'play' ? 60 : 10, dangerAt = timerPhase === 'play' ? 10 : 5;
  document.querySelectorAll('[data-timer]').forEach(el => {
    el.classList.toggle('hidden', left == null);
    if (left == null) return;
    el.querySelector('.c-num').textContent = timerPaused != null ? '⏸' : fmtTime(left);
    el.querySelector('.bar i').style.width = Math.min(100, left / timerLimit * 100) + '%';
    el.classList.toggle('warn', timerPaused == null && left <= warnAt && left > dangerAt);
    el.classList.toggle('danger', timerPaused == null && left <= dangerAt);
    el.classList.toggle('paused', timerPaused != null);
  });
  if (whole !== lastWholeSec) {
    lastWholeSec = whole;
    if (timerPaused == null && whole != null && typeof onTimerSecond === 'function') onTimerSecond(whole, timerPhase);
  }
}, 200);
