/**
 * 显示单位状态(#unit-toggle):mm / mil 全局显示单位切换。
 *
 * 文档原始存储单位不变,本模块只服务显示层(状态栏光标坐标、属性面板
 * 坐标/尺寸/钻孔/线宽、量测读数与刻度步长),画布图形一律不动。
 *
 * 两类文档的存储坐标尺度不同(实测 samples 并与 render/sch.ts、render/pcb.ts
 * 的注释互证):
 *   - PCB / FOOTPRINT:1 单位 = 1 mil(走线 8~25 单位即 8~25mil);
 *   - SCH / SYMBOL / PANEL 等:1 单位 = 0.254 mm = 10 mil(A4 页 = 1170 单位
 *     = 297mm;原理图线宽 2 单位 = 0.508mm)。此前显示层一律按"mil"标注,
 *     对 sch 体系是 10× 错标,本模块的换算按真实尺度处理。
 *
 * 当前单位持久化到 localStorage(用户偏好,与语言/主题同级的做法);切换
 * 时广播给订阅者 —— shell(按钮文字 + 状态栏坐标重算)、props(重建属性行)、
 * measure(重绘标尺)各自订阅,换算逻辑集中在这里不散落。
 */
export type Unit = 'mm' | 'mil';

/** 1 mil = 0.0254 mm */
export const MM_PER_MIL = 0.0254;

const STORE_KEY = 'ev.unit';
/** 默认 mil:PCB 体系存储即 mil,与属性面板/状态栏既有显示一致 */
const DEFAULT_UNIT: Unit = 'mil';

function readStored(): Unit {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v === 'mm' || v === 'mil' ? v : DEFAULT_UNIT;
  } catch {
    return DEFAULT_UNIT; // localStorage 不可用(隐私模式等)时退回默认
  }
}

let current: Unit = readStored();
/** 当前文档 1 个存储坐标单位 = 多少 mil(打开文档时由 shell 告知) */
let docScale = 1;
const subs = new Set<() => void>();

/** 当前显示单位 */
export function getUnit(): Unit {
  return current;
}

/** 设置显示单位:持久化并广播;与当前相同则不动 */
export function setUnit(u: Unit): void {
  const next: Unit = u === 'mm' ? 'mm' : 'mil';
  if (next === current) return;
  current = next;
  try { localStorage.setItem(STORE_KEY, current); } catch { /* 持久化失败不影响会话内切换 */ }
  for (const fn of subs) fn();
}

/** 在 mm/mil 间切换,返回切换后的单位 */
export function toggleUnit(): Unit {
  setUnit(current === 'mm' ? 'mil' : 'mm');
  return current;
}

/** 订阅单位变化,返回退订函数 */
export function onUnitChange(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/**
 * shell 打开文档时告知该文档 1 个坐标单位 = 多少 mil,作为显示换算基准。
 * 不广播:打开文档本身就会触发状态栏重算 / 属性重建 / 标尺重绘。
 */
export function setDocScale(milPerUnit: number): void {
  if (Number.isFinite(milPerUnit) && milPerUnit > 0) docScale = milPerUnit;
}

/** 当前文档 1 坐标单位 = 多少 mil */
export function getDocScale(): number {
  return docScale;
}

/** 文档族 → 1 存储坐标单位 = 多少 mil(#unit-toggle 换算基准) */
export function docScaleFor(kind: 'sch' | 'pcb' | 'panel' | 'footprint' | 'other'): number {
  return kind === 'pcb' || kind === 'footprint' ? 1 : 10;
}

/** 文档坐标单位值 → 当前显示单位的数值 */
export function conv(v: number): number {
  return current === 'mm' ? v * docScale * MM_PER_MIL : v * docScale;
}

/** 单位后缀('mm' | 'mil') */
export function unitSuffix(): Unit {
  return current;
}

/**
 * 通用长度数值(属性面板等):换算到当前单位后四舍五入到 dec 位小数并去
 * 尾零(与既有 fmt() 的 "100"/"2.54" 风格一致)。
 */
export function fmtLen(v: number, dec = 3): string {
  const n = conv(Number(v));
  if (!Number.isFinite(n)) return String(v);
  const p = 10 ** dec;
  return String(Math.round(n * p) / p);
}

/** 状态栏光标坐标:mil 1 位小数(既有习惯),mm 2 位小数 */
export function fmtCoord(v: number): string {
  return current === 'mm' ? (v * docScale * MM_PER_MIL).toFixed(2) : (v * docScale).toFixed(1);
}
