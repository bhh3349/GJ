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
      // 路由级分包在 routes 层用 React.lazy 实现；这里把体积大头单独拆开，压住首屏。
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            antd: ['antd', '@ant-design/icons'],
          },
        },
      },
    },
  };
});
