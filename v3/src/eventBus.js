// Shared event bus (Phase 11). Two Web nodes need a common wake-up channel
// without Redis. Local is an in-memory pub/sub (SQLite/dev/testing); PostgreSQL
// uses LISTEN/NOTIFY so worker DB commits pg_notify() and Web-A/Web-B LISTEN to
// fan out to their local SSE clients.
//
// NOTIFY is only a wake-up / cache-invalidation / SSE hint. The DB row/state
// remains the source of truth; a Web node re-connects by re-reading state.

export const POSTGRES_NOTIFY_SQL = "SELECT pg_notify($1, $2)";

export function createLocalEventBus() {
  const subscribers = new Map();
  return {
    name: "local",
    publish(channel, payload) {
      const handlers = subscribers.get(channel);
      if (!handlers) return;
      for (const handler of [...handlers]) handler(payload);
    },
    subscribe(channel, handler) {
      if (!subscribers.has(channel)) subscribers.set(channel, new Set());
      subscribers.get(channel).add(handler);
      return () => subscribers.get(channel)?.delete(handler);
    },
    close() {
      subscribers.clear();
    },
  };
}

export function createPostgresEventBus({ pool, listenClient, prefix = "5151" } = {}) {
  const channelOf = (channel) => `${prefix}:${channel}`;
  return {
    name: "postgres",
    async publish(channel, payload) {
      if (!pool) throw new Error("postgres event bus publish requires a pool");
      await pool.query(POSTGRES_NOTIFY_SQL, [channelOf(channel), JSON.stringify(payload ?? null)]);
    },
    // LISTEN runs on a dedicated client (a pool connection cannot reliably
    // hold LISTEN). notifications arrive as { channel, payload }.
    async subscribe(channel, handler) {
      if (!listenClient) throw new Error("postgres event bus subscribe requires a listenClient");
      const full = channelOf(channel);
      await listenClient.query(`LISTEN ${full}`);
      const onNotification = (msg) => {
        if (msg.channel === full) {
          try { handler(JSON.parse(msg.payload)); } catch { handler(msg.payload); }
        }
      };
      listenClient.on("notification", onNotification);
      return () => listenClient.removeListener("notification", onNotification);
    },
    close() {
      /* caller owns pool + listenClient lifecycle */
    },
  };
}

export function createEventBus({ driver = "local", pool = null, listenClient = null, prefix } = {}) {
  if (driver === "postgres") return createPostgresEventBus({ pool, listenClient, prefix });
  return createLocalEventBus();
}
