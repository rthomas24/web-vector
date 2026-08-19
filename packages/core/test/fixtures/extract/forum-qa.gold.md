# How does a token bucket handle bursts?

I am implementing throttling for an internal API and cannot decide between a token bucket and a fixed window counter. The docs I read say the bucket "tolerates bursts", but I do not understand how a burst is different from simply exceeding the limit. Could someone explain with numbers?

## 3 Answers

The difference is what the limit is measured against. The token bucket algorithm keeps a counter of available tokens that refills at a fixed rate up to a maximum capacity. Each request consumes one token; when the bucket is empty the request is rejected. Because tokens accumulate while the service is idle, the bucket tolerates short bursts without exceeding the long-term average rate. With capacity 100 and refill 10 per second, a client that was idle for ten seconds may send 100 requests at once and only then is it held to 10 per second.

```
capacity = 100
refill   = 10 / s
idle 10s  -> 100 tokens available -> burst of 100 allowed
after     -> 10 requests per second sustained
```

Thanks, the worked example with capacity 100 made it click.

Worth adding that many CDNs expose exactly these two knobs as burst and rate.

A leaky bucket smooths traffic instead of tolerating bursts: requests enter a queue that drains at a constant rate, and requests arriving when the queue is full are dropped. It produces a very even output rate at the cost of added latency for bursty clients. So if you want smoothing rather than tolerance, pick the leaky bucket; if you want to sell a monthly quota with occasional spikes, pick the token bucket.

One practical note: In a distributed deployment the counters must be shared, otherwise each instance enforces its own limit and the effective limit becomes the sum across instances. A central store introduces a network round trip per request, so many systems combine a local pre-filter with a periodic sync to the shared counter.
