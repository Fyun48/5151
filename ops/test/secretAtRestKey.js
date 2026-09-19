// 非 Production 的固定測試 key（64 hex = 32 bytes）。僅測試用；Production key 由外部 secret 提供。
if (!process.env.OPS_SECRET_AT_REST_KEY) {
  process.env.OPS_SECRET_AT_REST_KEY = "5ecf8e2a9d41b6f3c7a0e9d2b4f8a1c6".repeat(2);
}
