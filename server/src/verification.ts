import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Genuine verification state (Phase 1C, Priority 3).
 *
 * Every field here is set ONLY by a successful real Meta API interaction,
 * never by key presence. A configured key alone leaves all timestamps null.
 * State is persisted to verification.json in the data directory so a
 * restart does not reset (or invent) verification — it reports what was
 * actually verified, when. No key material is ever stored here.
 */
export interface VerificationState {
  sparkConnectedAt: string | null;
  sparkImageAt: string | null;
  samAt: string | null;
  samLastDetections: number | null;
  lastFailure: string | null;
  lastWarning: string | null;
}

export function emptyVerification(): VerificationState {
  return {
    sparkConnectedAt: null,
    sparkImageAt: null,
    samAt: null,
    samLastDetections: null,
    lastFailure: null,
    lastWarning: null,
  };
}

export async function loadVerification(dataDir: string): Promise<VerificationState> {
  try {
    const raw = await readFile(path.join(dataDir, "verification.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<VerificationState>;
    return { ...emptyVerification(), ...parsed };
  } catch {
    return emptyVerification();
  }
}

export async function saveVerification(dataDir: string, state: VerificationState): Promise<void> {
  await mkdir(dataDir, { recursive: true }).catch(() => undefined);
  await writeFile(path.join(dataDir, "verification.json"), JSON.stringify(state, null, 2)).catch(() => undefined);
}
