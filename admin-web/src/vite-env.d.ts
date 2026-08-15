/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_MOCKS?: string;
  readonly VITE_DEMO_ACCOUNT?: string;
  readonly VITE_DEMO_PASSWORD?: string;
  readonly VITE_CLOUDBASE_ENV_ID?: string;
  readonly VITE_CLOUDBASE_REGION?: string;
  readonly VITE_CLOUDBASE_PUBLISHABLE_KEY?: string;
  readonly VITE_CASE_ADMIN_FUNCTION?: string;
  readonly VITE_IMAGE_PROCESSOR_FUNCTION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
