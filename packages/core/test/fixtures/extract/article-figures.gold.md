# How we shed load without dropping customers

Last quarter our ingestion tier saw a 6× spike in traffic when a partner replayed a week of events in an hour. This post explains the three mechanisms that kept the service up: [priority queues](https://eng.example.com/blog/2025/priority-queues), adaptive concurrency limits and a token bucket per tenant.

![Request rate spike graph](https://eng.example.com/img/spike.png)*Figure 1: request rate during the replay.*

## Adaptive concurrency

Instead of a static connection limit we measure the gradient of latency against in-flight requests and shrink the limit when latency climbs faster than throughput. The estimator is a simplified version of the one described in [the gradient paper](https://example.com/papers/gradient).

## Per-tenant buckets

The token bucket algorithm keeps a counter of available tokens that refills at a fixed rate up to a maximum capacity. Each request consumes one token; when the bucket is empty the request is rejected. Because tokens accumulate while the service is idle, the bucket tolerates short bursts without exceeding the long-term average rate.

In a distributed deployment the counters must be shared, otherwise each instance enforces its own limit and the effective limit becomes the sum across instances. A central store introduces a network round trip per request, so many systems combine a local pre-filter with a periodic sync to the shared counter.

## What we would do differently

- Turn on the per-tenant limits before the incident rather than during it.
- Alert on bucket exhaustion per tenant, not just on global error rate.
- Document the Retry-After behaviour in the partner API guide.
