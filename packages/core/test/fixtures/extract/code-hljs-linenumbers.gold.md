# Sliding window rate limiter in Redis

Sliding window counters approximate a true rolling window by weighting the previous fixed window by how much of it still overlaps the current one. They need only two counters per client, which makes them cheap to store in a shared cache such as Redis.

```lua
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count < tonumber(ARGV[3]) then
  redis.call('ZADD', key, now, now)
  return 1
end
return 0
```

In a distributed deployment the counters must be shared, otherwise each instance enforces its own limit and the effective limit becomes the sum across instances. A central store introduces a network round trip per request, so many systems combine a local pre-filter with a periodic sync to the shared counter.
