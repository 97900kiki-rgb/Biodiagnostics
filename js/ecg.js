/* =========================================================================
 * ecg.js — ECG 파형 합성 · 디지털 필터 · 부정맥 분류 엔진 (클라이언트 전용)
 * MIT-BIH 부정맥 데이터의 파형 형태학(morphology)을 참고해 합성한
 * "시뮬레이션" 신호입니다. 의료적 진단 용도가 아닙니다.
 * ========================================================================= */

/* ---------------------- 1. 잡음 발생기 (컬러드 노이즈) ---------------------- */
export function makeNoise(kind) {
  if (kind === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0;
    return () => {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.96300 * b1 + w * 0.296516;
      b2 = 0.57000 * b2 + w * 1.052691;
      return (b0 + b1 + b2 + w * 0.1848) * 0.35;
    };
  }
  // 백색 잡음 (3회 평균 → 완만한 진폭 분포)
  return () => ((Math.random() + Math.random() + Math.random()) / 1.5 - 1);
}

/* ---------------------- 2. 디지털 필터 (RBJ biquad) ---------------------- */
/**
 * RBJ Audio EQ Cookbook 계수 기반 biquad 필터.
 * kind: 'bandpass'(0.5–40Hz) | 'highpass'(0.5Hz) | 'lowpass'(40Hz) | 'notch'(60Hz)
 */
export function makeFilter(kind, fs, f0, Q = 0.707) {
  const w0 = 2 * Math.PI * (f0 || 0) / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Q);
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  let b0, b1, b2;
  switch (kind) {
    case 'lowpass':  b0 = (1 - cw) / 2; b1 = 1 - cw;        b2 = b0;        break;
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw);     b2 = b0;        break;
    case 'bandpass': b0 = alpha;        b1 = 0;             b2 = -alpha;    break;
    case 'notch':    b0 = 1;            b1 = -2 * cw;       b2 = 1;         break;
    default:         b0 = 1;            b1 = 0;             b2 = 0;         break;
  }
  // Direct Form II Transposed
  const B0 = b0 / a0, B1 = b1 / a0, B2 = b2 / a0, A1 = a1 / a0, A2 = a2 / a0;
  let s1 = 0, s2 = 0;
  return {
    step(x) {
      const y = B0 * x + s1;
      s1 = B1 * x - A1 * y + s2;
      s2 = B2 * x - A2 * y;
      return y;
    },
    reset() { s1 = 0; s2 = 0; return this; },
    get state() { return [s1, s2]; },
  };
}

/* ---------------------- 3. 파형 형태학 (P-QRS-T) ---------------------- */
/** 가우시안 버스트 */
function g(t, mu, sigma, amp) {
  const d = (t - mu) / sigma;
  return amp * Math.exp(-0.5 * d * d);
}

/** 뾰족한 스파이크: 두 가우시안의 차 */
function spike(t, mu, sigma, amp) {
  return g(t, mu, sigma, amp) - g(t, mu, sigma * 3.4, amp * 0.36);
}

/**
 * 단일 심박 형태. t = 박동 시작 기준 경과 시간(초), period = 해당 RR 간격,
 * type = 'normal' | 'afib' | 'pvc' | 'vt' | 'brady' | 'tachy'
 * 반환: 정상 R파를 1.0으로 한 정규화 진폭(mV 스케일 아님).
 */
export function beatShape(t, period, type) {
  if (t < 0 || t > period * 1.2) return 0;
  const c = period * 0.30;      // QRS 중심 시각
  const pMu = c - 0.165;        // P파
  const tMu = c + 0.235;        // T파
  let v = 0;

  switch (type) {
    /* 정상 동방결절 리듬: P 정상 · QRS 좁음 · T 정상 */
    case 'normal':
    case 'brady':
    case 'tachy':
      v += g(t, pMu, 0.024, 0.14);
      v += spike(t, c - 0.021, 0.011, -0.16);
      v += spike(t, c, 0.0088, 1.00);
      v += spike(t, c + 0.026, 0.012, -0.24);
      v += g(t, tMu, 0.062, 0.28);
      break;

    /* 심방세동: P파 소실 + 세동 잔물결(f-wave), QRS는 좁음 */
    case 'afib':
      v += 0.030 * Math.sin(2 * Math.PI * 6.1 * t) + 0.024 * Math.sin(2 * Math.PI * 9.4 * t) + 0.08;
      v += spike(t, c - 0.019, 0.011, -0.13);
      v += spike(t, c, 0.0092, 0.92);
      v += spike(t, c + 0.024, 0.012, -0.20);
      v += g(t, tMu, 0.060, 0.20);
      break;

    /* 심실조기수축: P파 없음 · 넓고 기형적인 QRS · T파 반전 */
    case 'pvc':
      v -= g(t, c - 0.02, 0.030, 0.10);
      v += spike(t, c - 0.055, 0.030, 0.22);
      v += spike(t, c, 0.026, 1.18);
      v += spike(t, c + 0.075, 0.036, -0.72);
      v += g(t, c + 0.20, 0.075, -0.40);
      break;

    /* 심실빈맥: P파 없음 · 넓은 QRS 연속 */
    case 'vt':
      v += spike(t, c - 0.034, 0.023, 0.68);
      v += spike(t, c + 0.008, 0.021, -0.58);
      v += g(t, c + 0.09, 0.038, 0.34);
      break;
    default:
      break;
  }
  return v;
}

/** QRS 폭 지표 (분류기 입력용, 0~3). 넓은 QRS일수록 큼 */
export function qrsWidthIndex(type) {
  return { normal: 1, brady: 1, tachy: 1, afib: 1.05, pvc: 2.3, vt: 2.0 }[type] || 1;
}

/* ---------------------- 4. 부정맥 리듬 프로파일 ---------------------- */
export const RHYTHMS = {
  normal: { label: '정상 리듬',  short: 'Normal Sinus',          bpm: [62, 78],  hrVar: 25, pvcRate: 0,    wide: false },
  brady:  { label: '서맥',       short: 'Bradycardia',           bpm: [37, 47],  hrVar: 18, pvcRate: 0,    wide: false },
  afib:   { label: '심방세동',   short: 'Atrial Fibrillation',   bpm: [100, 155], hrVar: 320, pvcRate: 0,   wide: false },
  pvc:    { label: '심실조기수축', short: 'Premature Ventricular Contraction', bpm: [58, 70], hrVar: 40, pvcRate: 0.16, wide: false },
  vt:     { label: '심실빈맥',   short: 'Ventricular Tachycardia', bpm: [175, 215], hrVar: 55, pvcRate: 0,  wide: true },
  tachy:  { label: '동성빈',   short: 'Sinus Tachycardia',     bpm: [108, 138], hrVar: 40, pvcRate: 0,   wide: false },
};

/** 다음 RR 간격(초) 생성 — 심박 변이(hrVar, ms 단위 지터) 반영 */
export function nextRR(profile, prevRR) {
  const [lo, hi] = profile.bpm;
  const base = 60 / ((lo + hi) / 2);
  const jitter = (Math.random() * 2 - 1) * profile.hrVar / 1000;
  let rr = base * (1 + jitter);
  // AR(1) 스무딩 — 변이가 큰 리듬(심방세동 등)은 스무딩을 약하게 적용해
  // 실제 RR 불규칙성이 유지되도록 한다.
  if (prevRR) {
    const w = Math.min(0.6, profile.hrVar / 1000);
    rr = prevRR * (0.40 - w * 0.25) + rr * (0.60 + w * 0.25);
  }
  const minRR = 60 / (hi + 25), maxRR = 60 / Math.max(25, lo - 15);
  return Math.min(maxRR, Math.max(minRR, rr));
}

/* ---------------------- 5. 실시간 리듬 발생기 ---------------------- */
/**
 * 실시간 스트리밍 리듬 엔진.
 * 내부적으로 심박 스케줄 목록을 유지하며 sample() 호출마다 값을 계산한다.
 */
export class RhythmEngine {
  constructor(fs = 500) {
    this.fs = fs;
    this.t = 0;
    this.beats = [];        // {start, period, type, gain}
    this.currentBeat = null;
    this.setRhythm('normal', true);
  }

  setRhythm(kind, hard = true) {
    this.type = RHYTHMS[kind] ? kind : 'normal';
    this.profile = RHYTHMS[this.type];
    if (hard) {
      this.t = 0;
      this.beats = [];
      this.currentBeat = null;
      const rr = 60 / ((this.profile.bpm[0] + this.profile.bpm[1]) / 2);
      // 첫 QRS 가 t=0 부근에 오도록 시작점을 음수로 예약
      this._queue({ period: rr, type: this.type, gain: 1, start: -rr * 0.30 });
    }
    return this;
  }

  _queue(b) {
    this.beats.push(b);
    return b;
  }

  /** 다음 심박 예약 (마지막 심박 뒤에 이어 붙임) */
  _scheduleNext() {
    const last = this.beats[this.beats.length - 1];
    const p = this.profile;
    // PVC 삽입: 조기 박동 + 보상성 휴지기
    if (p.pvcRate > 0 && Math.random() < p.pvcRate) {
      const rr = nextRR(p, last.period);
      const pvc = { period: rr * 0.60, type: 'pvc', gain: 1.10, start: last.start + last.period };
      const pause = { period: rr * 1.45, type: 'normal', gain: 1, start: pvc.start + pvc.period };
      this.beats.push(pvc, pause);
      return;
    }
    const rr = nextRR(p, last.period);
    this.beats.push({ period: rr, type: this.type, gain: 1, start: last.start + last.period });
  }

  /**
   * 한 샘플 전진 → { v, qrs, beat, rr, beatType }
   *
   * 중요: 심박은 RR 간격이 리듬마다 크게 다르므로(0.28s~1.6s), 특정 배열
   * 인덱스로 "현재/이전 심박"을 가정하면 느린 리듬에서 R파가 누락된다.
   * 따라서 시간(t)과 겹치는 모든 심박을 순회해 중첩 합산한다.
   */
  sample() {
    const dt = 1 / this.fs;
    this.t += dt;

    // 2초 앞까지 미리 예약
    while (this.beats[this.beats.length - 1].start + this.beats[this.beats.length - 1].period < this.t + 2) {
      this._scheduleNext();
    }
    // 파형이 끝난 심박은 제거 (beats[0] 는 항상 현재 또는 미래 심박)
    while (this.beats.length > 2 && this.beats[0].start + this.beats[0].period * 1.2 < this.t) {
      this.beats.shift();
    }

    let v = 0, qrs = false, beat = false;
    for (let k = 0; k < this.beats.length; k++) {
      const b = this.beats[k];
      const rel = this.t - b.start;
      if (rel < -dt) break;                    // 아직 시작하지 않은 심박
      if (rel > b.period * 1.2) continue;      // 이미 끝난 심박
      v += beatShape(rel, b.period, b.type) * b.gain;
      if (rel >= 0 && rel < dt) beat = true;
      if (Math.abs(rel - b.period * 0.30) < dt / 2) {
        qrs = true;
        this.currentBeat = b;
      }
    }

    const cur = this.currentBeat || this.beats[0];
    return { v, qrs, beat, rr: cur ? cur.period : 0.85, beatType: cur ? cur.type : this.type };
  }

  get currentBpm() {
    const last = this.beats[this.beats.length - 1];
    return Math.round(60 / (last ? last.period : 1));
  }
}

/* ---------------------- 6. 분류기 (특징 기반 규칙) ---------------------- */
/**
 * 최근 RR 간격 + QRS 폭 특징으로 부정맥을 분류하는 데모용 규칙 기반 분류기.
 * (임상용 알고리즘 아님 — 시연/UX 목적)
 */
export class ArrhythmiaClassifier {
  constructor() { this.reset(); }

  reset() {
    this.rr = [];
    this.wide = 1;
    this.votes = {};
  }

  /** 새 심박 1회 등록. rrSec: RR 간격(초), widthIdx: QRS 폭 지수 */
  add(rrSec, widthIdx = 1) {
    this.rr.push(rrSec);
    if (this.rr.length > 26) this.rr.shift();
    this.wide += (widthIdx - this.wide) * 0.3;
    return this.classify();
  }

  get n() { return this.rr.length; }

  classify() {
    if (this.n < 5) {
      return {
        type: 'analyzing', label: '분석 중…', short: 'Analyzing',
        conf: 0, hr: null, hrv: null, sdnn: null, pnn50: null,
        cv: null, sqi: 100, severity: 0, beats: this.n,
      };
    }
    const n = this.n;
    const mean = this.rr.reduce((a, b) => a + b, 0) / n;
    const bpm = 60 / mean;

    // RMSSD (연속 RR 차이 제곱평균제곱근, ms)
    let sq = 0, cnt = 0, over = 0;
    for (let i = 1; i < n; i++) {
      const d = this.rr[i] - this.rr[i - 1];
      sq += d * d; cnt++;
      if (Math.abs(d) > 0.05) over++;
    }
    const rmssd = Math.sqrt(sq / Math.max(1, cnt)) * 1000;
    const pnn50 = (over / Math.max(1, cnt)) * 100;
    const sd = Math.sqrt(this.rr.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const cv = sd / mean;

    // 심실빈맥: 매우 빠름 + 넓은 QRS
    const vt = bpm > 150 && this.wide > 1.6;
    // 심방세동: RR 불규칙성이 지배적 특징 → 변이 지표 중심으로 판정
    // (빠른 심박이 동반되면 tachy 보다 AFib 를 우선한다)
    const afib = !vt && cv > 0.075 && rmssd > 70 && pnn50 > 45 && bpm > 82;
    // 심실조기수축: 평균 대비 크게 짧은 RR이 반복 관찰
    let pvcCount = 0;
    for (let i = 0; i < n; i++) if (this.rr[i] < mean * 0.80) pvcCount++;
    const pvc = !vt && !afib && pvcCount >= 1 && n >= 9;
    const brady = !vt && !afib && bpm < 52;
    const tachy = !vt && !afib && bpm > 100;

    const type = vt ? 'vt' : afib ? 'afib' : pvc ? 'pvc' : brady ? 'brady' : tachy ? 'tachy' : 'normal';

    const confMap = {
      vt: 66 + (bpm - 150) * 0.5 + this.wide * 6,
      afib: 60 + cv * 170 + rmssd * 0.09,
      pvc: 56 + pvcCount * 11 + (60 - Math.abs(bpm - 64)) * 0.15,
      brady: 72 + (52 - bpm) * 0.8,
      tachy: 70 + (bpm - 100) * 0.5 - cv * 120,
      normal: 82 + (1 - cv * 5) * 11 - (rmssd > 120 ? 10 : 0),
    };
    const conf = Math.max(38, Math.min(98, Math.round(confMap[type])));

    const severity = { normal: 0, brady: 1, tachy: 1, afib: 2, pvc: 2, vt: 3 }[type];

    return {
      type,
      label: RHYTHMS[type].label,
      short: RHYTHMS[type].short,
      conf, severity, beats: n,
      hr: Math.round(bpm),
      hrv: Math.round(rmssd),
      sdnn: Math.round(sd * 1000),
      pnn50: Math.round(pnn50),
      cv,
      pvcCount,
      sqi: Math.max(0, Math.round(100 - rmssd / 6)),
    };
  }
}

/* ---------------------- 7. 정적 파형 버퍼 (미리보기 차트용) ---------------------- */
/**
 * sec초 길이의 파형 배열 생성. 미리보기 카드 / 보고서용.
 */
export function synthWave(sec, fs, type, rrScale = 1) {
  const profile = RHYTHMS[type] || RHYTHMS.normal;
  const samples = [];
  const beats = [];
  let rr = 60 / ((profile.bpm[0] + profile.bpm[1]) / 2) * rrScale;
  let start = -rr * 0.30;
  let prev = null;
  for (let k = 0; k < 40; k++) {
    let bType = type;
    if (profile.pvcRate > 0 && k > 2 && Math.random() < profile.pvcRate) bType = 'pvc';
    beats.push({ start, period: rr, type: bType });
    prev = rr;
    start += rr;
    rr = nextRR(profile, prev);
    if (start > sec + 1) break;
  }
  for (let i = 0; i < Math.round(sec * fs); i++) {
    const t = i / fs;
    let v = 0;
    for (let k = 0; k < beats.length; k++) {
      const b = beats[k];
      const dt = t - b.start;
      if (dt >= -0.001 && dt <= b.period * 1.2) v += beatShape(dt, b.period, b.type);
    }
    samples.push(v);
  }
  return { samples, beats, fs };
}

/** 주어진 파형을 [-1,1] 범위로 정규화 */
export function normalize(samples) {
  let mx = 0;
  for (const s of samples) mx = Math.max(mx, Math.abs(s));
  if (!mx) return samples;
  return samples.map((s) => s / mx);
}

/* ---------------------- 8. 분류 대상 부정맥 카탈로그 ---------------------- */
export const ARRHYTHMIA_CATALOG = [
  { key: 'normal', name: '정상 리듬', en: 'Normal Sinus', color: '#16e0a3', desc: '규칙적인 동방결절 리듬, P-QRS-T 형태 정상' },
  { key: 'afib', name: '심방세동', en: 'AFib', color: '#ffc23d', desc: 'P파 소실·RR 불규칙 → 뇌졸중 위험 5배' },
  { key: 'pvc', name: '심실조기수축', en: 'PVC', color: '#5ea8ff', desc: '조기 발생한 넓은 QRS + 보상성 휴지기' },
  { key: 'vt', name: '심실빈', en: 'VT', color: '#ff5470', desc: '분당 150회 이상 넓은 QRS 연속 — 응급 상황' },
  { key: 'brady', name: '서맥', en: 'Bradycardia', color: '#a78bfa', desc: '분당 50회 미만, 실신·어지럼 위험' },
  { key: 'tachy', name: '동성빈맥', en: 'Sinus Tachycardia', color: '#38bdf8', desc: '분당 100회 이상 규칙적 상승 리듬' },
];

export const SIGNAL_SOURCES = [
  { name: 'MIT-BIH Arrhythmia DB', detail: '47명 · 48시간 · 11만+ 심박 주석', role: '학습·검증 기준 데이터셋' },
  { name: 'PhysioNet 공개 데이터셋', detail: 'AFDB · Malignant VT · SCDH 등', role: '리듬별 데이터 증강' },
  { name: '자체 수집 패치 데이터', detail: '건조 전극 · 일상 활동 구간', role: '도메인 적응 미세조정' },
];