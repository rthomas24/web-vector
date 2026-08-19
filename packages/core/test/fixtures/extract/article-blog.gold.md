# An HTTP caching primer

HTTP caching lets a response be reused for later requests instead of being generated again. Reuse is governed by freshness: a stored response is fresh until its age exceeds the lifetime the origin granted, and after that it must be revalidated before use.

The max-age directive of Cache-Control gives the freshness lifetime in seconds relative to the time the response was generated. It takes precedence over the Expires header when both are present, and a shared cache honours s-maxage over max-age.

## Revalidation

Revalidation sends a conditional request carrying the validator of the stored response, either an entity tag in If-None-Match or a date in If-Modified-Since. A 304 Not Modified answer refreshes the stored response without transferring the body again.

When a response has neither an explicit lifetime nor a validator, caches may assign a heuristic freshness lifetime, typically ten percent of the time since Last-Modified. Explicit directives are always preferable because heuristics vary between implementations.

## Vary

The Vary header lists the request headers that selected this representation. A cache must not reuse the stored response for a request whose listed header values differ, which is how content negotiation on Accept-Encoding or Accept-Language stays correct.

That is all there is to it: grant a lifetime, ship a validator, and list what you varied on.
