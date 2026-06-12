import type { ShapeKind, SizeName } from './commands'

/** 归一化坐标(0..1),与具体画布像素无关 —— 便于序列化、响应式与相对定位。 */
export interface Coord {
  x: number
  y: number
}

/** 一个图元的可序列化「真相」。坐标恒为归一化中心,渲染时按舞台尺寸换算。 */
export interface ShapeAttrs {
  color: string
  size: SizeName
  center: Coord
  scale: number
}

/** 场景中的一个被追踪对象:有稳定 id 与从 1 起的编号角标。 */
export interface SceneObject {
  id: string
  number: number
  kind: ShapeKind
  attrs: ShapeAttrs
}

type ChangeCb = (store: SceneStore) => void

/**
 * 场景对象模型:绘图不再「画完即忘」,而是进入一个可被编号、增删、重排的集合。
 * 这是后续「按编号编辑 / 删除 / 撤销 / 指代」等能力的地基。
 * 变更通过 onChange 通知渲染器(Executor)。
 * 历史:每次增删改前对场景做快照,支持「撤销 / 重做」(粒度 = 一条用户指令)。
 */
export class SceneStore {
  private objects: SceneObject[] = []
  private seq = 0
  private listeners: ChangeCb[] = []
  private past: SceneObject[][] = []
  private future: SceneObject[][] = []

  /** 新增一个图元,自动分配 id 与下一个编号,并通知渲染。 */
  add(kind: ShapeKind, attrs: ShapeAttrs): SceneObject {
    this.snapshot()
    const obj: SceneObject = {
      id: `o${++this.seq}`,
      number: this.objects.length + 1,
      kind,
      attrs,
    }
    this.objects.push(obj)
    this.emit()
    return obj
  }

  /** 按 id 删除,删除后编号 1..N 致密重排,并通知渲染。 */
  remove(id: string): boolean {
    const i = this.objects.findIndex((o) => o.id === id)
    if (i < 0) return false
    this.snapshot()
    this.objects.splice(i, 1)
    this.renumber()
    this.emit()
    return true
  }

  /** 清空全部图元。 */
  clear(): void {
    if (this.objects.length === 0) return
    this.snapshot()
    this.objects = []
    this.emit()
  }

  /** 撤销上一步(回到最近一次快照前的状态)。 */
  undo(): boolean {
    const prev = this.past.pop()
    if (!prev) return false
    this.future.push(this.copy())
    this.objects = prev
    this.emit()
    return true
  }

  /** 重做被撤销的一步。 */
  redo(): boolean {
    const next = this.future.pop()
    if (!next) return false
    this.past.push(this.copy())
    this.objects = next
    this.emit()
    return true
  }

  /** 只读快照,供渲染器遍历。 */
  all(): readonly SceneObject[] {
    return this.objects
  }

  /** 按编号角标取对象(后续「删掉 2 号」「把 3 号变大」用)。 */
  getByNumber(n: number): SceneObject | null {
    return this.objects.find((o) => o.number === n) ?? null
  }

  /** 订阅变更:每次增删改后回调,渲染器据此重绘。 */
  onChange(cb: ChangeCb): void {
    this.listeners.push(cb)
  }

  private renumber(): void {
    this.objects.forEach((o, i) => {
      o.number = i + 1
    })
  }

  /** 把当前场景压入历史栈,并清空重做栈(新操作打断了重做链)。 */
  private snapshot(): void {
    this.past.push(this.copy())
    this.future = []
  }

  /** 深拷贝当前对象数组(含嵌套 attrs/center),供历史快照使用。 */
  private copy(): SceneObject[] {
    return this.objects.map((o) => ({
      ...o,
      attrs: { ...o.attrs, center: { ...o.attrs.center } },
    }))
  }

  private emit(): void {
    for (const cb of this.listeners) cb(this)
  }
}
