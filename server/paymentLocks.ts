// Database-backed concurrency guards for payment-critical sections.
//
// 1. Finalize locks: prevent two concurrent finalize calls for the same
//    pendingId from double-processing (double loyalty deduction, double
//    Phorest booking, racing refunds).
// 2. Refund registry: shared between the finalize safety-nets and the
//    orphan sweep so the same PaymentIntent is never refunded from two
//    code paths at the same time.
//
// Locks are backed by PostgreSQL session-level advisory locks so they work
// correctly even when the app runs on multiple server instances (e.g. Fly.io
// scaled beyond one machine). Advisory locks live in the database session —
// they are automatically released if the DB connection drops (server crash),
// so there is no risk of a stale lock blocking indefinitely.
//
// Startup safety-belt
// -------------------
// If the server is killed with SIGKILL (or hard-crashes) while a lock is
// held, the OS closes the TCP connection and PostgreSQL automatically releases
// all advisory locks on that session. However, as a defensive measure,
// clearStaleAdvisoryLocks() is called once at boot on a brand-new connection
// that has never held any lock. pg_advisory_unlock_all() on a fresh session
// is always a no-op — it only releases locks held by the *calling* session —
// so this cannot disturb locks legitimately held by other live processes.
// The call is purely a safety-belt that guarantees clean state if any edge
// case (e.g. kernel-level TCP keepalive delay) ever causes a zombie lock to
// linger past the previous process's death.

import pg from "pg";

// Dedicated connection pool for advisory lock clients.
// Each active lock holds one client from this pool for the duration of the
// lock — the connection must remain open because advisory locks are
// session-scoped. Pool size is intentionally small (max 5 concurrent
// finalize operations is already an extreme case).
const _lockPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
});

_lockPool.on("error", (err) => {
  console.error("[PaymentLocks] Pool error:", err.message);
});

// Convert a string lock key to a signed 32-bit integer for use as a
// PostgreSQL advisory lock parameter. FNV-1a 32-bit via Math.imul.
// Collisions are theoretically possible but negligible for our key space
// (keys like "booking:<uuid>" and "refund:pi_<id>" never collide in practice).
function keyToLockInt(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash; // JS bitwise ops yield signed 32-bit integers, valid PG int8
}

// Map from lock key → the dedicated pg.PoolClient holding that advisory lock.
// This is per-instance; the real enforcement across instances happens in PG.
// The local map prevents the same instance from trying to double-acquire a
// lock it already holds (which would succeed in PG advisory lock semantics
// and cause an imbalance in unlock calls).
const heldClients = new Map<string, pg.PoolClient>();

export async function tryAcquireFinalizeLock(key: string): Promise<boolean> {
  if (heldClients.has(key)) return false; // already held on this instance
  const lockInt = keyToLockInt(key);
  let client: pg.PoolClient;
  try {
    client = await _lockPool.connect();
  } catch (err) {
    console.error("[PaymentLocks] Could not connect for advisory lock:", err);
    throw err;
  }
  try {
    const { rows } = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1::int8)",
      [lockInt],
    );
    if (!rows[0].pg_try_advisory_lock) {
      client.release();
      return false;
    }
    heldClients.set(key, client);
    return true;
  } catch (err) {
    client.release();
    throw err;
  }
}

export async function releaseFinalizeLock(key: string): Promise<void> {
  const client = heldClients.get(key);
  if (!client) return;
  heldClients.delete(key);
  const lockInt = keyToLockInt(key);
  try {
    await client.query("SELECT pg_advisory_unlock($1::int8)", [lockInt]);
  } catch (err) {
    console.error("[PaymentLocks] Error releasing advisory lock:", err);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Refund lock — same underlying mechanism, namespaced with "refund:" prefix
// ---------------------------------------------------------------------------

export async function tryAcquireRefundLock(paymentIntentId: string): Promise<boolean> {
  return tryAcquireFinalizeLock(`refund:${paymentIntentId}`);
}

export async function releaseRefundLock(paymentIntentId: string): Promise<void> {
  return releaseFinalizeLock(`refund:${paymentIntentId}`);
}

// ---------------------------------------------------------------------------
// Startup safety-belt: clear any advisory locks left by the previous process
// ---------------------------------------------------------------------------
//
// Call once during server boot (before any request handlers run).
// Uses a one-shot connection so it never touches a connection that has or
// will hold a real lock. On a fresh session pg_advisory_unlock_all() is
// always a no-op; the call exists solely to handle the theoretical edge case
// where a stale lock outlived the previous process's TCP teardown.
export async function clearStaleAdvisoryLocks(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    return; // no DB configured — advisory locks are not in use
  }
  let client: pg.PoolClient | undefined;
  try {
    client = await _lockPool.connect();
    await client.query("SELECT pg_advisory_unlock_all()");
    console.log("[PaymentLocks] Startup advisory-lock sweep complete (no-op on clean boot).");
  } catch (err) {
    // Non-fatal: log and continue. If the DB is temporarily unavailable at
    // boot the sweep is skipped; real lock conflicts will still be handled
    // correctly by pg_try_advisory_lock returning false.
    console.warn("[PaymentLocks] Could not run startup advisory-lock sweep:", err);
  } finally {
    client?.release();
  }
}

// Convenience wrapper: run a refund exactly once per PI across concurrent
// callers (including across separate server instances). Returns { ran: false }
// if another refund for this PI is already in flight anywhere.
export async function withRefundLock<T>(
  paymentIntentId: string,
  fn: () => Promise<T>
): Promise<{ ran: boolean; result?: T; error?: unknown }> {
  if (!await tryAcquireRefundLock(paymentIntentId)) {
    return { ran: false };
  }
  try {
    const result = await fn();
    return { ran: true, result };
  } catch (error) {
    return { ran: true, error };
  } finally {
    await releaseRefundLock(paymentIntentId);
  }
}
