# Rate limits

Rate limiting protects a service from being overwhelmed by too many requests in a short window. Instead of failing unpredictably under load, a rate-limited service rejects or delays excess requests in a controlled way, and tells the client when it may try again.

**note**

Limits apply per API key, not per IP address.

## Token bucket configuration

The token bucket algorithm keeps a counter of available tokens that refills at a fixed rate up to a maximum capacity. Each request consumes one token; when the bucket is empty the request is rejected. Because tokens accumulate while the service is idle, the bucket tolerates short bursts without exceeding the long-term average rate.

```ts
import { RateLimiter } from '@example/sdk';
const limiter = new RateLimiter({ capacity: 100, refillPerSecond: 10 });
if (!limiter.tryAcquire()) { throw new Error('rate limited'); }
```

## Response headers

Servers commonly signal limits with the RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset headers, and answer rejected requests with HTTP status 429 Too Many Requests together with a Retry-After header. Clients that honour Retry-After avoid making the overload worse.

| Header | Meaning |
| --- | --- |
| RateLimit-Limit | Requests allowed per window |
| RateLimit-Remaining | Requests left in the window |
| RateLimit-Reset | Seconds until the window resets |

## Distributed deployments

In a distributed deployment the counters must be shared, otherwise each instance enforces its own limit and the effective limit becomes the sum across instances. A central store introduces a network round trip per request, so many systems combine a local pre-filter with a periodic sync to the shared counter.
