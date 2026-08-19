```
Internet Engineering Task Force (IETF)                    N. Okafor, Ed.
Request for Comments: 9999                                Example Labs
Category: Standards Track                                    April 2026
ISSN: 2070-1721

              The RateLimit Header Fields for HTTP

Abstract

   This document defines the RateLimit-Limit, RateLimit-Remaining and
   RateLimit-Reset header fields for HTTP, allowing servers to publish
   current service limits and clients to shape their request policy
   accordingly.

1.  Introduction

   Rate limiting is a common technique for protecting services. Servers
   have historically used a variety of non-standard fields such as
   X-RateLimit-Limit; this document defines standard fields with well
   defined semantics.

2.  Header Field Definitions

2.1.  RateLimit-Limit

   The RateLimit-Limit field indicates the maximum number of requests
   the server is willing to accept from the client in the current
   window.

     RateLimit-Limit: 100

Okafor                       Standards Track                    [Page 1]
```

```
RFC 9999                RateLimit Header Fields               April 2026

2.2.  RateLimit-Remaining

   The RateLimit-Remaining field indicates the number of requests
   remaining in the current window. It MUST NOT be greater than
   RateLimit-Limit.

2.3.  RateLimit-Reset

   The RateLimit-Reset field indicates the number of seconds until the
   window resets. Clients SHOULD wait at least this long before
   retrying after a 429 response.

3.  Security Considerations

   Publishing limits reveals capacity information that an attacker could
   use to plan a denial of service; servers MAY publish reduced values.

Okafor                       Standards Track                    [Page 2]
```
