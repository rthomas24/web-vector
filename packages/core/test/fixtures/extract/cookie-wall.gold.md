# Why your CDN keeps serving stale pages

HTTP caching lets a response be reused for later requests instead of being generated again. Reuse is governed by freshness: a stored response is fresh until its age exceeds the lifetime the origin granted, and after that it must be revalidated before use.

The max-age directive of Cache-Control gives the freshness lifetime in seconds relative to the time the response was generated. It takes precedence over the Expires header when both are present, and a shared cache honours s-maxage over max-age.

Revalidation sends a conditional request carrying the validator of the stored response, either an entity tag in If-None-Match or a date in If-Modified-Since. A 304 Not Modified answer refreshes the stored response without transferring the body again.

The Vary header lists the request headers that selected this representation. A cache must not reuse the stored response for a request whose listed header values differ, which is how content negotiation on Accept-Encoding or Accept-Language stays correct.
