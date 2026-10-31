export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3847").replace(/\/$/, "");
}

export function supabaseUrl(): string {
  return (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
}

export function supabaseAnonKey(): string {
  return (process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
}

export function supabaseServiceKey(): string {
  return (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

export function supabaseConfigured(): boolean {
  return Boolean(supabaseUrl() && supabaseAnonKey() && supabaseServiceKey());
}

export function accurateEnv() {
  return {
    clientId: process.env.ACCURATE_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.ACCURATE_CLIENT_SECRET?.trim() ?? "",
    redirectUri: (process.env.ACCURATE_REDIRECT_URI || `${appUrl()}/api/accurate/callback`).trim(),
    databaseId: process.env.ACCURATE_DATABASE_ID?.trim() ?? "",
  };
}

export function accurateConfigured(): boolean {
  const env = accurateEnv();
  return Boolean(env.clientId && env.clientSecret);
}

export function missingAccurateEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.ACCURATE_CLIENT_ID?.trim()) missing.push("ACCURATE_CLIENT_ID");
  if (!process.env.ACCURATE_CLIENT_SECRET?.trim()) missing.push("ACCURATE_CLIENT_SECRET");
  return missing;
}
