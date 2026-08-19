# Rate limiter implementations compared

The table below lists common implementations, the algorithm each uses and whether it can share state across instances.

Rate limiter implementations compared

| Implementation | Algorithm | Distributed | Main knob |
| --- | --- | --- | --- |
| nginx limit\_req | leaky bucket | yes | zone size |
| Envoy local ratelimit | token bucket | yes | tokens\_per\_fill |
| Cloudflare Rate Limiting | sliding window | no | period |
| Redis cell | GCRA | yes | burst |
| Kong rate-limiting | fixed window | yes | policy |
| Traefik RateLimit | token bucket | yes | burst |
| Spring Bucket4j | token bucket | yes | bandwidth |
| Guava RateLimiter | smooth bursty | no | permitsPerSecond |

Column "Main knob" names the option you will tune first.
