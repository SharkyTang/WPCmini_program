export interface DemoCredentials {
  account: string;
  password: string;
}

export function getDemoCredentials(): DemoCredentials {
  return {
    account: String(import.meta.env.VITE_DEMO_ACCOUNT || "").trim(),
    password: String(import.meta.env.VITE_DEMO_PASSWORD || ""),
  };
}
