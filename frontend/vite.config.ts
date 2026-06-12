import { defineConfig } from 'vite'

// say-draw 前端构建配置
export default defineConfig({
  server: {
    port: 5173,
    open: true,
    // 开发期把 /api 代理到后端(豆包慢路),浏览器同源调用、免 CORS
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
})
