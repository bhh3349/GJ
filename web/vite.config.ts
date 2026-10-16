import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// 管理面 :4001（同源：REST + WS + SPA 静态资源），网关 :4000。
// 开发态 Vite dev server 代理 /api（含 WS）到管理面，保证 Cookie 同源语义与生产一致。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const adminTarget = env.VITE_DEV_ADMIN_TARGET ?? 'http://127.0.0.1:4001';

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      // host: true = 绑 ::（双栈，Node 对 :: 默认关 V6ONLY）。
      // 不写时 Vite 5 缺省绑 localhost，本机把 localhost 解析成 ::1 在前，
      // dev server 就只剩 IPv6，Bo 用 127.0.0.1 / IPv4 打不开。双栈后两边都通。
      host: true,
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: adminTarget,
          changeOrigin: false,
          ws: true,
        },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      // 分包口径（改这里之前先看 index.html 的 modulepreload 有没有变多）：
      // - 只拆「确定整包都在首屏静态闭包里」的 react 系，图的是长期缓存（改业务代码不动这 65 kB）。
      // - 刻意不给 antd / @ant-design/icons / echarts 配 manualChunks。manualChunks 的分组是无条件的：
      //   只要该组被入口静态引用，整组都会变成入口的 modulepreload，于是 Table/Form/DatePicker
      //   这些只有懒加载路由才用到的组件被强行拖进首屏——实测这么分组首屏 gzip 从 246.81 涨到 412.29 kB。
      //   不分组时 Rollup 按真实可达性拆：antd 里只被 /keys、/logs 用的 Table 等自动落进懒 chunk。
      // - echarts 同理，它天然只落在 /stats 那条路由的 chunk 里，别去"优化"它。
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
          },
        },
      },
    },
  };
});
