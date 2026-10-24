import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withTestCleanup } from '../../support/cleanup.mjs';

const NODE_PREFIX = 'inventory-store-fixture-';
const OBSERVATION_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const session = (id, title = id) => ({ id, title, provider: 'codex-app', cwd: '/synthetic',
  status: 'idle', loaded: true, capabilities: ['read', 'send'], observedAt: new Date().toISOString() });

// Runs ONLY inside the runner-owned temporary PostgreSQL database, using its
// two existing Store instances. No node socket, credentials or user data.
export async function verifyNodeSessionStore({ stores, pool, waitFor }) {
  const nodeId = NODE_PREFIX + randomUUID(), otherNode = NODE_PREFIX + randomUUID();
  const assertKnown = async expected => {
    for (const item of expected) assert.deepEqual(await stores[0].getKnownSession(nodeId, item.id), item,
      'Historical identity lost its most recent complete observation');
  };

  // Holding the actual namespaced PG lock creates deterministic cross-pool
  // contention. Wait for each real blocked backend before queuing the next.
  const contend = async (operations, whileBlocked) => {
    const client = await pool.connect(), pending = [], failures = [];
    let holding = false;
    await withTestCleanup(async () => {
      await client.query('BEGIN');
      holding = true;
      await client.query(OBSERVATION_LOCK_SQL, [JSON.stringify(['node_sessions', nodeId])]);
      const { rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid');
      for (const operation of operations) {
        pending.push(operation().then(() => undefined, error => { failures.push(error); }));
        await waitFor(async () => {
          if (failures.length) throw new AggregateError(failures, 'Inventory operation failed while contending');
          const waiting = await pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE wait_event_type='Lock' AND $1::integer = ANY(pg_blocking_pids(pid))`, [pid]);
          return waiting.rows[0].count >= pending.length;
        }, `Inventory transaction ${pending.length} blocked on same-node lock`);
      }
      await whileBlocked?.();
      await client.query('COMMIT');
      holding = false;
      await Promise.all(pending);
      if (failures.length) throw new AggregateError(failures, 'Concurrent inventory mutation failed');
    }, [
      { label: 'held inventory fixture transaction', cleanup: async () => {
        if (holding) { await client.query('ROLLBACK'); holding = false; }
      } },
      { label: 'pending inventory fixture writes', cleanup: async () => {
        await Promise.all(pending);
        if (failures.length) throw new AggregateError(failures, 'Pending inventory writes failed');
      } },
      { label: 'inventory fixture transaction client', cleanup: () => client.release() },
    ]);
  };

  await withTestCleanup(async () => {
    const initial = [session('shared', 'initial'), session('seed-only')];
    const older = [session('shared', 'older'), session('old-only')];
    const latest = [session('shared', 'latest'), { ...session('new-only'), capabilities: ['read'], loaded: false }];
    // Concurrent observations keep each identity whole and preserve offline history.
    for (const seed of [[], initial]) {
      await stores[0].upsertNodeSessions(nodeId, seed);
      await contend([
        () => stores[0].upsertNodeSessions(nodeId, older),
        () => stores[1].upsertNodeSessions(nodeId, latest),
      ], async () => {
        const independent = session('independent');
        await stores[1].upsertNodeSessions(otherNode, [independent]);
        assert.deepEqual(await stores[0].getKnownSession(otherNode, independent.id), independent);
      });
      await assertKnown([older[1], ...latest]);
    }
    await stores[0].removeNodeSessions(nodeId);
    await assertKnown([initial[1], older[1], ...latest]);
    await stores[1].upsertNodeSessions(nodeId, []);
    await assertKnown(latest);
    for (const store of stores) {
      await assert.rejects(store.upsertNodeSessions(nodeId, [session('duplicate'),
        { ...session('duplicate'), capabilities: [] }]), /Duplicate session IDs/);
      await assertKnown(latest);
      assert.equal(await stores[0].getKnownSession(nodeId, 'duplicate'), null);
    }
    // A failed observation batch must roll back earlier identities and release the lock.
    await assert.rejects(stores[0].upsertNodeSessions(nodeId, [session('shared', 'must roll back'), session('x'.repeat(65))]),
      error => error.code === '22001');
    await assertKnown(latest);
    await stores[1].upsertNodeSessions(nodeId, older);
    await assertKnown([...older, latest[1]]);
    console.log('PASS real PostgreSQL session observations: same-node cross-store ordering, whole identity/capability updates, per-node isolation, offline history after disconnect and empty inventories, duplicate-ID rejection and atomic rollback; lock released after failure');
  }, [
    { label: 'synthetic inventory node cleanup', cleanup: () => stores[0].removeNodeSessions(nodeId) },
    { label: 'synthetic independent node cleanup', cleanup: () => stores[0].removeNodeSessions(otherNode) },
    { label: 'synthetic session history cleanup', cleanup: () => pool.query('DELETE FROM known_sessions WHERE node_id=ANY($1::text[])', [[nodeId, otherNode]]) },
  ]);
}
