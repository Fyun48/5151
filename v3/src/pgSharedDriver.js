// One process-wide PostgreSQL pool, shared by the list path and the write path.
//
// Both paths used to resolve their own driver; sharing the pool keeps the connection count
// predictable and makes the DB_DRIVER=postgres wiring a single import.
let shared = null;
let pending = null;

export async function sharedPgDriver() {
  if (shared) return shared;
  if (!pending) {
    pending = import("./dbDriverPostgres.js")
      .then(({ createPostgresDriver }) => createPostgresDriver({}))
      .then((driver) => {
        shared = driver;
        return driver;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

export async function closeSharedPgDriver() {
  if (!shared) return;
  const driver = shared;
  shared = null;
  await driver.close();
}
