import type { Command, Position, ShapeKind, SizeName } from './commands'

export type ParseResult =
  | { ok: true; command: Command }
  | { ok: false; reason: string }

// 关键词表(靠前优先,避免子串误匹配,如「粉红」先于「红」)
const SHAPES: Array<{ kw: string[]; shape: ShapeKind }> = [
  { kw: ['圆形', '圆圈', '圆'], shape: 'circle' },
  { kw: ['正方形', '长方形', '矩形', '方块', '方形', '方'], shape: 'rect' },
  { kw: ['三角形', '三角'], shape: 'triangle' },
  { kw: ['直线', '线条', '线'], shape: 'line' },
]

const COLORS: Array<{ kw: string[]; value: string }> = [
  { kw: ['粉色', '粉红', '粉'], value: '#ff6fa5' },
  { kw: ['橙色', '橘色', '橙', '橘'], value: '#e67e22' },
  { kw: ['红色', '红'], value: '#e74c3c' },
  { kw: ['黄色', '黄'], value: '#f1c40f' },
  { kw: ['绿色', '绿'], value: '#2ecc71' },
  { kw: ['蓝色', '蓝'], value: '#3498db' },
  { kw: ['紫色', '紫'], value: '#9b59b6' },
  { kw: ['黑色', '黑'], value: '#2c3e50' },
  { kw: ['白色', '白'], value: '#ecf0f1' },
  { kw: ['灰色', '灰'], value: '#95a5a6' },
]

const POSITIONS: Array<{ kw: string[]; pos: Position }> = [
  { kw: ['左上'], pos: 'top-left' },
  { kw: ['右上'], pos: 'top-right' },
  { kw: ['左下'], pos: 'bottom-left' },
  { kw: ['右下'], pos: 'bottom-right' },
  { kw: ['正中', '中间', '中央', '中心'], pos: 'center' },
  { kw: ['顶部', '上方', '上面', '上边'], pos: 'top' },
  { kw: ['底部', '下方', '下面', '下边'], pos: 'bottom' },
  { kw: ['左边', '左侧', '左'], pos: 'left' },
  { kw: ['右边', '右侧', '右'], pos: 'right' },
]

const CLEAR_KW = ['清空', '清除', '清屏', '清掉', '全部删除', '删掉全部']
const UNDO_KW = ['撤销', '撤回', '退回', '回退', '上一步']
const REDO_KW = ['重做', '恢复']
const DEFAULT_COLOR = '#3498db'

function matchShape(t: string): ShapeKind | null {
  for (const e of SHAPES) if (e.kw.some((k) => t.includes(k))) return e.shape
  return null
}
function matchColor(t: string): string | null {
  for (const e of COLORS) if (e.kw.some((k) => t.includes(k))) return e.value
  return null
}
function matchPosition(t: string): Position | null {
  for (const e of POSITIONS) if (e.kw.some((k) => t.includes(k))) return e.pos
  return null
}
function detectSize(t: string): SizeName {
  if (/大|巨大|超大/.test(t)) return 'large'
  if (/小|迷你/.test(t)) return 'small'
  return 'medium'
}

/**
 * 极简规则解析(快路):中文绘图指令 → 结构化 Command。
 * 仅覆盖 L1 基础;复杂 / 口语化指令将在 PR4 交给 Claude 兜底。
 */
export function parse(raw: string): ParseResult {
  const t = raw.replace(/\s/g, '')

  if (CLEAR_KW.some((k) => t.includes(k))) {
    return { ok: true, command: { action: 'clear' } }
  }
  if (UNDO_KW.some((k) => t.includes(k))) {
    return { ok: true, command: { action: 'undo' } }
  }
  if (REDO_KW.some((k) => t.includes(k))) {
    return { ok: true, command: { action: 'redo' } }
  }

  const shape = matchShape(t)
  if (!shape) {
    return {
      ok: false,
      reason: '没听清要画什么(支持:圆 / 方块 / 三角 / 线;或说「清空」)',
    }
  }

  return {
    ok: true,
    command: {
      action: 'draw',
      shape,
      color: matchColor(t) ?? DEFAULT_COLOR,
      size: detectSize(t),
      position: matchPosition(t) ?? 'center',
    },
  }
}
