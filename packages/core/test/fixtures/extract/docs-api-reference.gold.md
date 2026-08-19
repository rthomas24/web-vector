# Get rate limit status

`GET /v1/limits`

Returns the caller's current quota, the number of requests remaining in the window and the reset time. The endpoint itself is exempt from rate limiting so that clients can poll it while backing off.

## Query parameters

| Name | Type | Description |
| --- | --- | --- |
| key | string | API key to inspect (defaults to the caller's key) |
| window | string | One of minute, hour or day |

## Response

```json
{
  "limit": 1000,
  "remaining": 942,
  "reset": "2026-04-01T12:00:00Z"
}
```

Remaining counts are eventually consistent across regions and may lag by a few seconds.

## Errors

Servers commonly signal limits with the RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset headers, and answer rejected requests with HTTP status 429 Too Many Requests together with a Retry-After header. Clients that honour Retry-After avoid making the overload worse.
