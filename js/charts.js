/* =========================================================================
 * charts.js — 경량 캔버스 차트 (외부 라이브러리 의존 없음)
 * 브리핑 페이지의 AI 성능 차트 2종을 직접 렌더링합니다.
 * CDN 이 차단된 환경에서도 항상 표시되도록 순수 Canvas 2D 로 구현했습니다.
 * ========================================================================= */

const FONT = "12px Inter, 'Pretendard', system-ui, sans-serif";
const FONT_SM = "11px ui-monospace, 'JetBrains Mono', Menlo, monospace";
const COL_GRID = 'rgba(120,160,220,0.13)';
const COL_AXIS = 'rgba(120,160,220,0.32)';
const COL_TEXT = '#93a6c4';
const COL_TEXT_DIM = '#64748f';

/** HiDPI 캔버스 준비 */
function prep(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(200, Math.round(rect.width || canvas.parentElement?.clientWidth || 420));
  const h = Math.max(140, Math.round(rect.height || canvas.parentElement?.clientHeight || 260));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ======================================================================
 * 라인 차트 — 에포크별 목표 성능 궤적
 * ==================================================================== */
export function lineChart(canvas, cfg) {
  const { series, xLabels, yMin, yMax } = cfg;
  let plot = null;

  const draw = (hoverIdx = -1) => {
    const { ctx, w, h } = prep(canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;

    const padL = 46, padR = 14, padT = 14, padB = 32;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    const n = xLabels.length;
    const X = (i) => padL + (pw * i) / (n - 1);
    const Y = (v) => padT + ph - (ph * (v - yMin)) / (yMax - yMin);
    plot = { padL, padT, pw, ph, X, Y, n };

    // 가로 그리드 + y 라벨
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = FONT_SM;
    ctx.fillStyle = COL_TEXT_DIM;
    for (let v = yMin; v <= yMax; v += 10) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = COL_GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillText(`${v}%`, padL - 9, Y(v));
    }

    // x축 라벨 (5개 정도만)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = COL_TEXT_DIM;
    const step = Math.max(1, Math.floor(n / 5));
    for (let i = 0; i < n; i += step) {
      ctx.fillText(String(xLabels[i]), X(i), padT + ph + 9);
    }

    // 축선
    ctx.strokeStyle = COL_AXIS;
    ctx.beginPath();
    ctx.moveTo(padL + 0.5, padT);
    ctx.lineTo(padL + 0.5, padT + ph);
    ctx.lineTo(w - padR, padT + ph);
    ctx.stroke();

    // 호버 세로선
    if (hoverIdx >= 0 && hoverIdx < n) {
      ctx.strokeStyle = 'rgba(234,241,255,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X(hoverIdx), padT);
      ctx.lineTo(X(hoverIdx), padT + ph);
      ctx.stroke();
    }

    // 시리즈
    series.forEach((s) => {
      // 면 채우기
      if (s.fill) {
        const grad = ctx.createLinearGradient(0, padT, 0, padT + ph);
        grad.addColorStop(0, s.fill);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.moveTo(X(0), padT + ph);
        s.data.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
        ctx.lineTo(X(n - 1), padT + ph);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
      // 선
      ctx.beginPath();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(s.dash || []);
      s.data.forEach((v, i) => {
        if (i === 0) ctx.moveTo(X(i), Y(v));
        else ctx.lineTo(X(i), Y(v));
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.dash ? 1.8 : 2.3;
      ctx.stroke();
      ctx.setLineDash([]);

      // 데이터 포인트 (호버 시)
      if (hoverIdx >= 0 && hoverIdx < n) {
        ctx.beginPath();
        ctx.arc(X(hoverIdx), Y(s.data[hoverIdx]), 4, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = '#070b14';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });

    // 툴팁
    if (hoverIdx >= 0 && hoverIdx < n) {
      const lines = series.map((s) => ({ label: s.label, value: s.data[hoverIdx], color: s.color }));
      ctx.font = FONT_SM;
      const pad = 9;
      const lh = 15;
      let tw = 0;
      lines.forEach((l) => {
        tw = Math.max(tw, ctx.measureText(`${l.label}  ${l.value}%`).width);
      });
      const bw = tw + pad * 2;
      const bh = lines.length * lh + pad * 2 - 4;
      let bx = X(hoverIdx) + 12;
      if (bx + bw > w - padR) bx = X(hoverIdx) - bw - 12;
      const by = Math.min(padT + 4, padT + ph - bh);

      ctx.fillStyle = 'rgba(7,11,20,0.95)';
      ctx.strokeStyle = 'rgba(120,160,220,0.3)';
      ctx.lineWidth = 1;
      roundRect(ctx, bx, by, bw, bh, 8);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      lines.forEach((l, i) => {
        const ly = by + pad + i * lh + 2;
        ctx.fillStyle = l.color;
        ctx.fillRect(bx + pad, ly - 3.5, 8, 7);
        ctx.fillStyle = COL_TEXT;
        ctx.fillText(`${l.label}`, bx + pad + 13, ly);
        ctx.fillStyle = '#eaf1ff';
        ctx.textAlign = 'right';
        ctx.fillText(`${l.value}%`, bx + bw - pad, ly);
        ctx.textAlign = 'left';
      });

      // 호버 x 라벨 강조
      ctx.font = FONT_SM;
      ctx.fillStyle = '#eaf1ff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(xLabels[hoverIdx]), X(hoverIdx), padT + ph + 9);
    }
  };

  const onMove = (e) => {
    if (!plot) return;
    const rect = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    const mx = p.clientX - rect.left;
    const rel = (mx - plot.padL) / plot.pw;
    const idx = Math.round(rel * (plot.n - 1));
    draw(Math.max(0, Math.min(plot.n - 1, idx)));
  };
  const onLeave = () => draw(-1);

  draw(-1);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('touchmove', (e) => { onMove(e); }, { passive: true });
  canvas.addEventListener('touchend', onLeave);

  return {
    redraw: () => draw(-1),
    resize: () => draw(-1),
  };
}

/* ======================================================================
 * 그룹 막대 차트 — 클래스별 목표 성능
 * ==================================================================== */
export function barChart(canvas, cfg) {
  const { labels, groups, yMin, yMax } = cfg;
  let plot = null;

  const draw = (hover = null) => {
    const { ctx, w, h } = prep(canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;

    const padL = 44, padR = 12, padT = 14, padB = 40;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    const n = labels.length;
    const Y = (v) => padT + ph - (ph * (v - yMin)) / (yMax - yMin);

    // 그리드 + y 라벨
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = FONT_SM;
    for (let v = yMin; v <= yMax; v += 5) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = COL_GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillStyle = COL_TEXT_DIM;
      ctx.fillText(`${v}%`, padL - 8, Y(v));
    }

    // 축
    ctx.strokeStyle = COL_AXIS;
    ctx.beginPath();
    ctx.moveTo(padL + 0.5, padT);
    ctx.lineTo(padL + 0.5, padT + ph);
    ctx.lineTo(w - padR, padT + ph);
    ctx.stroke();

    const slot = pw / n;
    const barW = Math.min(26, slot * 0.30);
    const gap = 5;

    labels.forEach((label, gi) => {
      const cx = padL + slot * gi + slot / 2;
      const isHover = hover === gi;
      const totalW = groups.length * barW + (groups.length - 1) * gap;
      const x0 = cx - totalW / 2;

      groups.forEach((g, si) => {
        const v = g.data[gi];
        const y = Y(v);
        const bh = padT + ph - y;
        const bx = x0 + si * (barW + gap);

        const grad = ctx.createLinearGradient(0, y, 0, padT + ph);
        grad.addColorStop(0, g.color);
        grad.addColorStop(1, g.colorEnd || g.color.replace(/[\d.]+\)$/, '0.35)'));
        ctx.fillStyle = grad;
        roundRect(ctx, bx, y, barW, Math.max(2, bh), 4);
        ctx.fill();

        if (isHover) {
          ctx.strokeStyle = 'rgba(234,241,255,0.45)';
          ctx.lineWidth = 1.2;
          roundRect(ctx, bx - 1, y - 1, barW + 2, Math.max(2, bh) + 2, 5);
          ctx.stroke();
        }
      });

      // x 라벨
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = isHover ? '#eaf1ff' : COL_TEXT;
      const words = label.split(' ');
      if (words.length > 1 && slot < 64) {
        words.forEach((wd, wi) => ctx.fillText(wd, cx, padT + ph + 10 + wi * 14));
      } else {
        ctx.fillText(label, cx, padT + ph + 10);
      }
    });

    // 툴팁
    if (hover != null) {
      const cx = padL + slot * hover + slot / 2;
      const items = groups.map((g) => ({ label: g.label, value: g.data[hover], color: g.color }));
      ctx.font = FONT_SM;
      const pad = 9, lh = 15;
      let tw = 0;
      items.forEach((l) => { tw = Math.max(tw, ctx.measureText(`${l.label}  ${l.value}%`).width); });
      const bw = tw + pad * 2;
      const bh = items.length * lh + pad * 2 - 4;
      let bx = cx + 14;
      if (bx + bw > w - padR) bx = cx - bw - 14;
      const by = padT + 4;

      ctx.fillStyle = 'rgba(7,11,20,0.95)';
      ctx.strokeStyle = 'rgba(120,160,220,0.3)';
      ctx.lineWidth = 1;
      roundRect(ctx, bx, by, bw, bh, 8);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      items.forEach((l, i) => {
        const ly = by + pad + i * lh + 2;
        ctx.fillStyle = l.color;
        ctx.fillRect(bx + pad, ly - 3.5, 8, 7);
        ctx.fillStyle = COL_TEXT;
        ctx.fillText(l.label, bx + pad + 13, ly);
        ctx.fillStyle = '#eaf1ff';
        ctx.textAlign = 'right';
        ctx.fillText(`${l.value}%`, bx + bw - pad, ly);
        ctx.textAlign = 'left';
      });
    }
  };

  const hitTest = (e) => {
    if (!plot) return null;
    const rect = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    const mx = p.clientX - rect.left;
    const i = Math.floor((mx - plot.padL) / plot.slot);
    if (i < 0 || i >= plot.n) return null;
    return i;
  };

  // plot 정보 캐시
  const computePlot = () => {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(200, Math.round(rect.width || 420));
    const padL = 44, padR = 12;
    plot = { padL, padR, n: labels.length, slot: (w - padL - padR) / labels.length };
  };

  const onMove = (e) => {
    computePlot();
    const i = hitTest(e);
    if (i != null) draw(i);
  };
  const onLeave = () => draw(null);

  computePlot();
  draw(null);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('touchmove', (e) => { onMove(e); }, { passive: true });
  canvas.addEventListener('touchend', onLeave);

  return {
    redraw: () => { computePlot(); draw(null); },
    resize: () => { computePlot(); draw(null); },
  };
}

/* ======================================================================
 * 데이터셋 정의 — 목표 궤적 (target scenario)
 * ==================================================================== */
export function buildTrainingData() {
  const epochs = Array.from({ length: 21 }, (_, i) => i * 5);
  const curve = (cap, rate, start) =>
    epochs.map((e) => +(start + (cap - start) * (1 - Math.exp(-e / rate))).toFixed(1));
  return {
    xLabels: epochs,
    yMin: 50,
    yMax: 100,
    series: [
      { label: '민감도', data: curve(95.5, 26, 62), color: '#16e0a3', fill: 'rgba(22,224,163,0.22)' },
      { label: '정밀도', data: curve(92.0, 30, 58), color: '#38bdf8', fill: 'rgba(56,189,248,0.16)' },
      { label: 'F1 점수', data: curve(93.5, 28, 60), color: '#a78bfa', dash: [6, 4] },
    ],
  };
}

export function buildClassData() {
  return {
    labels: ['정상', '심방세동', '조기수축', '심실빈맥', '서맥'],
    yMin: 70,
    yMax: 100,
    groups: [
      {
        label: '목표 민감도',
        data: [98, 96, 93, 97, 94],
        color: 'rgba(22,224,163,0.9)',
        colorEnd: 'rgba(22,224,163,0.35)',
      },
      {
        label: '목표 정밀도',
        data: [97, 91, 88, 95, 92],
        color: 'rgba(56,189,248,0.82)',
        colorEnd: 'rgba(56,189,248,0.3)',
      },
    ],
  };
}