/* =========================================================================
 * demo.js — 라이브 ECG 모니터 (demo.html)
 *  실시간 파형 · QRS 검출 · 분류 판정 · 이벤트 로그 · 세션 요약 · 캡처
 * ========================================================================= */

import { RHYTHMS, ARRHYTHMIA_CATALOG } from './ecg.js';
import { EcgMonitor, makeEventEl, severityClass, fmtTime } from './monitor.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* 리듬 버튼 정의 (카탈로그 순서 = 모니터 지원 순서) */
const RHYTHM_BUTTONS = [
  { key: 'normal', label: '정상 리듬', color: '#16e0a3' },
  { key: 'brady', label: '서맥', color: '#a78bfa' },
  { key: 'tachy', label: '동성빈맥', color: '#38bdf8' },
  { key: 'afib', label: '심방세동', color: '#ffc23d' },
  { key: 'pvc', label: '심실조기수축', color: '#5ea8ff' },
  { key: 'vt', label: '심실빈맥', color: '#ff5470' },
];

const state = {
  beats: 0,
  hrSum: 0,
  hrN: 0,
  hrvSum: 0,
  hrvN: 0,
  alerts: 0,
  history: [],
  lastKey: '',
};

/* ======================================================================
 * 토스트
 * ==================================================================== */
let toastEl = null;
let toastTimer = null;
function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2600);
}

/* ======================================================================
 * 위험 점수 (0–100)
 * ==================================================================== */
function riskScore(res) {
  if (!res || res.type === 'analyzing') return null;
  const base = { normal: 4, tachy: 16, brady: 22, afib: 52, pvc: 46, vt: 88 }[res.type] || 10;
  const bonus = (res.conf || 0) * 0.12;
  const pvcBonus = res.pvcCount ? Math.min(10, res.pvcCount * 2.4) : 0;
  return Math.max(1, Math.min(100, Math.round(base + bonus + pvcBonus)));
}

const SEV_LABEL = { 0: '0 · 정상', 1: '1 · 관찰', 2: '2 · 경고', 3: '3 · 응급' };

/* ======================================================================
 * 부트
 * ==================================================================== */
function boot() {
  /* ---------- 내비 ---------- */
  const toggle = $('#nav-toggle');
  const links = $('#nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const open = links.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  /* ---------- DOM 참조 ---------- */
  const el = {
    hr: $('#big-hr'), rhythm: $('#big-rhythm'), hrv: $('#big-hrv'),
    sdnn: $('#big-sdnn'), pnn: $('#big-pnn'), sqi: $('#big-sqi'),
    verdictCard: $('#verdict-card'), vType: $('#verdict-type'), vEn: $('#verdict-en'),
    confFill: $('#conf-fill'), confVal: $('#conf-val'), vRisk: $('#v-risk'),
    vSev: $('#v-sev'), vNote: $('#verdict-note'),
    log: $('#event-log'), timeline: $('#timeline'), histCount: $('#history-count'),
    elapsed: $('#s-elapsed'), beats: $('#s-beats'), win: $('#s-window'),
    statusDot: $('#status-dot'), statusText: $('#status-text'),
    kQrs: $('#k-qrs'), kThr: $('#k-thr'), kBuf: $('#k-buf'),
    kWidth: $('#k-width'), kClass: $('#k-class'), kConf: $('#k-conf'),
    sumBeats: $('#sum-beats'), sumAvg: $('#sum-avg'), sumHrv: $('#sum-hrv'), sumAlerts: $('#sum-alerts'),
    bottom: document.createElement('div'),
  };

  /* ---------- 모니터 ---------- */
  const monitor = new EcgMonitor({
    mainCanvas: $('#canvas-main'),
    rawCanvas: $('#canvas-raw'),
    fs: 500,
    windowSec: 10,
    grid: true,
    big: true,
    noiseOn: false,
    filterOn: true,
    motionOn: true,
    onUpdate: (s) => {
      const res = s.result;
      el.elapsed.textContent = fmtTime(s.elapsed);
      el.beats.textContent = String(s.beats);
      el.win.textContent = `${monitor.windowSec.toFixed(1)} s`;
      el.kThr.textContent = s.threshold ? s.threshold.toExponential(2) : '—';
      el.kBuf.textContent = `${s.bufferLen} / 26`;
      el.kWidth.textContent = s.widthIdx ? s.widthIdx.toFixed(2) : '—';
      el.kQrs.textContent = s.qrsFlag ? '검출' : '대기';

      if (!res) return;
      if (res.hr) el.hr.textContent = String(res.hr);
      if (res.hrv != null) el.hrv.textContent = String(res.hrv);
      if (res.sdnn != null) el.sdnn.textContent = String(res.sdnn);
      if (res.pnn50 != null) el.pnn.textContent = String(res.pnn50);
      if (res.sqi != null) el.sqi.textContent = String(res.sqi);

      el.vType.textContent = res.label;
      el.vEn.textContent = res.short;
      el.kClass.textContent = res.short;

      const sev = res.severity || 0;
      const color = sev >= 3 ? '#ff5470' : sev === 2 ? '#ffc23d' : '#16e0a3';

      const conf = res.conf || 0;
      el.confFill.style.width = `${conf}%`;
      el.confVal.textContent = conf ? `${conf}%` : '—';
      el.confFill.style.background = `linear-gradient(90deg, ${color}, ${color}cc)`;
      el.kConf.style.width = `${conf}%`;
      el.kConf.style.background = color;

      el.vType.style.color = color;
      el.rhythm.textContent = res.type === 'analyzing' ? '분석 중' : res.label;
      el.rhythm.className = 'verdict-mini'
        + (sev >= 3 ? ' verdict-mini--alert' : sev === 2 ? ' verdict-mini--warn' : '');

      el.verdictCard.className = `verdict ${severityClass(sev)}`;

      const risk = riskScore(res);
      el.vRisk.textContent = risk == null ? '—' : String(risk);
      el.vRisk.style.color = color;
      el.vSev.textContent = SEV_LABEL[sev] || '—';
      el.vSev.style.color = color;

      el.vNote.textContent = res.type === 'analyzing'
        ? '최소 5회 심박이 검출되어야 판정이 시작됩니다.'
        : `RR ${res.beats}개 분석 · RMSSD ${res.hrv} ms · QRS 폭 지수 ${s.widthIdx.toFixed(2)}`
          + (res.pvcCount ? ` · 조기박동 ${res.pvcCount}회` : '');
    },
    onEvent: (ev) => {
      const empty = el.log.querySelector('.event-log__empty');
      if (empty) empty.remove();
      el.log.insertBefore(makeEventEl(ev), el.log.firstChild);
      while (el.log.children.length > 45) el.log.removeChild(el.log.lastChild);
    },
    onBeat: (res) => {
      if (!res || res.type === 'analyzing') return;
      state.beats = monitor.stats.beats;
      if (res.hr) { state.hrSum += res.hr; state.hrN++; }
      if (res.hrv != null) { state.hrvSum += res.hrv; state.hrvN++; }
      el.sumBeats.textContent = String(state.beats);
      el.sumAvg.textContent = state.hrN ? String(Math.round(state.hrSum / state.hrN)) : '—';
      el.sumHrv.textContent = state.hrvN ? String(Math.round(state.hrvSum / state.hrvN)) : '—';

      // 새 판정만 타임라인에 추가
      if (res.type !== state.lastKey) {
        state.lastKey = res.type;
        if (res.severity >= 2) state.alerts++;
        el.sumAlerts.textContent = String(state.alerts);
        addTimeline(res);
      }
    },
  });

  function addTimeline(res) {
    const sev = res.severity || 0;
    const li = document.createElement('li');
    li.className = 'timeline__item' + (sev >= 3 ? ' timeline__item--alert' : sev === 2 ? ' timeline__item--warn' : '');

    const top = document.createElement('div');
    top.className = 'timeline__top';
    const name = document.createElement('span');
    name.className = 'timeline__name';
    name.textContent = res.label;
    const meta = document.createElement('span');
    meta.className = 'timeline__meta';
    meta.textContent = `${fmtTime(monitor.stats.elapsed)} · ${res.conf}%`;
    top.appendChild(name);
    top.appendChild(meta);
    li.appendChild(top);

    const conf = document.createElement('div');
    conf.className = 'timeline__conf';
    const risk = riskScore(res);
    conf.textContent = `HR ${res.hr} bpm · RMSSD ${res.hrv} ms · 위험 ${risk}/100`;
    li.appendChild(conf);

    const empty = el.timeline.querySelector('.timeline__empty');
    if (empty) empty.remove();
    el.timeline.insertBefore(li, el.timeline.firstChild);
    while (el.timeline.children.length > 30) el.timeline.removeChild(el.timeline.lastChild);

    state.history.push({ type: res.type, label: res.label, conf: res.conf, t: monitor.stats.elapsed });
    el.histCount.textContent = `${state.history.length}건`;
  }

  /* ---------- 리듬 버튼 ---------- */
  const btnWrap = $('#rhythm-btns');
  const hint = $('#rhythm-hint');
  RHYTHM_BUTTONS.forEach((r) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rhythm-btn';
    btn.dataset.rhythm = r.key;
    btn.setAttribute('aria-pressed', 'false');
    const dot = document.createElement('span');
    dot.className = 'rhythm-btn__dot';
    dot.style.background = r.color;
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(r.label));
    btn.addEventListener('click', () => selectRhythm(r.key));
    btnWrap.appendChild(btn);
  });

  function selectRhythm(key) {
    monitor.setRhythm(key);
    $$('.rhythm-btn', btnWrap).forEach((b) => {
      const on = b.dataset.rhythm === key;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    state.lastKey = '';    // 같은 클래스가 이어져도 새 판정으로 기록
    const p = RHYTHMS[key];
    if (hint) hint.textContent = `${p.label} (${p.short}) — 기대 심박 ${p.bpm[0]}–${p.bpm[1]} bpm`;
    markExpect(key);
  }

  /* ---------- 리듬별 기대 지표 ---------- */
  const expectList = $('#expect-list');
  function markExpect(key) {
    if (!expectList) return;
    Array.from(expectList.children).forEach((c) => {
      const on = c.dataset.key === key;
      c.style.color = on ? 'var(--text)' : 'var(--text-dim)';
      c.style.fontWeight = on ? '600' : '400';
    });
  }
  if (expectList) {
    RHYTHM_BUTTONS.forEach((r) => {
      const p = RHYTHMS[r.key];
      const cat = ARRHYTHMIA_CATALOG.find((c) => c.key === r.key);
      const row = document.createElement('div');
      row.className = 'kv';
      row.dataset.key = r.key;
      const label = document.createElement('span');
      label.textContent = p.label;
      const val = document.createElement('b');
      val.textContent = `${p.bpm[0]}–${p.bpm[1]} bpm`;
      row.appendChild(label);
      row.appendChild(val);
      if (cat) row.title = cat.desc;
      expectList.appendChild(row);
    });
  }

  /* ---------- 옵션 ---------- */
  const optNoise = $('#opt-noise');
  const optFilter = $('#opt-filter');
  const optMotion = $('#opt-motion');
  const optSpeed = $('#opt-speed');
  const optSpeedVal = $('#opt-speed-val');
  const optGain = $('#opt-gain');
  const optGainVal = $('#opt-gain-val');
  const optNotch = $('#opt-notch');
  const optNotchVal = $('#opt-notch-val');

  optNoise.addEventListener('change', () => {
    monitor.setNoise(optNoise.checked);
    toast(optNoise.checked ? '60Hz 전원 잡음을 주입했습니다.' : '전원 잡음을 제거했습니다.');
  });
  optMotion.addEventListener('change', () => {
    monitor.setMotion(optMotion.checked);
    toast(optMotion.checked ? '운동 아티팩트를 활성화했습니다.' : '운동 아티팩트를 비활성화했습니다.');
  });
  optFilter.addEventListener('change', () => {
    monitor.setFilter(optFilter.checked);
    monitor.onEvent({
      level: optFilter.checked ? 'ok' : 'warn',
      title: optFilter.checked ? '필터 체인 활성화' : '필터 체인 해제',
      detail: optFilter.checked
        ? '60Hz 노치 → 0.5Hz 하이패스 → 40Hz 로우패스'
        : '기저선 동요와 고주파 잡음이 그대로 노출됩니다 — 검출 정확도 저하',
    });
    toast(optFilter.checked ? '필터 체인을 적용했습니다.' : '필터를 해제했습니다. 파형이 거칠어집니다.');
  });
  optSpeed.addEventListener('input', () => {
    const v = Number(optSpeed.value);
    monitor.setSpeed(v);
    optSpeedVal.textContent = `${v} mm/s`;
  });
  optGain.addEventListener('input', () => {
    const v = Number(optGain.value) / 10;
    monitor.setGain(v);
    optGainVal.textContent = `${v.toFixed(1)}×`;
  });
  optNotch.addEventListener('input', () => {
    const v = Number(optNotch.value);
    monitor.setNotchFreq(v);
    optNotchVal.textContent = `${v} Hz`;
  });

  /* ---------- 상태 바 버튼 ---------- */
  const btnPause = $('#btn-pause');
  btnPause.addEventListener('click', () => {
    const paused = !monitor.paused;
    monitor.pause(paused);
    btnPause.textContent = paused ? '재생' : '일시정지';
    btnPause.setAttribute('aria-pressed', String(paused));
    el.statusText.textContent = paused ? '일시정지됨' : '시뮬레이션 실행 중';
    el.statusDot.classList.toggle('is-paused', paused);
  });

  const btnReset = $('#btn-reset');
  btnReset.addEventListener('click', () => {
    state.beats = 0; state.hrSum = 0; state.hrN = 0; state.hrvSum = 0; state.hrvN = 0;
    state.alerts = 0; state.history = []; state.lastKey = '';
    el.sumBeats.textContent = '0'; el.sumAvg.textContent = '—';
    el.sumHrv.textContent = '—'; el.sumAlerts.textContent = '0';
    el.histCount.textContent = '0건';
    el.timeline.innerHTML = '<li class="timeline__empty">아직 판정 기록이 없습니다.</li>';
    el.log.innerHTML = '<p class="event-log__empty">로그를 초기화했습니다.</p>';
    el.vRisk.textContent = '—'; el.vSev.textContent = '—';
    el.vSev.style.color = ''; el.vRisk.style.color = '';
    el.vType.textContent = '분석 중…'; el.vType.style.color = '';
    el.vEn.textContent = 'accumulating RR intervals';
    el.confFill.style.width = '0%'; el.confVal.textContent = '—';
    monitor.classifier.reset();
    monitor.detector.reset();
    monitor.stats.beats = 0;
    monitor.stats.elapsed = 0;
    const snap = $('#snapshot-box');
    if (snap) snap.classList.remove('is-on');
    selectRhythm('normal');
    monitor.onEvent({ level: 'info', title: '세션 초기화', detail: '판정 이력과 통계를 모두 리셋했습니다.' });
    toast('세션을 초기화했습니다.');
  });

  const btnSnap = $('#btn-snapshot');
  btnSnap.addEventListener('click', () => {
    const data = monitor.snapshot();
    if (!data) { toast('캡처할 파형이 없습니다.'); return; }
    const box = $('#snapshot-box');
    const img = $('#snapshot-img');
    if (box && img) {
      img.src = data;
      box.classList.add('is-on');
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    monitor.onEvent({
      level: 'ok', title: '파형 캡처 저장',
      detail: `${fmtTime(monitor.stats.elapsed)} 시점 · 현재 창 ${monitor.windowSec.toFixed(1)}초`,
    });
    toast('현재 파형을 캡처했습니다. 아래에서 확인하세요.');
  });

  const logClear = $('#log-clear');
  logClear.addEventListener('click', () => {
    el.log.innerHTML = '<p class="event-log__empty">로그를 지웠습니다.</p>';
  });

  /* ---------- 시작 ---------- */
  el.statusText.textContent = '시뮬레이션 실행 중';
  monitor.start();
  selectRhythm('normal');
  // 필터 on 상태를 초기 UI와 동기화
  monitor.setFilter(optFilter.checked);
  monitor.setNoise(optNoise.checked);
  monitor.setMotion(optMotion.checked);
  monitor.setSpeed(Number(optSpeed.value));
  monitor.setGain(Number(optGain.value) / 10);
  monitor.setNotchFreq(Number(optNotch.value));

  monitor.onEvent({
    level: 'info', title: '시뮬레이터 시작',
    detail: `합성 리듬 생성 · ${monitor.fs} Hz · 필터 체인 적용 · QRS 검출 대기`,
  });

  /* ---------- 리사이즈 ---------- */
  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => monitor.resize(), 130);
  });

  /* ---------- 탭 비활성 시 정지 (자원 절약) ---------- */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) monitor.stop();
    else monitor.start();
  });

  void el.bottom;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
