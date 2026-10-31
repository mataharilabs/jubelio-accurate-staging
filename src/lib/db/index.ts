import { supabaseConfigured } from "@/lib/env";
import { LocalStore } from "@/lib/db/local-store";
import type { DataStore } from "@/lib/db/store";
import { SupabaseStore } from "@/lib/db/supabase-store";

let pending: Promise<DataStore> | null = null;

async function open(): Promise<DataStore> {
  const store: DataStore = supabaseConfigured() ? new SupabaseStore() : new LocalStore();
  await store.ensureSeeded();
  return store;
}

export function getStore(): Promise<DataStore> {
  if (!pending) {
    pending = open().catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

export type { DataStore };
