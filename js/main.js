/* =========================================================================
 * main.js — 브리핑 페이지 인터랙션
 *  · 스크롤 등장 효과 / 내비게이션
 *  · 히어로 파형 애니메이션
 *  · 리듬 파형 라이브러리 카드 (합성 미리보기)
 *  · AI 성능 차트 (Chart.js)
 *  · 미니 실시간 시뮬레이터 (EcgMonitor)
 *  · 문의 폼 → RESTful Table API
 * ========================================================================= */

import {
  synthWave, normalize, ARRHYTHMIA_CATALOG, SIGNAL_SOURCES, RHYTHMS, makeNoise,
} from './ecg.js';
import { EcgMonitor, makeEventEl, severityClass } from './monitor.js';
import { lineChart, barChart, buildTrainingData, buildClassData } from './charts.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ======================================================================
 * 1. 스크롤 등장 효과
 * ==================================================================== */
function initReveal() {
  const items = $$('.reveal');
  if (!items.length) return;
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });
  items.forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i % 4, 3) * 70}ms`;
    io.observe(el);
  });
}

/* ======================================================================
 * 2. 내비게이션
 * ==================================================================== */
function initNav() {
  const header = $('#site-header');
  const toggle = $('#nav-toggle');
  const links = $('#nav-links');

  const onScroll = () => {
    if (header) header.classList.toggle('is-scrolled', window.scrollY > 8);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const open = links.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
    });
    links.addEventListener('click', (e) => {
      if (e.target.closest('a')) {
        links.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // 현재 섹션 하이라이트
  const sections = $$('main section[id]');
  const navLinks = $$('#nav-links a[href^="#"]');
  if (!sections.length || !navLinks.length || !('IntersectionObserver' in window)) return;
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const id = `#${e.target.id}`;
      navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === id));
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  sections.forEach((s) => spy.observe(s));
}

/* ======================================================================
 * 3. 히어로 파형
 * ==================================================================== */
function initHeroWave() {
  const canvas = $('#hero-wave');
  const bpmEl = $('#hero-bpm');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0, h = 0;

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    w = Math.max(120, Math.round(r.width || 300));
    h = Math.max(60, Math.round(r.height || 120));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  // 정적 파형 버퍼를 만들고 스크롤하며 그린다
  const fs = 250;
  const speed = 160;                 // px/sec
  const wave = normalize(synthWave(14, fs, 'normal').samples);
  let offset = 0, last = performance.now();
  const noise = makeNoise('pink');

  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    offset = (offset + speed * dt) % (wave.length - 1);

    ctx.clearRect(0, 0, w, h);
    const base = h * 0.55;
    const amp = h * 0.34;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#16e0a3';
    ctx.lineWidth = 1.8;
    ctx.shadowColor = 'rgba(22,224,163,0.85)';
    ctx.shadowBlur = 8;
    ctx.beginPath();

    const secVisible = w / speed;
    const samples = Math.min(wave.length - 2, Math.round(secVisible * fs));
    const per = samples / w;
    for (let x = 0; x < w; x++) {
      const idx = Math.floor((offset + x * per)) % (wave.length - 2);
      const v = wave[idx] + 0.012 * noise();
      const y = base - v * amp;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (bpmEl && Math.random() < 0.03) {
      bpmEl.textContent = String(66 + Math.round(Math.random() * 10));
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* ======================================================================
 * 4. 리듬 파형 라이브러리
 * ==================================================================== */
function initWaveLibrary(onPick) {
  const grid = $('#wave-grid');
  if (!grid) return;

  ARRHYTHMIA_CATALOG.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'card wave-card reveal';
    card.setAttribute('role', 'listitem');
    card.tabIndex = 0;
    card.dataset.rhythm = item.key;
    card.setAttribute('aria-label', `${item.name} 파형 보기 및 데모 적용`);

    const head = document.createElement('div');
    head.className = 'wave-card__head';
    const titleWrap = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'wave-card__name';
    const dot = document.createElement('span');
    dot.className = 'wave-card__dot';
    dot.style.background = item.color;
    name.appendChild(dot);
    name.appendChild(document.createTextNode(item.name));
    const en = document.createElement('div');
    en.className = 'wave-card__en';
    en.textContent = item.en;
    titleWrap.appendChild(name);
    titleWrap.appendChild(en);
    head.appendChild(titleWrap);
    card.appendChild(head);

    const canvas = document.createElement('canvas');
    canvas.className = 'wave-card__canvas';
    canvas.setAttribute('aria-hidden', 'true');
    card.appendChild(canvas);

    const desc = document.createElement('p');
    desc.className = 'wave-card__desc';
    desc.textContent = item.desc;
    card.appendChild(desc);

    grid.appendChild(card);
    drawPreview(canvas, item);

    const pick = () => {
      $$('.wave-card').forEach((c) => c.classList.remove('is-active'));
      card.classList.add('is-active');
      if (typeof onPick === 'function') onPick(item.key);
      const target = $('#demo');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
  });

  // 첫 카드 활성화
  const first = $('.wave-card');
  if (first) first.classList.add('is-active');
}

function drawPreview(canvas, item) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const draw = () => {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(80, Math.round(r.width || 220));
    const h = Math.max(48, Math.round(r.height || 72));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 3.2초 구간 미리보기
    const sec = 3.2;
    const data = normalize(synthWave(sec, 250, item.key).samples);

    // 배경 기준선
    ctx.strokeStyle = 'rgba(120,160,220,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.58);
    ctx.lineTo(w, h * 0.58);
    ctx.stroke();

    const base = h * 0.58, amp = h * 0.40;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = item.color;
    ctx.shadowBlur = 5;
    ctx.beginPath();
    const per = data.length / w;
    for (let x = 0; x < w; x++) {
      const idx = Math.min(data.length - 1, Math.floor(x * per));
      const y = base - data[idx] * amp;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  draw();
  window.addEventListener('resize', () => { requestAnimationFrame(draw); });
}

/* ======================================================================
 * 5. AI 성능 차트 (자체 캔버스 렌더러 — CDN 비의존)
 * ==================================================================== */
const chartInstances = [];

function initCharts() {
  const trainCanvas = $('#chart-training');
  if (trainCanvas) {
    chartInstances.push(lineChart(trainCanvas, buildTrainingData()));
  }
  const classCanvas = $('#chart-classes');
  if (classCanvas) {
    chartInstances.push(barChart(classCanvas, buildClassData()));
  }

  // 컨테이너 크기가 바뀌면 다시 그린다 (차트가 접힌 상태에서 초기화되는 문제 방지)
  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => chartInstances.forEach((c) => c.resize()), 140);
  });
  if ('ResizeObserver' in window) {
    [trainCanvas, classCanvas].forEach((cv) => {
      if (!cv) return;
      const ro = new ResizeObserver(() => {
        chartInstances.forEach((c) => c.resize());
      });
      ro.observe(cv.parentElement || cv);
    });
  }
}

/* ======================================================================
 * 6. 학습 데이터 목록
 * ==================================================================== */
function initSourceList() {
  const ul = $('#source-list');
  if (!ul) return;
  SIGNAL_SOURCES.forEach((s) => {
    const li = document.createElement('li');
    li.className = 'phase__item';
    const span = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = s.name;
    span.appendChild(b);
    span.appendChild(document.createTextNode(` — ${s.detail} · ${s.role}`));
    li.appendChild(span);
    ul.appendChild(li);
  });
}

/* ======================================================================
 * 7. 미니 시뮬레이터
 * ==================================================================== */
function initMiniMonitor() {
  const mainCanvas = $('#mini-canvas-main');
  const rawCanvas = $('#mini-canvas-raw');
  if (!mainCanvas) return;

  const btnWrap = $('#mini-rhythm-btns');
  const hrEl = $('#mini-hr');
  const hrvEl = $('#mini-hrv');
  const sqiEl = $('#mini-sqi');
  const verdictEl = $('#mini-verdict');
  const vType = $('#mini-verdict-type');
  const vEn = $('#mini-verdict-en');
  const confFill = $('#mini-conf-fill');
  const confVal = $('#mini-conf-val');
  const logEl = $('#mini-log');
  const noiseToggle = $('#mini-noise');
  const filterToggle = $('#mini-filter');
  const speedRange = $('#mini-speed');
  const speedVal = $('#mini-speed-val');

  const monitor = new EcgMonitor({
    mainCanvas,
    rawCanvas,
    fs: 500,
    windowSec: 10,
    noiseOn: false,
    filterOn: true,
    onUpdate: (s) => {
      const r = s.result;
      if (!r) return;
      if (r.hr) hrEl.textContent = String(r.hr);
      if (r.hrv != null) hrvEl.textContent = String(r.hrv);
      if (r.sqi != null) sqiEl.textContent = String(r.sqi);
      vType.textContent = r.label;
      vEn.textContent = r.short;
      if (r.conf) {
        confFill.style.width = `${r.conf}%`;
        confVal.textContent = `${r.conf}%`;
      }
      verdictEl.className = `verdict mt-3 ${severityClass(r.severity)}`;
      const color = r.severity >= 3 ? '#ff5470' : r.severity === 2 ? '#ffc23d' : '#16e0a3';
      confFill.style.background = `linear-gradient(90deg, ${color}, ${color}cc)`;
      vType.style.color = color;
    },
    onEvent: (ev) => {
      if (!logEl) return;
      const empty = logEl.querySelector('.event-log__empty');
      if (empty) empty.remove();
      logEl.insertBefore(makeEventEl(ev), logEl.firstChild);
      while (logEl.children.length > 40) logEl.removeChild(logEl.lastChild);
    },
  });

  // 리듬 버튼
  const ALL = [
    { key: 'normal', label: '정상 리듬', color: '#16e0a3' },
    { key: 'brady', label: '서맥', color: '#a78bfa' },
    { key: 'tachy', label: '동성빈맥', color: '#38bdf8' },
    { key: 'afib', label: '심방세동', color: '#ffc23d' },
    { key: 'pvc', label: '심실조기수축', color: '#5ea8ff' },
    { key: 'vt', label: '심실빈맥', color: '#ff5470' },
  ];
  if (btnWrap) {
    ALL.forEach((r) => {
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
  }

  const markButtons = (key) => {
    $$('.rhythm-btn', btnWrap || document).forEach((b) => {
      const on = b.dataset.rhythm === key;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $$('.wave-card').forEach((c) => c.classList.toggle('is-active', c.dataset.rhythm === key));
  };

  function selectRhythm(key) {
    monitor.setRhythm(key);
    markButtons(key);
  }

  if (noiseToggle) noiseToggle.addEventListener('change', () => monitor.setNoise(noiseToggle.checked));
  if (filterToggle) {
    filterToggle.addEventListener('change', () => {
      monitor.setFilter(filterToggle.checked);
      monitor.onEvent({
        level: 'info',
        title: filterToggle.checked ? '필터 체인 활성화' : '필터 체인 해제',
        detail: filterToggle.checked
          ? '60Hz 노치 → 0.5Hz 하이패스 → 40Hz 로우패스 적용'
          : '원시 신호를 그대로 표시합니다 (기저선 동요 · 전원 잡음 노출)',
      });
    });
  }
  if (speedRange) {
    speedRange.addEventListener('input', () => {
      const v = Number(speedRange.value);
      monitor.setSpeed(v);
      if (speedVal) speedVal.textContent = `${v} mm/s`;
    });
  }
  const clearBtn = $('#mini-clear-log');
  if (clearBtn && logEl) {
    clearBtn.addEventListener('click', () => {
      logEl.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'event-log__empty';
      p.textContent = '로그가 지워졌습니다.';
      logEl.appendChild(p);
    });
  }

  // 초기 상태
  markButtons('normal');
  monitor.start();

  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => monitor.resize(), 140);
  });

  // 화면 밖으로 나가면 정지 (성능)
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) monitor.start();
        else monitor.stop();
      });
    }, { threshold: 0.05 });
    const sec = $('#demo');
    if (sec) io.observe(sec);
  }

  // 파형 카드 클릭 → 리듬 전환 연동
  return { selectRhythm, monitor };
}

/* ======================================================================
 * 8. 문의 폼 (RESTful Table API)
 * ==================================================================== */
const TABLE = 'inquiries';

function initInquiry() {
  const form = $('#inquiry-form');
  const listEl = $('#inquiry-list');
  const countEl = $('#inquiry-count');
  const statusEl = $('#inquiry-status');
  const refreshBtn = $('#inquiry-refresh');
  const submitBtn = $('#inquiry-submit');

  const setStatus = (msg, ok) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = `form-status ${ok ? 'form-status--ok' : 'form-status--err'}`;
  };

  async function load() {
    if (!listEl) return;
    try {
      const res = await fetch(`tables/${TABLE}?page=1&limit=50&sort=-created_at`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      render(json.data || []);
    } catch (err) {
      listEl.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'event-log__empty';
      p.textContent = '문의 목록을 불러오지 못했습니다. (데모 환경에서만 조회 가능)';
      listEl.appendChild(p);
      if (countEl) countEl.textContent = '0건';
    }
  }

  function render(rows) {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (countEl) countEl.textContent = `${rows.length}건`;
    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'event-log__empty';
      p.textContent = '아직 등록된 문의가 없습니다. 첫 문의를 남겨보세요.';
      listEl.appendChild(p);
      return;
    }
    rows.forEach((r) => {
      const item = document.createElement('article');
      item.className = 'inquiry';

      const top = document.createElement('div');
      top.className = 'inquiry__top';
      const name = document.createElement('span');
      name.className = 'inquiry__name';
      name.textContent = r.name || '(이름 없음)';
      top.appendChild(name);

      if (r.organization) {
        const org = document.createElement('span');
        org.className = 'inquiry__org';
        org.textContent = r.organization;
        top.appendChild(org);
      }
      if (r.interest) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = r.interest;
        top.appendChild(tag);
      }
      const time = document.createElement('span');
      time.className = 'inquiry__time';
      const ts = r.created_at ? new Date(Number(r.created_at)) : new Date();
      time.textContent = isNaN(ts.getTime()) ? '' : ts.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
      top.appendChild(time);
      item.appendChild(top);

      if (r.message) {
        const msg = document.createElement('p');
        msg.className = 'inquiry__msg';
        msg.textContent = r.message;
        item.appendChild(msg);
      }
      listEl.appendChild(item);
    });
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = {
        name: $('#f-name').value.trim(),
        organization: $('#f-org').value.trim(),
        email: $('#f-email').value.trim(),
        interest: $('#f-interest').value,
        message: $('#f-message').value.trim(),
        created_at: Date.now(),
      };
      if (!data.name) { setStatus('이름을 입력해 주세요.', false); return; }
      if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
        setStatus('올바른 이메일 주소를 입력해 주세요.', false);
        return;
      }
      if (submitBtn) submitBtn.disabled = true;
      setStatus('등록 중…', true);
      try {
        const res = await fetch(`tables/${TABLE}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        form.reset();
        setStatus('문의가 등록되었습니다. 감사합니다!', true);
        load();
      } catch (err) {
        setStatus('등록에 실패했습니다. 잠시 후 다시 시도해 주세요.', false);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  if (refreshBtn) refreshBtn.addEventListener('click', load);
  load();
}

/* ======================================================================
 * 부트스트랩
 * ==================================================================== */
function boot() {
  initNav();
  initHeroWave();
  initSourceList();

  // 동적 콘텐츠를 먼저 만든 뒤에 등장 효과를 등록해야
  // 새로 생성된 .reveal 요소가 투명 상태로 남지 않는다.
  let mini = null;
  initWaveLibrary((key) => {
    if (mini && mini.selectRhythm) mini.selectRhythm(key);
  });
  mini = initMiniMonitor();

  initCharts();
  initInquiry();
  initReveal();

  void RHYTHMS;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
