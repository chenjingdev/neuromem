/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PRODUCT_API_URL?: string;
  readonly VITE_PRODUCT_URL?: string;
  readonly VITE_MANAGER_API_URL?: string;
  readonly VITE_NODE_ADMIN_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
