// 绘图指令的数据模型
// PR3 由规则解析产出;PR4 起将由 Claude 产出同样结构(结构化输出)。

// 基础几何图元 + 'icon'(用 emoji 表示任意物体:房子/猫/树/星星…)
export type ShapeKind = 'circle' | 'rect' | 'triangle' | 'line' | 'icon'

export type SizeName = 'small' | 'medium' | 'large'

export type Position =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right'

export interface DrawCommand {
  action: 'draw'
  shape: ShapeKind
  color: string // 解析后的 CSS 颜色值(icon 用 emoji 自带颜色,可忽略)
  size: SizeName
  position: Position
  emoji?: string // shape==='icon' 时:渲染的 emoji(支持任意物体)
  label?: string // 语义名(房子 / 猫…),用于反馈文案与生成 prompt
}

export interface ClearCommand {
  action: 'clear'
}

export interface UndoCommand {
  action: 'undo'
}

export interface RedoCommand {
  action: 'redo'
}

/** 操作目标:按编号角标,或「它 / 这个」指代最近操作的图形(焦点)。 */
export type Target = { by: 'number'; n: number } | { by: 'focus' }

/** 删除一个图形(按编号或焦点指代)。 */
export interface DeleteCommand {
  action: 'delete'
  target: Target
}

export type SizeStep = 1 | -1

/** 对某个图形的属性修改(按需置位,可组合)。 */
export interface EditPatch {
  color?: string
  sizeStep?: SizeStep // 相对放大/缩小一档(small ↔ medium ↔ large)
  position?: Position // 移动到九宫格位置
}

/** 修改一个图形的属性(按编号或焦点指代)。 */
export interface EditCommand {
  action: 'edit'
  target: Target
  patch: EditPatch
}

/** 生成式收尾:把语音描述(+ 画布构图)渲染成写实大图。prompt 为空时由上层兜底。 */
export interface GenerateCommand {
  action: 'generate'
  prompt: string
}

export type Command =
  | DrawCommand
  | ClearCommand
  | UndoCommand
  | RedoCommand
  | DeleteCommand
  | EditCommand
  | GenerateCommand
