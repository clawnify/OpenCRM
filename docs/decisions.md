# Decisions

## Distinguish discovery failures from disconnected services

`@clawnify/connections` 0.5.1 suppresses discovery errors: `describe()` catches
RPC failures and the HTTP binding returns an empty list on non-success responses.
The existing integrations wrapper therefore calls the same discovery contract
directly, preserving the binding-first choice, default broker URL, token headers,
and optional organization header for HTTP service tokens. Provider actions still
use the SDK's `connect()`. This workaround can be removed when the SDK offers
discovery that preserves failures.

A failed check returns HTTP 503 and the UI offers Retry while disabling provider
actions. Successful empty discovery, including local development with no broker
configuration, remains disconnected. Partial configuration and malformed replies
are errors. Raw upstream error bodies are not exposed to users.
