import Konva from 'konva'
import type {
  Command,
  DrawCommand,
  EditPatch,
  Position,
  ShapeKind,
  SizeName,
  Target,
} from './commands'
import type { Coord, SceneObject, SceneStore, ShapeAttrs } from './scene'

const SIZE_PX: Record<SizeName, number> = { small: 70, medium: 130, large: 210 }
const SIZE_ORDER: SizeName[] = ['small', 'medium', 'large']

// 九宫格 → 归一化中心(0..1);具体像素在渲染时按舞台尺寸换算并夹紧防溢出。
const GRID_FRAC: Record<Position, Coord> = {
  'top-left': { x: 0.16, y: 0.18 },
  top: { x: 0.5, y: 0.18 },
  'top-right': { x: 0.84, y: 0.18 },
  left: { x: 0.16, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  right: { x: 0.84, y: 0.5 },
  'bottom-left': { x: 0.16, y: 0.82 },
  bottom: { x: 0.5, y: 0.82 },
  'bottom-right': { x: 0.84, y: 0.82 },
}

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

/**
 * 执行引擎 = 场景渲染器。
 * - execute(cmd):把指令翻译成对 SceneStore 的增删,不直接碰画布。
 * - render():订阅 store 变更后全量重绘场景组(图元 + 编号角标);N 小,重建成本可忽略。
 * 提示文字(hint)是 layer 的兄弟节点,渲染只动自己的 sceneGroup,互不影响。
 */
export class Executor {
  private readonly stage: Konva.Stage
  private readonly layer: Konva.Layer
  private readonly store: SceneStore
  private readonly sceneGroup: Konva.Group

  constructor(stage: Konva.Stage, layer: Konva.Layer, store: SceneStore) {
    this.stage = stage
    this.layer = layer
    this.store = store
    this.sceneGroup = new Konva.Group()
    this.layer.add(this.sceneGroup)
    this.store.onChange(() => this.render())
  }

  /** 执行一条指令,返回给用户的反馈文案;实际绘制由 store 变更驱动 render。 */
  execute(cmd: Command): string {
    switch (cmd.action) {
      case 'clear':
        this.store.clear()
        return '已清空画布'
      case 'undo':
        return this.store.undo() ? '已撤销上一步' : '没有可撤销的操作'
      case 'redo':
        return this.store.redo() ? '已重做' : '没有可重做的操作'
      case 'delete': {
        const obj = this.resolveTarget(cmd.target)
        if (!obj) return this.noTargetMsg(cmd.target)
        const n = obj.number
        this.store.remove(obj.id)
        return `已删除 ${n} 号`
      }
      case 'edit': {
        const obj = this.resolveTarget(cmd.target)
        if (!obj) return this.noTargetMsg(cmd.target)
        const { patch, desc } = this.resolveEdit(obj, cmd.patch)
        if (!patch) return `不知道要怎么改 ${obj.number} 号`
        this.store.update(obj.id, patch)
        return `已把 ${obj.number} 号${desc}`
      }
      case 'draw':
        this.store.add(cmd.shape, {
          color: cmd.color,
          size: cmd.size,
          center: GRID_FRAC[cmd.position],
          scale: 1,
        })
        return `已画 ${describe(cmd)}`
      case 'generate':
        return '' // 生成式收尾由 Dispatcher 异步处理,渲染器不参与
      default: {
        const exhaustive: never = cmd
        return exhaustive
      }
    }
  }

  /** 解析操作目标:编号 → getByNumber;焦点指代「它 / 这个」→ getFocus(最近操作的图形)。 */
  private resolveTarget(target: Target): SceneObject | null {
    return target.by === 'number'
      ? this.store.getByNumber(target.n)
      : this.store.getFocus()
  }

  /** 目标不存在时的反馈文案。 */
  private noTargetMsg(target: Target): string {
    return target.by === 'number' ? `没有 ${target.n} 号图形` : '还没有可操作的图形'
  }

  /** 把高层 EditPatch 解析成对 ShapeAttrs 的具体修改 + 反馈文案。 */
  private resolveEdit(
    obj: SceneObject,
    patch: EditPatch,
  ): { patch: Partial<ShapeAttrs> | null; desc: string } {
    const out: Partial<ShapeAttrs> = {}
    const parts: string[] = []
    if (patch.color) {
      out.color = patch.color
      parts.push('改了颜色')
    }
    if (patch.sizeStep) {
      const i = SIZE_ORDER.indexOf(obj.attrs.size)
      const ni = Math.min(Math.max(i + patch.sizeStep, 0), SIZE_ORDER.length - 1)
      out.size = SIZE_ORDER[ni]
      parts.push(patch.sizeStep > 0 ? '放大' : '缩小')
    }
    if (patch.position) {
      out.center = GRID_FRAC[patch.position]
      parts.push(`移到${POS_CN[patch.position]}`)
    }
    return { patch: Object.keys(out).length > 0 ? out : null, desc: parts.join('、') }
  }

  /** 全量重绘:清空场景组后按 store 顺序重建每个对象。 */
  render(): void {
    this.sceneGroup.destroyChildren()
    for (const obj of this.store.all()) {
      this.sceneGroup.add(this.renderObject(obj))
    }
    this.layer.draw()
  }

  /** 把归一化中心换算为像素,并夹紧使图元完整留在画布内。 */
  private toPixel(center: Coord, half: number): { x: number; y: number } {
    const w = this.stage.width()
    const h = this.stage.height()
    const m = half + 12
    return {
      x: Math.min(Math.max(center.x * w, m), w - m),
      y: Math.min(Math.max(center.y * h, m), h - m),
    }
  }

  /** 一个对象 = 一个以图元中心为原点的 Group(图元 child + 编号角标)。 */
  private renderObject(obj: SceneObject): Konva.Group {
    const px = SIZE_PX[obj.attrs.size] * obj.attrs.scale
    const { x, y } = this.toPixel(obj.attrs.center, px / 2)
    const g = new Konva.Group({ x, y })
    g.add(this.createShape(obj.kind, px, obj.attrs.color))
    g.add(this.numberBadge(obj.number, px))
    return g
  }

  /** 编号角标:图元右上角的小圆 + 白色数字。 */
  private numberBadge(n: number, size: number): Konva.Group {
    const r = 13
    const off = size / 2
    const badge = new Konva.Group({ x: off, y: -off })
    badge.add(new Konva.Circle({ radius: r, fill: '#1e2a36', opacity: 0.85 }))
    badge.add(
      new Konva.Text({
        text: String(n),
        fontSize: 16,
        fontStyle: 'bold',
        fontFamily: 'sans-serif',
        fill: '#ffffff',
        width: r * 2,
        height: r * 2,
        align: 'center',
        verticalAlign: 'middle',
        x: -r,
        y: -r,
      }),
    )
    return badge
  }

  /** 创建以原点(0,0)为中心的图元主体。 */
  private createShape(shape: ShapeKind, size: number, color: string): Konva.Shape {
    const r = size / 2
    switch (shape) {
      case 'circle':
        return new Konva.Circle({ radius: r, fill: color })
      case 'rect':
        return new Konva.Rect({
          x: -r,
          y: -r,
          width: size,
          height: size,
          fill: color,
          cornerRadius: 6,
        })
      case 'triangle':
        return new Konva.RegularPolygon({ sides: 3, radius: r, fill: color })
      case 'line':
        return new Konva.Line({
          points: [-r, 0, r, 0],
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
