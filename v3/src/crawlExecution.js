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
  current.assertOwner?.();
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

/**
 * 這一輪是不是已經被取消（預算用盡／被新的一輪取代）？
 *
 * 為什麼需要它：來源的「逐頁 fail-soft」（單頁失敗不丟掉整批）**不可以吞掉整輪取消**——
 * 被取消時要立刻往上丟，否則輪次會在預算用盡後繼續打外部站台。
 * 逐頁 catch 的判斷一律寫成：
 *   `catch (error) { if (isCrawlCancelled()) throw error; …記一筆錯誤、繼續跑… }`
 * （單一請求自己的逾時不算取消：那種情形就是我們要容忍的「這一頁失敗」。）
 */
export function isCrawlCancelled() {
  const current = execution.getStore();
  return Boolean(current?.signal?.aborted);
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
