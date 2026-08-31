/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TEAM_API_URL?: string;
  readonly VITE_MANAGER_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
