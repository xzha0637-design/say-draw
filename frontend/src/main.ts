import Konva from 'konva'
import './style.css'

const containerId = 'canvas-container'
const container = document.getElementById(containerId) as HTMLDivElement

// 画布:铺满视口
const stage = new Konva.Stage({
  container: containerId,
  width: container.clientWidth,
  height: container.clientHeight,
})

const layer = new Konva.Layer()
stage.add(layer)

// 占位提示(PR1 仅验证画布可用;后续 PR 接入语音识别与绘图执行)
const hint = new Konva.Text({
  text: 'say-draw\n空画布已就绪 · 等待接入语音绘图',
  fontSize: 22,
  fontFamily: 'sans-serif',
  fill: '#cccccc',
  align: 'center',
  lineHeight: 1.5,
})

function centerHint(): void {
  hint.position({
    x: stage.width() / 2 - hint.width() / 2,
    y: stage.height() / 2 - hint.height() / 2,
  })
}

layer.add(hint)
centerHint()
layer.draw()

// 随窗口大小自适应
window.addEventListener('resize', () => {
  stage.width(container.clientWidth)
  stage.height(container.clientHeight)
  centerHint()
})
