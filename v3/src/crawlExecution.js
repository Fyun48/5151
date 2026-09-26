import { AsyncLocalStorage } from "node:async_hooks";

const execution = new AsyncLocalStorage();

export function withCrawlExecution(context, work) {
  return execution.run(context, work);
}

export function currentCrawlExecution() {
  return execution.getStore();
}

export function throwIfCrawlCancelled() {
  const current = execution.getStore();
  if (!current) return;
  // Check the clock as well: a long synchronous segment can delay the timer.
  if (Date.now() >= current.deadline && !current.signal.aborted) {
    current.controller.abort(current.timeoutError);
  }
  current.signal.throwIfAborted();
}

export function crawlRequestSignal(requestSignal) {
  throwIfCrawlCancelled();
  const current = execution.getStore();
  return current ? AbortSignal.any([current.signal, requestSignal]) : requestSignal;
}

// Rollback remains possible after cancellation. COMMIT/END never bypass guards.
export function isCrawlRollback(sql) {
  return /^\s*ROLLBACK(?:\s+TRANSACTION|\s+TO(?:\s+SAVEPOINT)?\s+[a-z_][a-z_0-9]*)?\s*;?\s*$/i.test(String(sql));
}

export function guardCrawlSqlite(database) {
  const methods = new Map();
  return new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (methods.get(property)?.original === value) return methods.get(property).wrapped;
      const wrapped = (...args) => {
        const rollback = (property === "exec" || property === "prepare") && isCrawlRollback(args[0]);
        if (property !== "close" && !rollback) throwIfCrawlCancelled();
        const result = value.apply(target, args);
        if (property !== "prepare") return result;
        // Statements obtained before a timeout must not be usable after it.
        return new Proxy(result, {
          get(statement, key) {
            const member = Reflect.get(statement, key, statement);
            if (typeof member !== "function") return member;
            return (...parameters) => {
              if (!rollback) throwIfCrawlCancelled();
              const result = member.apply(statement, parameters);
              if (key !== "iterate") return result;
              return {
                [Symbol.iterator]() { return this; },
                next(...args) {
                  if (!rollback) throwIfCrawlCancelled();
                  return result.next(...args);
                },
                return(...args) { return result.return ? result.return(...args) : { done: true }; },
              };
            };
          },
        });
      };
      methods.set(property, { original: value, wrapped });
      return wrapped;
    },
  });
}
