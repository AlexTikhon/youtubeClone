# Decisions

## Modular monolith plus dedicated worker

The API remains one domain-oriented deployment because current scale and team size do not justify
distributed services. Media work runs separately because it has different CPU, memory, timeout, and
retry behavior.

## Direct uploads through signed URLs

Video bytes bypass the API process. The API authorizes an upload intent and later verifies the stored
object. This keeps API memory and bandwidth bounded and maps directly from MinIO to S3 later.

## PostgreSQL session records and HTTP-only cookies

Opaque cookies avoid access tokens in localStorage and allow revocation. A server lookup is accepted
for the clearer security boundary. Redis can cache validated sessions later without changing feature
code.

## Prisma without generic repositories

Prisma is injected into focused application services. Storage and queue get ports because providers
and failure semantics may change; wrapping every database call would only obscure transactions and
queries.

## Separate upload intent and video asset

An intent describes an object that may not exist yet. `VideoAsset` describes a verified original or
generated artifact. Keeping them separate prevents pending uploads from masquerading as durable media.

## PostgreSQL first for discovery

Future initial search and feeds should use PostgreSQL indexes/full-text features. Elasticsearch and a
recommendation platform are deferred until measured requirements justify their operational cost.
