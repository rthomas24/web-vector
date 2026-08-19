# A token bucket in twenty lines of Go

The token bucket algorithm keeps a counter of available tokens that refills at a fixed rate up to a maximum capacity. Each request consumes one token; when the bucket is empty the request is rejected. Because tokens accumulate while the service is idle, the bucket tolerates short bursts without exceeding the long-term average rate.

```go
package limiter

type Bucket struct {
    capacity float64
    tokens   float64
    refill   float64
}

func (b *Bucket) Take() bool {
    b.tokens = min(b.capacity, b.tokens+b.refill*elapsed())
    if b.tokens < 1 { return false }
    b.tokens--
    return true
}
```

Run the burst test to see the idle credit being spent:

```sh
$ go test ./... -run TestBurst
ok      example.dev/limiter   0.012s
```

Choosing an algorithm is mostly a question of what you want to protect: a database that degrades under bursts prefers a leaky bucket, an API that sells quota to customers prefers a token bucket, and a shared cache with limited memory prefers sliding windows.
