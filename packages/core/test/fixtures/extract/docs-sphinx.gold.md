# ratelimit — Rate limiting primitives

**Source code:** [ratelimit.py](https://github.com/example/ratelimit/blob/main/ratelimit.py)

Rate limiting protects a service from being overwhelmed by too many requests in a short window. Instead of failing unpredictably under load, a rate-limited service rejects or delays excess requests in a controlled way, and tells the client when it may try again.

## Classes

<dl><dt>*class* TokenBucket(*capacity*, *refill_rate*)</dt>
<dd>

The token bucket algorithm keeps a counter of available tokens that refills at a fixed rate up to a maximum capacity. Each request consumes one token; when the bucket is empty the request is rejected. Because tokens accumulate while the service is idle, the bucket tolerates short bursts without exceeding the long-term average rate.

<dl><dt>try_acquire(*tokens=1*)</dt>
<dd>

Return True and consume tokens if enough are available; otherwise return False without blocking.

</dd></dl></dd>
</dl>

## Example

```python
from ratelimit import TokenBucket

bucket = TokenBucket(capacity=100, refill_rate=10)
if not bucket.try_acquire():
    raise RuntimeError("rate limited")
```

## Choosing an algorithm

A leaky bucket smooths traffic instead of tolerating bursts: requests enter a queue that drains at a constant rate, and requests arriving when the queue is full are dropped. It produces a very even output rate at the cost of added latency for bursty clients.

Choosing an algorithm is mostly a question of what you want to protect: a database that degrades under bursts prefers a leaky bucket, an API that sells quota to customers prefers a token bucket, and a shared cache with limited memory prefers sliding windows.
