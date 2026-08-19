# A leaky bucket that leaked too little

A leaky bucket smooths traffic instead of tolerating bursts: requests enter a queue that drains at a constant rate, and requests arriving when the queue is full are dropped. It produces a very even output rate at the cost of added latency for bursty clients.

Servers commonly signal limits with the RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset headers, and answer rejected requests with HTTP status 429 Too Many Requests together with a Retry-After header. Clients that honour Retry-After avoid making the overload worse.

The fix was a one-line change to the drain rate, deployed the same afternoon.
