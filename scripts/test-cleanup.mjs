const WEBSOCKET_CLOSED = 3;
const TEST_WEBSOCKET_CLOSE_TIMEOUT_MS = 5_000;

// Only pass sockets created by the test harness; timeout termination never targets a discovered session.
export function closeTestWebSocket(socket, { timeoutMs = TEST_WEBSOCKET_CLOSE_TIMEOUT_MS } = {}) {
  if (!socket || socket.readyState === WEBSOCKET_CLOSED) return Promise.resolve();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('WebSocket cleanup timeout must be positive');
  return new Promise((resolve, reject) => {
    let settled = false;
    let failure;
    let timer;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => finish(failure);
    const onError = error => {
      failure = error;
      if (socket.readyState === WEBSOCKET_CLOSED) finish(error);
    };
    socket.once('close', onClose);
    socket.on('error', onError);
    timer = setTimeout(() => {
      failure = new Error('Timed out closing test WebSocket', failure ? { cause: failure } : undefined);
      try { socket.terminate(); }
      catch (error) { failure = new AggregateError([failure, error], 'Test WebSocket termination failed'); }
      finish(failure);
    }, timeoutMs);
    try {
      if (socket.readyState === WEBSOCKET_CLOSED) finish();
      else socket.close();
    } catch (error) { finish(error); }
  });
}

// Run every owned-resource cleanup, retaining both the assertion failure and all cleanup failures.
export async function withTestCleanup(operation, resources) {
  let result;
  let failed = false;
  let failure;
  try { result = await operation(); }
  catch (error) { failed = true; failure = error; }
  const errors = [];
  const labels = [];
  for (const { label, cleanup } of resources) {
    try { await cleanup(); }
    catch (error) {
      labels.push(label);
      errors.push(new Error(`Cleanup failed: ${label}`, { cause: error }));
    }
  }
  if (errors.length) {
    throw new AggregateError(failed ? [failure, ...errors] : errors,
      `Test resource cleanup failed: ${labels.join(', ')}`, failed ? { cause: failure } : undefined);
  }
  if (failed) throw failure;
  return result;
}
