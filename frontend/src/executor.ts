import Konva from 'konva'
import type { Command, DrawCommand, Position, ShapeKind, SizeName } from './commands'

const SIZE_PX: Record<SizeName, number> = { small: 70, medium: 130, large: 210 }

const SHAPE_CN: Record<ShapeKind, string> = {
  circle: '圆',
  rect: '方块',
  triangle: '三角形',
  line: '线',
}
const POS_CN: Record<Position, string> = {
  'top-left': '左上',
  top: '上方',
  'top-right': '右上',
  left: '左侧',
  center: '中间',
  right: '右侧',
  'bottom-left': '左下',
  bottom: '下方',
  'bottom-right': '右下',
}
const SIZE_CN: Record<SizeName, string> = { small: '小', medium: '中', large: '大' }

function describe(cmd: DrawCommand): string {
  return `${SIZE_CN[cmd.size]}号${SHAPE_CN[cmd.shape]}(${POS_CN[cmd.position]})`
}

/** 执行引擎:把结构化指令渲染到 Konva 画布。 */
export class Executor {
  private readonly stage: Konva.Stage
  private readonly layer: Konva.Layer

  constructor(stage: Konva.Stage, layer: Konva.Layer) {
    this.stage = stage
    this.layer = layer
  }

  /** 执行一条指令,返回给用户的反馈文案。 */
  execute(cmd: Command): string {
    if (cmd.action === 'clear') {
      this.layer.destroyChildren()
      this.layer.draw()
      return '已清空画布'
    }

    const size = SIZE_PX[cmd.size]
    const { x, y } = this.anchor(cmd.position, size)
    this.layer.add(this.createShape(cmd.shape, size, cmd.color, x, y))
    this.layer.draw()
    return `已画 ${describe(cmd)}`
  }

  /** 九宫格锚点 → 画布坐标(带边距,避免贴边)。 */
  private anchor(pos: Position, size: number): { x: number; y: number } {
    const m = size / 2 + 24
    const w = this.stage.width()
    const h = this.stage.height()
    const xs: Record<'left' | 'center' | 'right', number> = {
      left: m,
      center: w / 2,
      right: w - m,
    }
    const ys: Record<'top' | 'center' | 'bottom', number> = {
      top: m,
      center: h / 2,
      bottom: h - m,
    }
    const map: Record<Position, { x: number; y: number }> = {
      'top-left': { x: xs.left, y: ys.top },
      top: { x: xs.center, y: ys.top },
      'top-right': { x: xs.right, y: ys.top },
      left: { x: xs.left, y: ys.center },
      center: { x: xs.center, y: ys.center },
      right: { x: xs.right, y: ys.center },
      'bottom-left': { x: xs.left, y: ys.bottom },
      bottom: { x: xs.center, y: ys.bottom },
      'bottom-right': { x: xs.right, y: ys.bottom },
    }
    return map[pos]
  }

  private createShape(
    shape: ShapeKind,
    size: number,
    color: string,
    x: number,
    y: number,
  ): Konva.Shape {
    switch (shape) {
      case 'circle':
        return new Konva.Circle({ x, y, radius: size / 2, fill: color })
      case 'rect':
        return new Konva.Rect({
          x: x - size / 2,
          y: y - size / 2,
          width: size,
          height: size,
          fill: color,
          cornerRadius: 6,
        })
      case 'triangle':
        return new Konva.RegularPolygon({ x, y, sides: 3, radius: size / 2, fill: color })
      case 'line':
        return new Konva.Line({
          points: [x - size / 2, y, x + size / 2, y],
          stroke: color,
          strokeWidth: 8,
          lineCap: 'round',
        })
      default: {
        const exhaustive: never = shape
        return exhaustive
      }
    }
  }
}
