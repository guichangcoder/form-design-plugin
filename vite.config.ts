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
    // 本开发环境的回收站 trash 机制损坏，emptyOutDir:true 清理旧产物时会失败；
    // 改为 false（只写不删）可正常构建。用户真实部署环境可改回 true 自动清理。
    emptyOutDir: false,
    sourcemap: false,
    target: 'es2019',
  },
});
