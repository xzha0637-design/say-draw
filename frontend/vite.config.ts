import { defineConfig } from 'vite'

// say-draw 前端构建配置
export default defineConfig({
  server: {
    port: 5173,
    open: true,
    // 开发期把 /api 代理到后端(豆包慢路),浏览器同源调用、免 CORS
    // ws:true 让 /api/asr/stream 的 WebSocket(云端流式语音识别)也能经代理到达后端
    proxy: {
      '/api': { target: 'http://localhost:8787', ws: true },
    },
  },
})
