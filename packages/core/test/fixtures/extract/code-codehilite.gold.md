# Retries with exponential backoff

Retrying too eagerly turns a brief outage into a thundering herd, so each attempt should wait longer than the last and add jitter so that clients do not synchronise.

```python
import time

def retry(fn, attempts=5, base=0.2):
    for i in range(attempts):
        try:
            return fn()
        except TransientError:
            time.sleep(base * 2 ** i)
    raise GaveUp()
```

The same idea in a shell one-liner:

```bash
for i in 1 2 3 4 5; do curl -fsS https://api.example.io/ && break; sleep $((RANDOM % (2 ** i))); done
```

Combine retries with a rate limiter on the client so a retry storm cannot exceed the quota.
