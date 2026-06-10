// 静衡 · Quiet Equilibrium — 衡记 9:16 宣传海报 (1080x1920)
// 生成确定性 SVG 并经 resvg 栅格化为 PNG。
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 1080;
const H = 1920;

// —— палette：archival paper + ledger green + three quiet threads
const PAPER = '#f6f4ee';
const INK = '#15281f';
const EMERALD = '#0e9f6e';
const EMERALD_DEEP = '#0a7a55';
const BLUE = '#2e6bc4';
const AMBER = '#bf7a14';
const INDIGO = '#5750c9';

const CJK_LIGHT = 'DengXian Light, DengXian, Microsoft YaHei';
const CJK = 'DengXian, Microsoft YaHei';
const KAI = 'KaiTi, STKaiti, SimSun';

// deterministic PRNG (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260610);

const S = [];
const put = (s) => S.push(s);

// ───────────────────────── base
put(`<rect width="${W}" height="${H}" fill="${PAPER}"/>`);
// archival hairline frame
put(`<rect x="54" y="54" width="${W - 108}" height="${H - 108}" fill="none" stroke="${INK}" stroke-opacity="0.16" stroke-width="1.5"/>`);
put(`<rect x="60" y="60" width="${W - 120}" height="${H - 120}" fill="none" stroke="${INK}" stroke-opacity="0.05" stroke-width="0.8"/>`);

// ───────────────────────── header
put(`<text x="100" y="150" font-family="${CJK_LIGHT}" font-size="22" letter-spacing="7" fill="${INK}" fill-opacity="0.72">衡記 · HÉNG</text>`);
put(`<text x="${W - 100}" y="150" text-anchor="end" font-family="${CJK_LIGHT}" font-size="19" letter-spacing="3" fill="${INK}" fill-opacity="0.42">FIG. 01 — 借貸平衡場</text>`);
put(`<line x1="100" y1="176" x2="${W - 100}" y2="176" stroke="${INK}" stroke-opacity="0.18" stroke-width="1"/>`);

// ───────────────────────── the beam (scale) + great glyph 衡
const BEAM_Y = 512;
put(`<line x1="128" y1="${BEAM_Y}" x2="${W - 128}" y2="${BEAM_Y}" stroke="${INK}" stroke-opacity="0.55" stroke-width="2"/>`);
// end ticks
put(`<line x1="128" y1="${BEAM_Y - 9}" x2="128" y2="${BEAM_Y + 9}" stroke="${INK}" stroke-opacity="0.55" stroke-width="2"/>`);
put(`<line x1="${W - 128}" y1="${BEAM_Y - 9}" x2="${W - 128}" y2="${BEAM_Y + 9}" stroke="${INK}" stroke-opacity="0.55" stroke-width="2"/>`);
// debit (hollow) / credit (filled) pans
put(`<circle cx="172" cy="${BEAM_Y}" r="8" fill="none" stroke="${EMERALD_DEEP}" stroke-width="2.4"/>`);
put(`<circle cx="${W - 172}" cy="${BEAM_Y}" r="8" fill="${EMERALD_DEEP}"/>`);
// glyph 衡 — paper halo first so the beam passes "behind"
const GLYPH = `font-family="${KAI}" font-size="380" text-anchor="middle"`;
put(`<text x="${W / 2}" y="652" ${GLYPH} fill="none" stroke="${PAPER}" stroke-width="30">衡</text>`);
put(`<text x="${W / 2}" y="652" ${GLYPH} fill="${INK}">衡</text>`);

// ───────────────────────── ledger field
const F_TOP = 802;
const F_LEFT = 100;
const F_RIGHT = W - 100;
const COLS = 16;
const ROWS = 21;
const PITCH = 33;
const CELL = (F_RIGHT - F_LEFT) / COLS;
const TICK_W = 9;
const TICK_H = 20;
const PAIR_GAP = 7;

// three converging threads (multi-book → one sum)
const F_BOT = F_TOP + (ROWS - 1) * PITCH;
const CONV_X = W / 2;
const threads = [
  { color: BLUE, x0: 218 },
  { color: AMBER, x0: 530 },
  { color: INDIGO, x0: 862 },
];
const threadX = (th, t) => th.x0 + (CONV_X - th.x0) * t * t; // ease-in toward the sum
// ghost guide curves
for (const th of threads) {
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    pts.push(`${threadX(th, t).toFixed(1)},${(F_TOP - 14 + (F_BOT + 26 - F_TOP) * t).toFixed(1)}`);
  }
  put(`<polyline points="${pts.join(' ')}" fill="none" stroke="${th.color}" stroke-opacity="0.22" stroke-width="1.2"/>`);
}

// faint ledger row rules + index numerals
for (let r = 0; r < ROWS; r++) {
  const y = F_TOP + r * PITCH;
  put(`<line x1="${F_LEFT}" y1="${y + TICK_H / 2 + 4}" x2="${F_RIGHT}" y2="${y + TICK_H / 2 + 4}" stroke="${INK}" stroke-opacity="0.055" stroke-width="0.8"/>`);
  if (r % 4 === 0) {
    put(`<text x="84" y="${y + TICK_H / 2 + 1}" text-anchor="end" font-family="${CJK_LIGHT}" font-size="12" fill="${INK}" fill-opacity="0.28">${String(r + 1).padStart(2, '0')}</text>`);
  }
}

// paired marks: left = filled (借), right = hollow (贷)
for (let r = 0; r < ROWS; r++) {
  const y = F_TOP + r * PITCH;
  const t = r / (ROWS - 1);
  const fill = t < 0.78 ? 0.94 : 0.94 - ((t - 0.78) / 0.22) * 0.62; // dissolve at bottom
  for (let c = 0; c < COLS; c++) {
    if (rand() > fill) continue;
    const cx = F_LEFT + c * CELL + CELL / 2;
    let color = EMERALD_DEEP;
    let strong = false;
    for (const th of threads) {
      if (Math.abs(cx - threadX(th, t)) < CELL * 0.68) { color = th.color; strong = true; break; }
    }
    const op = strong ? 0.95 : 0.55 + rand() * 0.35;
    const lx = cx - PAIR_GAP / 2 - TICK_W;
    const rx = cx + PAIR_GAP / 2;
    const ty = y - TICK_H / 2;
    put(`<rect x="${lx.toFixed(1)}" y="${ty}" width="${TICK_W}" height="${TICK_H}" fill="${color}" fill-opacity="${op.toFixed(2)}"/>`);
    put(`<rect x="${rx.toFixed(1)}" y="${ty + 0.8}" width="${TICK_W - 1.6}" height="${TICK_H - 1.6}" fill="none" stroke="${color}" stroke-opacity="${op.toFixed(2)}" stroke-width="1.6"/>`);
  }
}

// ───────────────────────── the closing: double rule (books balanced)
const SUM_Y = F_BOT + 46;
put(`<text x="${F_RIGHT}" y="${SUM_Y - 12}" text-anchor="end" font-family="${CJK_LIGHT}" font-size="16" letter-spacing="2" fill="${EMERALD_DEEP}" fill-opacity="0.9">結轉 · Σ = 0</text>`);
put(`<line x1="${F_LEFT}" y1="${SUM_Y}" x2="${F_RIGHT}" y2="${SUM_Y}" stroke="${EMERALD}" stroke-width="2.2"/>`);
put(`<line x1="${F_LEFT}" y1="${SUM_Y + 6}" x2="${F_RIGHT}" y2="${SUM_Y + 6}" stroke="${EMERALD}" stroke-width="1.1"/>`);
put(`<text x="${W / 2}" y="${SUM_Y + 56}" text-anchor="middle" font-family="${KAI}" font-size="30" letter-spacing="14" fill="${INK}" fill-opacity="0.78">借 ＝ 貸</text>`);

// ───────────────────────── bottom block
const B = 1668;
put(`<text x="${W / 2}" y="${B}" text-anchor="middle" font-family="${CJK}" font-size="62" letter-spacing="10" fill="${INK}">衡记<tspan font-size="26" letter-spacing="4" fill-opacity="0.55" dx="14" dy="-6">Héng</tspan></text>`);
put(`<text x="${W / 2}" y="${B + 58}" text-anchor="middle" font-family="${CJK_LIGHT}" font-size="28" letter-spacing="3" fill="${INK}" fill-opacity="0.85">开支 · 生意 · 投资 — 各记各的账本，总表一眼清</text>`);

// legend (clinical)
const legend = [
  { c: BLUE, t: '个人' },
  { c: AMBER, t: '生意' },
  { c: INDIGO, t: '投资' },
  { c: EMERALD, t: '总表' },
];
const LW = 96;
let lx0 = W / 2 - (legend.length * LW - 24) / 2;
for (const l of legend) {
  put(`<rect x="${lx0}" y="${B + 96}" width="12" height="12" fill="${l.c}"/>`);
  put(`<text x="${lx0 + 20}" y="${B + 107}" font-family="${CJK_LIGHT}" font-size="17" fill="${INK}" fill-opacity="0.6">${l.t}</text>`);
  lx0 += LW;
}
put(`<text x="${W / 2}" y="${B + 156}" text-anchor="middle" font-family="${CJK_LIGHT}" font-size="16" letter-spacing="5" fill="${INK}" fill-opacity="0.42">开源 · 本地优先 · 复式记账内核</text>`);

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${S.join('\n')}</svg>`;

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: W },
  font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' },
  background: PAPER,
});
const png = resvg.render().asPng();
const out = join(dirname(fileURLToPath(import.meta.url)), 'poster-hengji-9x16.png');
writeFileSync(out, png);
console.log(`poster written: ${out} (${(png.length / 1024).toFixed(0)} KB)`);
