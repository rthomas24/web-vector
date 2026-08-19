# Adaptive Token Buckets for Multi-Tenant APIs

Nadia Okafor, Tomasz Wiśniewski

## Abstract

We study rate limiting for multi-tenant APIs where tenants have heterogeneous burst profiles. We propose an adaptive token bucket whose refill rate is adjusted from observed demand and show that it reduces spurious rejections by 37% on production traces without increasing p99 latency.

## 1 Introduction

Rate limiting protects a service from being overwhelmed by too many requests in a short window. Instead of failing unpredictably under load, a rate-limited service rejects or delays excess requests in a controlled way, and tells the client when it may try again.

The token bucket algorithm keeps a counter of available tokens that refills at a fixed rate up to a maximum capacity. Each request consumes one token; when the bucket is empty the request is rejected. Because tokens accumulate while the service is idle, the bucket tolerates short bursts without exceeding the long-term average rate.

## 2 Method

Let r denote the refill rate at time t. We update it as r where d is the smoothed demand and η the learning rate.

In a distributed deployment the counters must be shared, otherwise each instance enforces its own limit and the effective limit becomes the sum across instances. A central store introduces a network round trip per request, so many systems combine a local pre-filter with a periodic sync to the shared counter.

## 3 Results

| Policy | Rejections | p99 latency (ms) |
| --- | --- | --- |
| Fixed bucket | 4.1% | 212 |
| Adaptive bucket | 2.6% | 209 |

## References

1. R. Fielding et al. Hypertext Transfer Protocol (HTTP/1.1): Semantics and Content. RFC 7231, 2014.
2. M. Nottingham. RateLimit header fields for HTTP. Internet-Draft, 2024.
