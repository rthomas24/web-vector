# Limiter

Stability: 2 - Stable

The `node:limiter` module provides token bucket and leaky bucket primitives for shaping outbound traffic.

## Class: TokenBucket

Added in: v24.3.0

### new TokenBucket(options)

- `options` {Object}
  - `capacity` {number} Maximum tokens. **Default:** `100`.
  - `refillPerSecond` {number} Tokens added per second. **Default:** `10`.

### bucket.tryAcquire(\[tokens])

- `tokens` {number} **Default:** `1`
- Returns: {boolean}

Consumes `tokens` if available and returns `true`; otherwise returns `false` immediately.

```js
const { TokenBucket } = require('node:limiter');
const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 });
console.log(bucket.tryAcquire()); // true
```

## Class: LeakyBucket

A leaky bucket smooths traffic instead of tolerating bursts: requests enter a queue that drains at a constant rate, and requests arriving when the queue is full are dropped. It produces a very even output rate at the cost of added latency for bursty clients.
