import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// 飞书多维表格插件是嵌入在 iframe 中运行的，
// 必须使用相对路径 base: './'，否则打包后的资源无法正确加载。
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    // Semi UI 新版 package.json 的 exports 未暴露全局样式子路径，
    // 这里用 alias 直接映射到文件系统中的实际 CSS，绕过 exports 限制。
    alias: {
      '@douyinfe/semi-ui/dist/css/semi.min.css': fileURLToPath(
        new URL('node_modules/@douyinfe/semi-ui/dist/css/semi.min.css', import.meta.url)
      ),
    },
  },
  server: {
    host: true,
    port: 8848,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    // 飞书官方诊断 P1-7：正式发布必须从空目录产出，emptyOutDir:false 会把
    // 历史哈希资源持续留在 dist（包体膨胀、旧代码随包交付，扩大审计面）。
    // Vite 用 fs.rm 清理（不走回收站），如有权限问题请先手动删除 dist 再构建。
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2019',
  },
});
