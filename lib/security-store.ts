// The security scan of each version (lib/security-scan.ts), kept next to
// the version: one row per version with the SHA-256 of the package it was
// made for and the scanner's version. A row whose package or scanner
// changed is scanned again when it is read; on start every pending and
// published version with an outdated or missing scan is scanned in the
// background (instrumentation.ts), and the admin API can ask for a new scan
// ("Erneut prüfen", POST /api/admin/submissions/:id/rescan).
//
// A block verdict keeps a version from being published through the admin
// API unless the reviewer overrides it with a reason; the override belongs to
// that package (its SHA-256) and is in the audit log.
//
// The table is created on first use (CREATE TABLE IF NOT EXISTS), not by a
// numbered migration: an older version of the marketplace ignores it.
import { createHash } from "node:crypto";
import { all, db, now, one, run } from "./db";
import { HttpError } from "./http";
import { readPackage } from "./storage";
import { PENDING } from "./status";
import { SCANNER_VERSION, scanPackage, type SecurityReport, type Verdict } from "./security-scan";

export type SecurityOverride = { reason: string; by: string; at: string };
export type StoredSecurity = SecurityReport & { override: SecurityOverride | null };
export type SecuritySummary = Pick<SecurityReport, "verdict" | "label" | "counts" | "scannedAt" | "scannerVersion"> & { overridden: boolean };

type Row = {
  version_id: string;
  sha256: string;
  scanner_version: string;
  verdict: Verdict;
  report: string;
  scanned_at: number;
  override_reason: string | null;
  override_by: string | null;
  override_at: number | null;
  override_sha256: string | null;
};

const ready = new WeakSet<object>();
function table() {
  const conn = db();
  if (ready.has(conn)) return;
  conn.exec(`CREATE TABLE IF NOT EXISTS security_scans (
     version_id TEXT PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,
     sha256 TEXT NOT NULL,
     scanner_version TEXT NOT NULL,
     verdict TEXT NOT NULL,
     report TEXT NOT NULL,
     scanned_at INTEGER NOT NULL,
     override_reason TEXT,
     override_by TEXT,
     override_at INTEGER,
     override_sha256 TEXT
   )`);
  ready.add(conn);
}

const iso = (at: number | null) => (at ? new Date(at).toISOString() : null);
function stored(row: Row): StoredSecurity {
  const report = JSON.parse(row.report) as SecurityReport;
  const override =
    row.override_reason && row.override_sha256 === row.sha256 ? { reason: row.override_reason, by: row.override_by ?? "", at: iso(row.override_at) ?? "" } : null;
  return { ...report, override };
}
const rowOf = (versionId: string) => {
  table();
  return one<Row>("SELECT * FROM security_scans WHERE version_id=?", versionId);
};

// One scan per version at a time (the start-up rescan, a detail view and a
// button press may ask together).
const running = new Map<string, Promise<StoredSecurity>>();

async function scanAndStore(versionId: string, bytes: Buffer, sha256: string): Promise<StoredSecurity> {
  const report = await scanPackage(bytes);
  table();
  const at = now();
  run(
    `INSERT INTO security_scans(version_id,sha256,scanner_version,verdict,report,scanned_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(version_id) DO UPDATE SET sha256=excluded.sha256,scanner_version=excluded.scanner_version,verdict=excluded.verdict,report=excluded.report,scanned_at=excluded.scanned_at`,
    versionId,
    sha256,
    SCANNER_VERSION,
    report.verdict,
    JSON.stringify(report),
    at,
  );
  return stored(rowOf(versionId)!);
}

// The scan of a version: the stored one while it fits the package and the
// scanner, else a fresh one. null when the package file is gone.
export async function securityOf(versionId: string, options: { force?: boolean } = {}): Promise<StoredSecurity | null> {
  const pending = running.get(versionId);
  if (pending) return pending;
  let bytes: Buffer;
  try {
    bytes = readPackage(versionId);
  } catch {
    return null;
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const row = rowOf(versionId);
  if (!options.force && row && row.sha256 === sha256 && row.scanner_version === SCANNER_VERSION) return stored(row);
  const job = scanAndStore(versionId, bytes, sha256).finally(() => running.delete(versionId));
  running.set(versionId, job);
  return job;
}

// What the queue shows: the stored scan only (no file is read); scans that
// are missing or outdated are started in the background.
export function securitySummaryOf(versionId: string): SecuritySummary | null {
  const row = rowOf(versionId);
  if (!row || row.scanner_version !== SCANNER_VERSION) {
    if (!running.has(versionId)) void securityOf(versionId).catch(() => {});
    if (!row) return null;
  }
  const s = stored(row);
  return { verdict: s.verdict, label: s.label, counts: s.counts, scannedAt: s.scannedAt, scannerVersion: s.scannerVersion, overridden: !!s.override };
}

export async function rescan(versionId: string, actor: string, audit: (actor: string, action: string, target: string, details?: Record<string, unknown>) => void) {
  if (!one("SELECT 1 FROM versions WHERE id=?", versionId)) throw new HttpError(404, "not_found", "Submission not found.");
  const result = await securityOf(versionId, { force: true });
  if (!result) throw new HttpError(409, "package_missing", "The package file is missing.");
  audit(actor, "security_rescan", versionId, { verdict: result.verdict, counts: result.counts, scannerVersion: result.scannerVersion });
  return result;
}

// Publishing past a block verdict: only with a reason, recorded for this
// package. Returns the override written (null when none was needed).
export async function requireSecurityClearance(
  versionId: string,
  reason: unknown,
  actor: string,
  audit: (actor: string, action: string, target: string, details?: Record<string, unknown>) => void,
): Promise<SecurityOverride | null> {
  const security = await securityOf(versionId);
  if (!security || security.verdict !== "block" || security.override) return security?.override ?? null;
  const text = typeof reason === "string" ? reason.trim().slice(0, 2000) : "";
  if (text.length < 10)
    throw new HttpError(
      409,
      "security_blocked",
      `The security scan blocks this package (${security.counts.block} finding(s)). Publishing needs securityOverride: a reason of at least 10 characters.`,
    );
  const at = now();
  run("UPDATE security_scans SET override_reason=?,override_by=?,override_at=?,override_sha256=sha256 WHERE version_id=?", text, actor, at, versionId);
  audit(actor, "security_override", versionId, {
    reason: text,
    sha256: security.sha256,
    scannerVersion: security.scannerVersion,
    blocking: security.findings.filter((f) => f.severity === "block").map((f) => f.code),
  });
  return { reason: text, by: actor, at: iso(at)! };
}

// On start: every pending and published version whose scan is missing,
// made by another scanner version or for other bytes. One after the other,
// in the background.
export async function rescanOutdated(log: (message: string) => void = () => {}) {
  table();
  const statuses = [...PENDING, "published"];
  const rows = all<{ id: string }>(
    `SELECT v.id FROM versions v LEFT JOIN security_scans s ON s.version_id=v.id
     WHERE v.status IN (${statuses.map(() => "?").join(",")}) AND (s.version_id IS NULL OR s.scanner_version<>?)
     ORDER BY v.submitted_at ASC`,
    ...statuses,
    SCANNER_VERSION,
  );
  let n = 0;
  for (const { id } of rows) {
    try {
      if (await securityOf(id)) n++;
    } catch (error) {
      log(`Security scan of ${id} failed: ${(error as Error)?.message ?? error}`);
    }
  }
  if (n) log(`Security scan: ${n} version(s) scanned (scanner ${SCANNER_VERSION}).`);
  return n;
}

// A package an admin uploads to replace one (lib/admin-edit.ts): scanned
// before it is stored. Replacing the package of a published template
// publishes it at once, so a block verdict needs securityOverride there –
// like publishing a submission. Returns the scan and the reason to record.
export async function scanReplacement(bytes: Uint8Array, publishes: boolean, reason: unknown) {
  const report = await scanPackage(bytes);
  const text = typeof reason === "string" ? reason.trim().slice(0, 2000) : "";
  if (publishes && report.verdict === "block" && text.length < 10)
    throw new HttpError(
      409,
      "security_blocked",
      `The security scan blocks this package (${report.counts.block} finding(s)). Replacing a published package needs securityOverride: a reason of at least 10 characters.`,
      { security: report },
    );
  return { report, override: publishes && report.verdict === "block" ? text : null };
}

// After the replacement is stored: the version's scan (of the stored bytes)
// and, if one was needed, the reviewer's override for exactly these bytes.
export async function recordReplacement(
  versionId: string,
  override: string | null,
  actor: string,
  audit: (actor: string, action: string, target: string, details?: Record<string, unknown>) => void,
) {
  const security = await securityOf(versionId, { force: true });
  if (security && override && security.verdict === "block") {
    const at = now();
    run("UPDATE security_scans SET override_reason=?,override_by=?,override_at=?,override_sha256=sha256 WHERE version_id=?", override, actor, at, versionId);
    audit(actor, "security_override", versionId, { reason: override, sha256: security.sha256, scannerVersion: security.scannerVersion, blocking: security.findings.filter((f) => f.severity === "block").map((f) => f.code), via: "package_replaced" });
    return securityOf(versionId);
  }
  return security;
}
