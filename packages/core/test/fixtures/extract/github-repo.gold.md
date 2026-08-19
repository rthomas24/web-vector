# limiter

A tiny, dependency-free rate limiter for Node.js and browsers.

## Install

```sh
npm install @acme/limiter
```

## Usage

```js
import { tokenBucket } from '@acme/limiter';
const take = tokenBucket({ capacity: 20, refillPerSecond: 5 });
if (take()) sendRequest();
```

## How it works

The token bucket algorithm keeps a counter of available tokens that refills at a fixed rate up to a maximum capacity. Each request consumes one token; when the bucket is empty the request is rejected. Because tokens accumulate while the service is idle, the bucket tolerates short bursts without exceeding the long-term average rate.

Sliding window counters approximate a true rolling window by weighting the previous fixed window by how much of it still overlaps the current one. They need only two counters per client, which makes them cheap to store in a shared cache such as Redis.

## License

MIT
