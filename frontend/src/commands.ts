// 绘图指令的数据模型
// PR3 由规则解析产出;PR4 起将由 Claude 产出同样结构(结构化输出)。

export type ShapeKind = 'circle' | 'rect' | 'triangle' | 'line'

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
  color: string // 解析后的 CSS 颜色值
  size: SizeName
  position: Position
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

export type Command = DrawCommand | ClearCommand | UndoCommand | RedoCommand
