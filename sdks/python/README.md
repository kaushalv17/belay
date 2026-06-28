# Quorvel Python SDK (skeleton)

Phase 5 starting point. Mirrors the TS SDK's core surface.

```bash
pip install quorvel   # once published
```

```python
from quorvel import Quorvel

qrv = Quorvel(api_key="qrv_live_...")
qrv.track(idempotency_key="order-123", tool="refund.issue", args={"amount": 5000})
print(qrv.usage())
```

## TODO toward parity
- Retries with backoff + `Idempotency-Key` header
- Typed events / models
- Async client (httpx.AsyncClient)
- Parity test suite against the TS SDK
