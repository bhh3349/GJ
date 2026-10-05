/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 开发态管理面代理目标，默认 http://127.0.0.1:4001 */
  readonly VITE_DEV_ADMIN_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
