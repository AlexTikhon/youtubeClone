# Frontend architecture

The web application uses Next.js App Router for route composition, metadata, and route boundaries,
with small React client islands for server-state queries and interaction. It intentionally does not
add a server-prefetch/dehydration layer: the API uses credentialed session cookies, the same cached
data is mutated frequently, and this project benefits more from one clear TanStack Query owner than
from duplicating browser and server fetch paths.

```text
Next.js route (Server Component)
   |
   +-- static layout, metadata, loading/error boundary
   |
   +-- widget (Client Component only when it owns a query)
        |
        +-- feature: interaction or mutation
        +-- entity: video presentation
        +-- shared: API, query keys, async UI, formatting
```

## Server and client boundaries

Pages and layouts remain Server Components. They normalize route input, export metadata, and compose
widgets without shipping page-shell code to the browser. `AppHeader` is also a Server Component;
only search and session status hydrate. Client boundaries are limited to components that use React
state/effects, browser APIs, event handlers, or TanStack Query. Static `VideoCard`, `VideoGrid`, media
thumbnail, formatting, and async-state presentation remain usable without a client directive.

The audit did not find an unnecessarily client-marked page. Query-backed widgets remain client
components because moving their data to the server would require cookie forwarding plus hydration
and duplicate mutation-cache ownership. Channel details and channel videos start independently, as
do watch metadata, current user, playlist context, and related videos, avoiding dependent browser
waterfalls where the identifiers are already known.

## Server state and API boundary

`shared/query/query-keys.ts` owns deterministic keys by domain: auth, feeds, videos, channels,
search, playlists, history, Studio, and health. Mutations update or invalidate the smallest safe
cache set. A metadata edit invalidates discovery collections that embed that metadata; a like only
updates the video detail cache; retry processing only refreshes Studio.

`apiRequest` always includes credentials and JSON headers. Transport failures become a status-zero
`ApiClientError`; HTTP 401, 403, 404, 409, 429, and 5xx failures map to safe user messages. Backend
details and request IDs remain available to code and logs but are not rendered by default. Queries
offer retry where recovery is useful, and mutation failures are reported next to the affected
action.

## Async UI vocabulary

- Loading: layout-matched `PageSkeleton` or `VideoGridSkeleton`, with a polite status.
- Empty: `EmptyState` with a specific explanation and an action only when useful.
- Error: `InlineError` with safe copy and an optional `Try again` action.
- Mutation pending: disable the initiating control and change its label.
- Mutation result: a nearby alert for failure or a selective live status for success.

The root `loading.tsx`, `error.tsx`, and `not-found.tsx` cover navigation/render failures. Watch and
Studio add layout-specific loading boundaries. Query failures remain local so a related-videos
failure does not discard a playable video.

## Accessibility and responsive behavior

The shell exposes one `main` landmark and a focus-visible skip link. Header navigation, forms,
headings, buttons, dialogs, and status regions use native semantics. Form failures use labels,
`aria-invalid`, descriptions, and alerts where the relationship would otherwise be unclear. Shared
dialogs move focus inside, trap Tab navigation, close on Escape, and restore prior focus. Optimistic
like/subscribe failures announce rollback without announcing ordinary refetches.

Layouts are mobile-first and avoid fixed card widths below the medium breakpoint. Studio rows and
watch actions wrap or stack at narrow widths; authenticated thumbnails reserve a 16:9 box. Optional
transitions and thumbnail scaling are effectively disabled for `prefers-reduced-motion: reduce`.
Representative browser coverage exercises 375 px navigation and keyboard skip/search/watch flows;
the CSS breakpoints are designed for 360, 768, 1024, and 1440 px review.

## Images and media authorization

Thumbnails deliberately use native `img`, with intrinsic dimensions, an aspect-ratio container,
lazy loading, async decoding, and a stable fallback. The media API authorizes PRIVATE and UNLISTED
requests with the browser session and returns `private, no-store` for non-public assets. The Next
Image optimizer fetches remotely on the server and would not automatically forward that browser
session, so routing protected thumbnails through it could break authorization or tempt a security
exception. Native image requests preserve the existing guard and cache policy. PUBLIC media still
receives the API's immutable cache headers.

The watch player uses native HLS when available and dynamically imports `hls.js` only inside the
player lifecycle otherwise. Feed/search/channel users therefore do not download the HLS
implementation. HLS XHR keeps credentials enabled. Fatal network recovery is bounded at two starts;
fatal media recovery is bounded at one attempt. Unsupported, initialization, native media, and
exhausted HLS failures show a retry action. Cleanup removes listeners, destroys HLS, clears `src`,
and reloads the media element.

Progress events update local watch state, but history persistence is limited to twelve-second
intervals and de-duplicates near-identical positions. Pause/end save meaningful changes; page hide
and hidden visibility flush with `keepalive`. Qualified-view behavior remains based on actual
forward playback rather than raw wall time.

## Performance budget

- Keep pages/layouts server-rendered and client islands narrow.
- Reserve thumbnail/player geometry to avoid avoidable layout shift.
- Lazy-load below-the-fold thumbnails; do not proxy protected media through Next Image.
- Keep `hls.js` in a dynamic playback-only chunk.
- Start independent browser queries together and avoid full-app invalidation.
- Persist playback progress at most every 12 seconds during ordinary playback.
- Do not add large state, form, animation, or design-system dependencies without a measured need.

No Lighthouse run or numeric performance score is claimed in this phase. The production build and
bundle output are the verification baseline; real Web Vitals require a deployed production-like
environment and representative media/network conditions.

## Deliberate limits

The project keeps native video controls, local React form state, and TanStack Query rather than
adding a custom control bar, form framework, global client store, or a large UI toolkit. Public video
titles are not server-fetched for dynamic watch metadata because doing that safely for mixed PUBLIC,
UNLISTED, and PRIVATE resources would add a second authenticated fetch path; watch/playlist routes
use generic `noindex` metadata and never expose protected data. Optimistic updates are limited to
like and subscribe, where rollback is local and deterministic. Playlist membership, deletion,
uploads, metadata edits, and processing retries remain pessimistic to avoid multi-cache drift.
