/* =========================================================================
 * monitor.js — 실시간 ECG 모니터 엔진
 * 합성 리듬 → 잡음 주입 → 필터 체인 → QRS 검출(Pan-Tompkins 파생)
 * → 분류기 판정 → 캔버스 스트립 렌더링 까지 담당하는 공용 모듈.
 * index.html(미니 데모)과 demo.html(전체 화면)이 함께 사용합니다.
 * ========================================================================= */

import {
  RhythmEngine, makeNoise, makeFilter, ArrhythmiaClassifier,
  qrsWidthIndex, RHYTHMS,
} from './ecg.js';

/* ---------------------- 링 버퍼 ---------------------- */
class Ring {
  constructor(n) {
    this.buf = new Float32Array(n);
    this.n = n; this.len = 0; this.head = 0;
  }
  push(v) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.n;
    if (this.len < this.n) this.len++;
  }
  /** i = 0 이 가장 오래된 샘플 */
  get(i) {
    const start = (this.head - this.len + this.n) % this.n;
    return this.buf[(start + i) % this.n];
  }
  clear() { this.len = 0; this.head = 0; }
}

/* ---------------------- Pan-Tompkins 파생 QRS 검출기 ---------------------- */
/**
 * 실제 Pan-Tompkins 흐름을 축약 구현:
 *   대역통과(모니터 필터 체인에서 이미 수행) → 미분 → 제곱 → 이동창 적분
 *   → 적응형 임계값 + 불응기(refractory) 기반 피크 검출
 */
class QrsDetector {
  constructor(fs) {
    this.fs = fs;
    this.deriv = [];
    this.intWin = Math.round(0.15 * fs);   // 150ms 이동창
    this.buf = new Float32Array(this.intWin);
    this.bi = 0;
    this.sum = 0;
    this.peak = 0.0001;
    this.lastPeakT = -1;
    this.refractory = 0.20;                 // 200ms
    this.t = 0;
    this.hist = new Float32Array(Math.round(0.6 * fs));  // 폭 측정용
    this.hi = 0;
    this.lastPeaks = [];                    // 최근 R 피크 시각(초)
    this._peakHold = 0;
    this._prevInteg = 0;
  }

  /** x: 필터링된 샘플. 반환: { r:boolean, rr:number|null, amp:number, width:number } */
  push(x) {
    this.t += 1 / this.fs;
    // 1) 5점 미분
    this.deriv.push(x);
    if (this.deriv.length > 8) this.deriv.shift();
    const d = this.deriv.length >= 5
      ? (2 * this.deriv[this.deriv.length - 1] + this.deriv[this.deriv.length - 2]
        - this.deriv[this.deriv.length - 4] - 2 * this.deriv[this.deriv.length - 5]) / 8
      : 0;

    // 2) 제곱
    const s = d * d;

    // 3) 이동창 적분
    this.sum -= this.buf[this.bi];
    this.buf[this.bi] = s;
    this.sum += s;
    this.bi = (this.bi + 1) % this.intWin;
    const integ = this.sum / this.intWin;

    // 4) 적응형 임계값 (피크 추적 + 서서히 감쇠)
    //    계수 0.20: T파 에너지(≈R의 8%)를 배제해 느린 리듬에서
    //    T파를 추가 R파로 오검출하는 문제를 막는다.
    this.peak = Math.max(integ, this.peak * (1 - 0.35 / this.fs));
    const thr = Math.max(0.20 * this.peak, 1e-6);

    // 5) 불응기 + 임계값 기반 검출
    let r = false, rr = null, amp = 0, width = 1;
    const canFire = this.lastPeakT < 0 || (this.t - this.lastPeakT) >= this.refractory;
    if (integ > thr && canFire) {
      // 적분 신호가 상승 중일 때만 (국소 최대 근사)
      if (integ >= this._prevInteg) {
        this._peakHold = integ;
      } else if (this._peakHold && integ < this._peakHold * 0.6) {
        r = true;
        rr = this.lastPeakT >= 0 ? this.t - this.lastPeakT : null;
        amp = this._peakHold;
        width = this._qrsWidthIndex();
        this.lastPeakT = this.t;
        this._peakHold = 0;
        this.lastPeaks.push(this.t);
        if (this.lastPeaks.length > 40) this.lastPeaks.shift();
      }
    }
    this._prevInteg = integ;
    this._lastInteg = integ;
    return { r, rr, amp, width };
  }

  _qrsWidthIndex() {
    // 최근 0.6초 파형에서 진폭 절반 이상 구간(폭)을 심박 길이 대비 비율로 환산
    const h = this.hist, n = h.length;
    let mx = 0;
    for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(h[i]));
    if (mx < 1e-9) return 1;
    let cnt = 0;
    for (let i = 0; i < n; i++) if (Math.abs(h[i]) > mx * 0.5) cnt++;
    const widthSec = cnt / this.fs;
    // 좁은 QRS ≈ 0.03s, 넓은 QRS ≈ 0.09s+ → 1.0 ~ 2.4
    return Math.max(0.9, Math.min(2.6, widthSec / 0.032));
  }

  feedWidthSample(x) {
    this.hist[this.hi] = x;
    this.hi = (this.hi + 1) % this.hist.length;
  }

  reset() {
    this.buf.fill(0); this.sum = 0; this.bi = 0;
    this.peak = 0.0001; this.lastPeakT = -1; this.t = 0;
    this.hist.fill(0); this.hi = 0; this.deriv = []; this.lastPeaks = [];
    this._peakHold = 0; this._prevInteg = 0;
  }
}

/* ---------------------- 캔버스 스트립 ---------------------- */
class Strip {
  constructor(canvas, ring, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ring = ring;
    this.color = opts.color || '#16e0a3';
    this.lineWidth = opts.lineWidth || 1.7;
    this.grid = !!opts.grid;
    this.glow = opts.glow !== false;
    this.windowSec = opts.windowSec || 10;
    this.fs = opts.fs || 500;
    this.markers = [];      // { i, color } 검출 마커
    this.dpr = 1;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(240, Math.round(rect.width || this.canvas.clientWidth || 600));
    const h = Math.max(60, Math.round(rect.height || this.canvas.clientHeight || 140));
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssW = w; this.cssH = h;
    this.baseline = h * 0.58;
    this.amp = h * 0.36;
  }

  setWindowSec(sec) { this.windowSec = sec; }

  /** 검출 마커 추가 (초 단위 현재 시각) */
  addMarker(timeSec, color) {
    this.markers.push({ t: timeSec, color: color || this.color });
    if (this.markers.length > 60) this.markers.shift();
  }

  draw(gridOn) {
    const { ctx, cssW: w, cssH: h } = this;
    ctx.clearRect(0, 0, w, h);

    // ECG 그리드 (5mm 소 · 25mm 대)
    if (gridOn) {
      const pxPerSec = w / this.windowSec;
      const small = Math.max(5, pxPerSec / 5);      // 0.2초 = 5mm
      ctx.save();
      ctx.strokeStyle = 'rgba(22,224,163,0.09)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x += small) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
      for (let y = 0; y < h; y += small) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(22,224,163,0.19)';
      ctx.beginPath();
      for (let x = 0; x < w; x += small * 5) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
      ctx.stroke();
      ctx.restore();
    }

    const ring = this.ring;
    if (ring.len < 4) return;

    const totalSec = ring.len / this.fs;
    const visSec = Math.min(this.windowSec, totalSec);
    const visSamples = Math.floor(visSec * this.fs);
    const startIdx = ring.len - visSamples;
    // x 픽셀당 샘플 수
    const per = Math.max(1, visSamples / w);
    const centre = ring.len;    // 우측 끝 = 최신 샘플

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    if (this.glow) {
      ctx.shadowColor = this.color;
      ctx.shadowBlur = 7;
    }
    ctx.beginPath();
    let started = false;
    for (let x = 0; x < w; x++) {
      const i0 = startIdx + Math.floor(x * per);
      const i1 = Math.min(ring.len, i0 + Math.ceil(per));
      let mn = Infinity, mx = -Infinity;
      for (let i = i0; i < i1; i++) {
        const v = ring.get(i);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (mn === Infinity) continue;
      const yA = this.baseline - mx * this.amp;
      const yB = this.baseline - mn * this.amp;
      if (!started) { ctx.moveTo(x, yA); started = true; }
      else ctx.lineTo(x, yA);
      if (yB !== yA) ctx.lineTo(x, yB);
    }
    ctx.stroke();
    ctx.restore();
    void centre;
  }
}

/* ---------------------- 모니터 컨트롤러 ---------------------- */
export class EcgMonitor {
  /**
   * @param {object} cfg
   *  cfg.mainCanvas, cfg.rawCanvas (HTMLElement)
   *  cfg.fs 샘플레이트, cfg.onUpdate(res) 콜백
   */
  constructor(cfg = {}) {
    this.fs = cfg.fs || 500;
    this.windowSec = cfg.windowSec || 10;
    this.engine = new RhythmEngine(this.fs);
    this.classifier = new ArrhythmiaClassifier();
    this.detector = new QrsDetector(this.fs);
    this.noise = makeNoise('white');
    this.pink = makeNoise('pink');
    this.notch = makeFilter('notch', this.fs, 60, 20);
    this.lp = makeFilter('lowpass', this.fs, 40, 0.707);
    this.hp = makeFilter('highpass', this.fs, 0.5, 0.707);

    this.noiseOn = cfg.noiseOn !== false ? !!cfg.noiseOn : false;
    this.filterOn = cfg.filterOn !== false;
    this.motionOn = cfg.motionOn !== false;
    this.running = false;
    this.paused = false;
    this.simT = 0;
    this.artifact = 0;
    this.artifactTimer = 3 + Math.random() * 5;

    // 버퍼 길이: 최대 창(20초) + 여유
    const cap = Math.ceil(22 * this.fs);
    this.rawRing = new Ring(cap);
    this.filtRing = new Ring(cap);

    const opts = { fs: this.fs, windowSec: this.windowSec };
    this.mainStrip = cfg.mainCanvas
      ? new Strip(cfg.mainCanvas, this.filtRing, Object.assign({ color: '#16e0a3', lineWidth: cfg.big ? 2.1 : 1.7, grid: !!cfg.grid }, opts))
      : null;
    this.rawStrip = cfg.rawCanvas
      ? new Strip(cfg.rawCanvas, this.rawRing, Object.assign({ color: 'rgba(94,168,255,0.72)', lineWidth: 1.2, glow: false, grid: false }, opts))
      : null;

    this.onUpdate = cfg.onUpdate || (() => {});
    this.onEvent = cfg.onEvent || (() => {});
    this.onBeat = cfg.onBeat || (() => {});

    this.stats = {
      hr: null, hrv: null, sqi: null, result: null, beats: 0, elapsed: 0,
      threshold: 0, widthIdx: 1, bufferLen: 0, qrsFlag: false,
    };
    this._frame = this._frame.bind(this);
    this._lastT = 0;
    this._lastClassKey = '';
    this._lastLogT = 0;
  }

  /* ---- 설정 ---- */
  setRhythm(kind) {
    this.engine.setRhythm(kind);
    this.classifier.reset();
    this.detector.reset();
    this.rawRing.clear();
    this.filtRing.clear();
    this.simT = 0;
    const p = RHYTHMS[this.engine.type];
    this.onEvent({
      level: 'info',
      title: `리듬 전환 → ${p.label}`,
      detail: `목표 심박 ${p.bpm[0]}–${p.bpm[1]} bpm · ${p.short}`,
    });
  }
  setNoise(on) { this.noiseOn = !!on; }
  setFilter(on) {
    this.filterOn = !!on;
    this.notch.reset(); this.lp.reset(); this.hp.reset();
  }
  setMotion(on) { this.motionOn = !!on; }
  /** 노치 주파수(Hz) 변경 → 필터 계수 재계산 */
  setNotchFreq(f) {
    this.notch = makeFilter('notch', this.fs, Number(f) || 60, 20);
    return this;
  }
  /** 파형 진폭 배율 (Strip.amp) */
  setGain(mult) {
    const m = Math.max(0.3, Math.min(3, Number(mult) || 1));
    this.gainMult = m;
    if (this.mainStrip) this.mainStrip.amp = this.mainStrip.cssH * 0.36 * m;
    if (this.rawStrip) this.rawStrip.amp = this.rawStrip.cssH * 0.36 * m;
  }
  pause(on) {
    this.paused = !!on;
    if (!this.paused) this._lastT = performance.now();
  }
  /** mm/s → 화면 창(초). 폭 250mm 가정 */
  setSpeed(mmPerSec) {
    this.windowSec = Math.max(3, Math.min(25, 250 / Math.max(5, mmPerSec)));
    if (this.mainStrip) this.mainStrip.setWindowSec(this.windowSec);
    if (this.rawStrip) this.rawStrip.setWindowSec(this.windowSec);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._lastT = performance.now();
    requestAnimationFrame(this._frame);
  }
  stop() { this.running = false; }

  resize() {
    if (this.mainStrip) this.mainStrip.resize();
    if (this.rawStrip) this.rawStrip.resize();
    this.setGain(this.gainMult || 1);
  }

  /* ---- 샘플 생성 ---- */
  _generate(nSamples) {
    for (let k = 0; k < nSamples; k++) {
      const dt = 1 / this.fs;
      this.simT += dt;

      // --- 심박 발생 ---
      const s = this.engine.sample();
      let clean = s.v;

      // 기저선 동요(baseline wander) — 항상 존재
      const wander = 0.10 * Math.sin(2 * Math.PI * 0.24 * this.simT)
        + 0.06 * Math.sin(2 * Math.PI * 0.37 * this.simT + 1.1);

      // --- 운동 아티팩트 (간헐 버스트) ---
      this.artifactTimer -= dt;
      if (this.artifactTimer <= 0) {
        this.artifact = this.motionOn ? 0.55 + Math.random() * 0.5 : 0;
        this.artifactTimer = 6 + Math.random() * 9;
      }
      if (this.artifact > 0) this.artifact = Math.max(0, this.artifact - dt * 1.1);
      const motion = this.artifact > 0
        ? this.artifact * 0.35 * Math.sin(2 * Math.PI * (2.4 + Math.sin(this.simT) * 1.2) * this.simT) * this.pink()
        : 0;

      // --- 잡음 주입 ---
      const emg = 0.020 * this.noise();                     // 근전도성 백색 잡음
      const power = this.noiseOn ? 0.16 * Math.sin(2 * Math.PI * 60 * this.simT) : 0;
      const raw = clean + wander + motion + emg + power;

      // --- 필터 체인 ---
      let filt;
      if (this.filterOn) {
        let y = this.notch.step(raw);
        y = this.hp.step(y);
        y = this.lp.step(y);
        filt = y;
      } else {
        filt = raw;
      }

      this.rawRing.push(raw);
      this.filtRing.push(filt);

      // --- QRS 검출 ---
      this.detector.feedWidthSample(filt);
      const det = this.detector.push(filt);
      this.stats.threshold = this.detector.peak;
      this.stats.widthIdx = det.width;
      this.stats.qrsFlag = det.r;
      this.stats.bufferLen = this.classifier.n;
      if (det.r) {
        const widthIdx = det.width * (det.amp > 0 ? 1 : 1);
        const res = this.classifier.add(det.rr || (60 / 70), widthIdx);
        this.stats.beats++;
        this.stats.result = res;
        this.stats.hr = res.hr;
        this.stats.hrv = res.hrv;
        this.stats.sqi = res.sqi;
        if (this.mainStrip) this.mainStrip.addMarker(this.simT, res.severity >= 3 ? '#ff5470' : res.severity === 2 ? '#ffc23d' : '#16e0a3');
        this.onBeat(res);
        this._maybeLog(res);
      }
    }
  }

  _maybeLog(res) {
    if (!res || res.type === 'analyzing') return;
    const key = res.type;
    // 리듬 판정이 바뀌었거나 3초 이상 경과 시 재기록
    if (key !== this._lastClassKey || this.simT - this._lastLogT > 12) {
      this._lastClassKey = key;
      this._lastLogT = this.simT;
      const level = res.severity >= 3 ? 'alert' : res.severity === 2 ? 'warn' : 'ok';
      this.onEvent({
        level,
        title: `${res.label} 판정`,
        detail: `신뢰도 ${res.conf}% · HR ${res.hr} bpm · RMSSD ${res.hrv} ms${res.pvcCount ? ` · 조기박동 ${res.pvcCount}회` : ''}`,
      });
    }
  }

  /** 리듬별 목표 QRS 폭 지수(검출기 보정용) */
  static widthOf(kind) { return qrsWidthIndex(kind); }

  /* ---- 프레임 ---- */
  _frame(now) {
    if (!this.running) return;
    const dtReal = Math.min(0.12, (now - this._lastT) / 1000);
    this._lastT = now;

    if (!this.paused) {
      this.stats.elapsed += dtReal;
      const want = Math.round(dtReal * this.fs);
      if (want > 0) this._generate(Math.min(want, Math.round(0.25 * this.fs)));
    }

    if (this.mainStrip) this.mainStrip.draw(this.mainStrip.grid);
    if (this.rawStrip) this.rawStrip.draw(false);

    this.onUpdate(this.stats);
    requestAnimationFrame(this._frame);
  }

  /** 현재 필터링 파형을 PNG data URL 로 캡처 */
  snapshot() {
    if (!this.mainStrip) return null;
    return this.mainStrip.canvas.toDataURL('image/png');
  }
}

/* ---------------------- 공용 UI 헬퍼 ---------------------- */
export function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function severityClass(sev) {
  return sev >= 3 ? 'verdict--alert' : sev === 2 ? 'verdict--warn' : 'verdict--ok';
}

export function makeEventEl(ev) {
  const el = document.createElement('div');
  el.className = `event event--${ev.level || 'ok'}`;
  const t = document.createElement('time');
  t.className = 'event__time';
  t.textContent = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  const msg = document.createElement('span');
  msg.className = 'event__msg';
  const b = document.createElement('b');
  b.textContent = ev.title;
  msg.appendChild(b);
  if (ev.detail) {
    const br = document.createElement('br');
    msg.appendChild(br);
    msg.appendChild(document.createTextNode(ev.detail));
  }
  el.appendChild(t);
  el.appendChild(msg);
  return el;
}
