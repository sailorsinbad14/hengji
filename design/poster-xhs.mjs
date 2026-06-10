// 静衡 · Quiet Equilibrium — 小红书封面 (3:4, 1242x1656)
// 同一设计基因（纸面/翡翠/成对刻度/三线归一/双划线），调成信息流可读的种草封面。
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 1242;
const H = 1656;

const PAPER = '#f6f4ee';
const INK = '#15281f';
const EMERALD = '#0e9f6e';
const EMERALD_DEEP = '#0a7a55';
const BLUE = '#2e6bc4';
const AMBER = '#bf7a14';
const INDIGO = '#5750c9';

const CJK_LIGHT = 'DengXian Light, DengXian, Microsoft YaHei';
const CJK = 'DengXian, Microsoft YaHei';
const BOLD = 'Microsoft YaHei';
const KAI = 'KaiTi, STKaiti, SimSun';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(2026);

const S = [];
const put = (s) => S.push(s);

// base + frame
put(`<rect width="${W}" height="${H}" fill="${PAPER}"/>`);
put(`<rect x="44" y="44" width="${W - 88}" height="${H - 88}" fill="none" stroke="${INK}" stroke-opacity="0.16" stroke-width="1.5"/>`);
put(`<rect x="50" y="50" width="${W - 100}" height="${H - 100}" fill="none" stroke="${INK}" stroke-opacity="0.05" stroke-width="0.8"/>`);

// header
put(`<text x="92" y="136" font-family="${CJK_LIGHT}" font-size="24" letter-spacing="6" fill="${INK}" fill-opacity="0.72">衡記 · HÉNG</text>`);
put(`<rect x="${W - 92 - 196}" y="100" width="196" height="48" rx="24" fill="${EMERALD}"/>`);
put(`<text x="${W - 92 - 98}" y="133" text-anchor="middle" font-family="${BOLD}" font-weight="700" font-size="23" letter-spacing="3" fill="#fff">开源 · 免费</text>`);
put(`<line x1="92" y1="172" x2="${W - 92}" y2="172" stroke="${INK}" stroke-opacity="0.16" stroke-width="1"/>`);

// kicker + H1 + sub
put(`<text x="92" y="262" font-family="${CJK}" font-size="26" letter-spacing="6" fill="${EMERALD_DEEP}">给自己做的开源记账 APP</text>`);
put(`<text x="92" y="412" font-family="${BOLD}" font-weight="700" font-size="124" letter-spacing="6" fill="${INK}">账，终于<tspan fill="${EMERALD}">分清</tspan>了</text>`);
put(`<text x="92" y="492" font-family="${CJK}" font-size="33" letter-spacing="2" fill="${INK}" fill-opacity="0.85">开支 · 生意 · 投资，各开各的账本</text>`);
put(`<text x="92" y="546" font-family="${CJK}" font-size="33" letter-spacing="2" fill="${INK}" fill-opacity="0.85">财务总表自动汇总，<tspan fill="${EMERALD_DEEP}">一眼清</tspan></text>`);

// ───────── diagram: three books → one sum
const CARD_Y = 640;
const CARD_W = 320;
const CARD_H = 224;
const GAP = (W - 184 - CARD_W * 3) / 2;
const books = [
  { x: 92, c: BLUE, emoji: '👤', name: '个人账本', sub: '日常开支 · 预算' },
  { x: 92 + CARD_W + GAP, c: AMBER, emoji: '💼', name: '生意账本', sub: '订单 · 库存 · 应付' },
  { x: 92 + (CARD_W + GAP) * 2, c: INDIGO, emoji: '📈', name: '投资账本', sub: '现值 · 盈亏' },
];
for (const b of books) {
  put(`<rect x="${b.x}" y="${CARD_Y}" width="${CARD_W}" height="${CARD_H}" rx="20" fill="#fff" stroke="${b.c}" stroke-opacity="0.4" stroke-width="1.8"/>`);
  put(`<text x="${b.x + 24}" y="${CARD_Y + 52}" font-family="${BOLD}" font-weight="700" font-size="29" fill="${b.c}">${b.emoji} ${b.name}</text>`);
  // paired tick rows inside card（借/贷成对：左实右空）
  for (let r = 0; r < 3; r++) {
    const y = CARD_Y + 86 + r * 34;
    const n = 4 - (r === 2 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const cx = b.x + 38 + i * 70;
      const op = (0.5 + rand() * 0.4).toFixed(2);
      put(`<rect x="${cx}" y="${y}" width="9" height="20" fill="${b.c}" fill-opacity="${op}"/>`);
      put(`<rect x="${cx + 15}" y="${y + 0.8}" width="7.4" height="18.4" fill="none" stroke="${b.c}" stroke-opacity="${op}" stroke-width="1.6"/>`);
    }
  }
  put(`<text x="${b.x + 24}" y="${CARD_Y + CARD_H - 22}" font-family="${CJK_LIGHT}" font-size="19" fill="${INK}" fill-opacity="0.5">${b.sub}</text>`);
}

// converging flows
const FLOW_TOP = CARD_Y + CARD_H + 8;
const SUM_RULE_Y = 1056;
const CXC = W / 2;
for (const b of books) {
  const sx = b.x + CARD_W / 2;
  put(`<path d="M ${sx} ${FLOW_TOP} C ${sx} ${FLOW_TOP + 70}, ${CXC} ${SUM_RULE_Y - 90}, ${CXC} ${SUM_RULE_Y - 18}" fill="none" stroke="${b.c}" stroke-opacity="0.55" stroke-width="2.2"/>`);
}
// double rule（结转：账已轧平）
put(`<line x1="220" y1="${SUM_RULE_Y}" x2="${W - 220}" y2="${SUM_RULE_Y}" stroke="${EMERALD}" stroke-width="3"/>`);
put(`<line x1="220" y1="${SUM_RULE_Y + 7}" x2="${W - 220}" y2="${SUM_RULE_Y + 7}" stroke="${EMERALD}" stroke-width="1.3"/>`);
put(`<text x="${W - 220}" y="${SUM_RULE_Y - 14}" text-anchor="end" font-family="${CJK_LIGHT}" font-size="19" letter-spacing="2" fill="${EMERALD_DEEP}">結轉 · Σ = 0</text>`);

// sum card
const SC_W = 620;
const SC_H = 150;
const SC_X = (W - SC_W) / 2;
const SC_Y = SUM_RULE_Y + 36;
put(`<rect x="${SC_X}" y="${SC_Y}" width="${SC_W}" height="${SC_H}" rx="22" fill="${EMERALD}"/>`);
put(`<text x="${SC_X + 34}" y="${SC_Y + 56}" font-family="${BOLD}" font-weight="700" font-size="30" fill="#fff">🧮 财务总表</text>`);
put(`<text x="${SC_X + 34}" y="${SC_Y + 112}" font-family="${BOLD}" font-weight="700" font-size="48" fill="#fff">¥ 79,364<tspan font-size="28" fill-opacity="0.8">.20</tspan></text>`);
put(`<text x="${SC_X + SC_W - 34}" y="${SC_Y + 64}" text-anchor="end" font-family="${CJK_LIGHT}" font-size="21" fill="#fff" fill-opacity="0.9">全部账本</text>`);
put(`<text x="${SC_X + SC_W - 34}" y="${SC_Y + 98}" text-anchor="end" font-family="${CJK_LIGHT}" font-size="21" fill="#fff" fill-opacity="0.9">自动汇总</text>`);

// texture row: paired ticks across, 借/贷 anchors
const TR_Y = 1318;
put(`<text x="92" y="${TR_Y + 17}" font-family="${KAI}" font-size="24" fill="${INK}" fill-opacity="0.65">借</text>`);
put(`<text x="${W - 92}" y="${TR_Y + 17}" text-anchor="end" font-family="${KAI}" font-size="24" fill="${INK}" fill-opacity="0.65">貸</text>`);
for (let i = 0; i < 17; i++) {
  const cx = 150 + i * ((W - 300) / 16);
  const op = (0.3 + rand() * 0.45).toFixed(2);
  put(`<rect x="${cx - 12}" y="${TR_Y}" width="9" height="20" fill="${EMERALD_DEEP}" fill-opacity="${op}"/>`);
  put(`<rect x="${cx + 4}" y="${TR_Y + 0.8}" width="7.4" height="18.4" fill="none" stroke="${EMERALD_DEEP}" stroke-opacity="${op}" stroke-width="1.6"/>`);
}
put(`<text x="${W / 2}" y="${TR_Y + 64}" text-anchor="middle" font-family="${CJK_LIGHT}" font-size="21" letter-spacing="4" fill="${INK}" fill-opacity="0.55">每一笔都借贷平衡 — 底层复式记账，你只管「记一笔」</text>`);

// pills
const pills = ['开源免费', '数据 100% 在本机', '复式记账内核', '生意进销存 · 开发中'];
const PILL_H = 54;
const widths = pills.map((t) => t.length * 22 + 52);
const totalW = widths.reduce((a, b) => a + b, 0) + (pills.length - 1) * 22;
let px = (W - totalW) / 2;
const PY = 1432;
for (let i = 0; i < pills.length; i++) {
  put(`<rect x="${px}" y="${PY}" width="${widths[i]}" height="${PILL_H}" rx="27" fill="none" stroke="${INK}" stroke-opacity="0.3" stroke-width="1.5"/>`);
  put(`<text x="${px + widths[i] / 2}" y="${PY + 36}" text-anchor="middle" font-family="${CJK}" font-size="22" fill="${INK}" fill-opacity="0.75">${pills[i]}</text>`);
  px += widths[i] + 22;
}

// footer
put(`<text x="${W / 2}" y="1568" text-anchor="middle" font-family="${CJK_LIGHT}" font-size="20" letter-spacing="4" fill="${INK}" fill-opacity="0.45">衡记 Héng · 开源记账 — 桌面版已能跑，仓库链接见评论区</text>`);

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${S.join('\n')}</svg>`;

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: W },
  font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' },
  background: PAPER,
});
const png = resvg.render().asPng();
const out = join(dirname(fileURLToPath(import.meta.url)), 'poster-hengji-xhs-3x4.png');
writeFileSync(out, png);
console.log(`xhs poster written: ${out} (${(png.length / 1024).toFixed(0)} KB)`);
