# Rate limiting, explained for busy engineers

Rate limiting protects a service from being overwhelmed by too many requests in a short window. Instead of failing unpredictably under load, a rate-limited service rejects or delays excess requests in a controlled way, and tells the client when it may try again.

The token bucket algorithm keeps a counter of available tokens that refills at a fixed rate up to a maximum capacity. Each request consumes one token; when the bucket is empty the request is rejected. Because tokens accumulate while the service is idle, the bucket tolerates short bursts without exceeding the long-term average rate.

A leaky bucket smooths traffic instead of tolerating bursts: requests enter a queue that drains at a constant rate, and requests arriving when the queue is full are dropped. It produces a very even output rate at the cost of added latency for bursty clients.

## Sliding windows

Sliding window counters approximate a true rolling window by weighting the previous fixed window by how much of it still overlaps the current one. They need only two counters per client, which makes them cheap to store in a shared cache such as Redis.

> Tell the client when it may try again; guessing makes overload worse.

## Signalling limits to clients

Servers commonly signal limits with the RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset headers, and answer rejected requests with HTTP status 429 Too Many Requests together with a Retry-After header. Clients that honour Retry-After avoid making the overload worse.

In a distributed deployment the counters must be shared, otherwise each instance enforces its own limit and the effective limit becomes the sum across instances. A central store introduces a network round trip per request, so many systems combine a local pre-filter with a periodic sync to the shared counter.

Choosing an algorithm is mostly a question of what you want to protect: a database that degrades under bursts prefers a leaky bucket, an API that sells quota to customers prefers a token bucket, and a shared cache with limited memory prefers sliding windows.
