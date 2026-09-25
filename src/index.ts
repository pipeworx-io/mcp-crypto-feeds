interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


/**
 * One place for the 23 `*-feeds` packs to fetch a feed — and, when that fails,
 * to say WHAT HAPPENED without saying WHY.
 *
 * The line this replaces was copy-pasted into all 23 packs:
 *
 *     throw new Error(`Feed unreachable: ${url} (blocked directly and via proxy). ` +
 *                     `The source may block datacenter egress.`);
 *
 * It was thrown for ANY unreachable feed, including a plain 404 on a URL that
 * had simply moved. The code knows the fetch failed; it does not know why, and
 * it stated a why anyway — and that assertion was believed. On 2026-09-16 a
 * careful audit bucketed fourteen packs as "upstream blocks Cloudflare egress"
 * on the strength of this sentence; re-fetching the same upstreams from a
 * residential connection showed **six of the fourteen were not blocked at all**
 * — all 12 of their committed feed URLs were simply dead. Had that bucket been
 * dropped from the health denominator as proposed, six working packs would have
 * been hidden behind a better number (fleet #2074, #2105).
 *
 * So this module reports only what the code observed — status, final URL after
 * redirects, content-type, and what the proxy attempt did — and explicitly
 * declines to name a cause. A 404 and a 403-from-a-datacenter-range are
 * different worlds, and the caller can now tell them apart. The diagnosis
 * belongs to whoever reads the facts; asserting it here is what made the wrong
 * bucket look well-evidenced.
 */


/** Default rss2json endpoint the feeds packs fall back to. */
const FEED_PROXY_URL = 'https://api.rss2json.com/v1/api.json';

/** Longest upstream/proxy explanation we will quote back inside an error. */
const MAX_DETAIL$feeds = 160;

/** An item as rss2json returns it. The packs map this into their own shape. */
interface ProxyFeedItem {
  title?: string;
  link?: string;
  pubDate?: string;
  description?: string;
  author?: string;
  categories?: string[];
  guid?: string;
}

/**
 * What one fetch attempt actually did. Every field here is READ OFF the
 * response — nothing is inferred. `outcome` is a short factual phrase, never a
 * diagnosis.
 */
interface FeedAttempt {
  stage: 'direct' | 'proxy';
  /** The URL we asked for. */
  url: string;
  /** `res.url` — where the request actually landed after redirects. */
  finalUrl?: string;
  status?: number;
  contentType?: string;
  /** e.g. `HTTP 404`, `request failed before a response`, `no <item>/<entry> elements`. */
  outcome: string;
}

/** Raised when neither the direct fetch nor the proxy produced a feed. */
class FeedUnreachableError extends Error {
  readonly attempts: FeedAttempt[];
  constructor(url: string, attempts: FeedAttempt[]) {
    super(feedUnreachableMessage(url, attempts));
    this.name = 'FeedUnreachableError';
    this.attempts = attempts;
  }
}

/** Render one attempt as a clause of observed fact. */
function describeFeedAttempt(a: FeedAttempt): string {
  const label = a.stage === 'direct' ? 'direct GET' : `proxy GET (${hostOf(a.url)})`;
  const parts = [a.outcome];
  if (a.finalUrl && a.finalUrl !== a.url) parts.push(`final URL after redirects ${a.finalUrl}`);
  else if (a.finalUrl) parts.push(`final URL ${a.finalUrl}`);
  if (a.contentType) parts.push(`content-type ${a.contentType}`);
  return `${label}: ${parts.join(', ')}`;
}

/**
 * The full message. Facts, then an explicit refusal to diagnose — the second
 * half matters as much as the first, because the previous wording was read as
 * evidence of a cause by exactly the kind of careful reader it misled.
 */
function feedUnreachableMessage(url: string, attempts: FeedAttempt[]): string {
  const observed = attempts.map(describeFeedAttempt).join('. ');
  return (
    `Feed unreachable: ${url} — ${observed}. ` +
    'Those are the observed facts; the cause is not established here. ' +
    'To tell a moved/removed endpoint from an address-range block, re-fetch the same URL from a non-datacenter connection.'
  );
}

type FeedSource = { via: 'direct'; xml: string } | { via: 'proxy'; items: ProxyFeedItem[] };

interface FetchFeedOptions {
  /** Short upstream label for timeout errors, e.g. 'AI Feeds'. */
  label: string;
  userAgent: string;
  /** Override the rss2json endpoint (tests, or a different proxy). */
  proxyUrl?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the timeout-bounded shared fetch. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Fetch a feed directly, fall back to the rss2json proxy, and on total failure
 * throw a {@link FeedUnreachableError} carrying both attempts.
 *
 * Returns the RAW direct XML (the caller parses it — each pack owns its parser)
 * or the proxy's already-structured items.
 */
async function fetchFeedSource(url: string, opts: FetchFeedOptions): Promise<FeedSource> {
  const doFetch =
    opts.fetchImpl ??
    ((u: string, init: RequestInit) => fetchWithTimeout(u, init, opts.label, opts.timeoutMs));
  const attempts: FeedAttempt[] = [];

  try {
    const res = await doFetch(url, {
      headers: {
        'User-Agent': opts.userAgent,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    const contentType = res.headers.get('content-type') ?? undefined;
    if (res.ok) {
      const xml = await res.text();
      if (/<(item|entry)[\s>]/i.test(xml)) return { via: 'direct', xml };
      // A 200 that carries no feed items is a fact worth reporting: the old
      // code swallowed it and blamed egress. Bot walls and parked domains
      // answer 200 with HTML, and every status-code health check reads that as
      // fine (same shape as parseJson's HTML branch in http.ts).
      attempts.push({
        stage: 'direct',
        url,
        finalUrl: res.url || undefined,
        status: res.status,
        contentType,
        outcome: `HTTP ${res.status} but the body has no <item>/<entry> elements (${xml.length} bytes)`,
      });
    } else {
      attempts.push({
        stage: 'direct',
        url,
        finalUrl: res.url || undefined,
        status: res.status,
        contentType,
        outcome: `HTTP ${res.status}`,
      });
    }
  } catch (err) {
    attempts.push({
      stage: 'direct',
      url,
      outcome: `request failed before a response (${short(err)})`,
    });
  }

  // Deliberately NO `count` param: rss2json moved it behind a paid key and now
  // answers 422 {"message":"To use this parameter `count` you need a valid api
  // key"} whenever it is present. That silently killed the proxy fallback in all
  // 23 feeds packs -- i.e. exactly the egress-blocked case the fallback exists
  // to cover, which is why it looked like the upstreams were blocking us. Cap
  // client-side instead.
  const proxyBase = opts.proxyUrl ?? FEED_PROXY_URL;
  const proxyUrl = `${proxyBase}?rss_url=${encodeURIComponent(url)}`;
  try {
    const pres = await doFetch(proxyUrl, {
      headers: { 'User-Agent': opts.userAgent, Accept: 'application/json' },
    });
    const body = (await pres.json().catch(() => ({}))) as {
      status?: string;
      message?: string;
      items?: ProxyFeedItem[];
    };
    if (body.status === 'ok' && Array.isArray(body.items)) return { via: 'proxy', items: body.items };
    const said = [
      body.status ? `rss2json status ${JSON.stringify(body.status)}` : 'no rss2json status field',
      body.message ? `message ${JSON.stringify(truncate(body.message))}` : '',
      body.status === 'ok' ? 'no items array' : '',
    ].filter(Boolean);
    attempts.push({
      stage: 'proxy',
      url: proxyBase,
      status: pres.status,
      contentType: pres.headers.get('content-type') ?? undefined,
      outcome: `HTTP ${pres.status}, ${said.join(', ')}`,
    });
  } catch (err) {
    attempts.push({
      stage: 'proxy',
      url: proxyBase,
      outcome: `request failed before a response (${short(err)})`,
    });
  }

  throw new FeedUnreachableError(url, attempts);
}

function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function truncate(s: string): string {
  return s.length > MAX_DETAIL$feeds ? `${s.slice(0, MAX_DETAIL$feeds)}…` : s;
}

function short(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return truncate(msg.replace(/\s+/g, ' ').trim()) || 'no error message';
}
/**
 * Crypto Feeds MCP.
 *
 * Crypto — cryptocurrency, blockchain and DeFi news.
 * CF-robust RSS / Atom / RDF reader over a curated, edge-verified registry; on a
 * Cloudflare egress block it falls back to the rss2json proxy. (Generated by
 * scripts/gen-feeds-packs.mjs from scripts/feeds-registry.mjs — do not hand-edit.)
 */


const PACK_LABEL = 'Crypto Feeds';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PROXY = 'https://api.rss2json.com/v1/api.json';
const MAX_ITEMS = 50;

interface FeedDef { title: string; url: string; category: string; source: string; description: string }

const FEEDS: Record<string, FeedDef> = {
  coindesk: { title: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", category: "crypto", source: "coindesk.com", description: "Cryptocurrency & blockchain news" },
  cointelegraph: { title: "Cointelegraph", url: "https://cointelegraph.com/rss", category: "crypto", source: "cointelegraph.com", description: "Crypto news & analysis" },
  decrypt: { title: "Decrypt", url: "https://decrypt.co/feed", category: "crypto", source: "decrypt.co", description: "Crypto & web3 news" },
  'the-block': { title: "The Block", url: "https://www.theblock.co/rss.xml", category: "crypto", source: "theblock.co", description: "Crypto markets & industry news" },
  blockworks: { title: "Blockworks", url: "https://blockworks.co/feed", category: "crypto", source: "blockworks.co", description: "Crypto & digital-assets news" },
  'bitcoin-magazine': { title: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/feed", category: "crypto", source: "bitcoinmagazine.com", description: "Bitcoin news & analysis" },
  dlnews: { title: "DL News", url: "https://www.dlnews.com/arc/outboundfeeds/rss/", category: "crypto", source: "dlnews.com", description: "Crypto & DeFi news" },
  'the-defiant': { title: "The Defiant", url: "https://thedefiant.io/feed", category: "crypto", source: "thedefiant.io", description: "DeFi & crypto news" },
  cryptoslate: { title: "CryptoSlate", url: "https://cryptoslate.com/feed/", category: "crypto", source: "cryptoslate.com", description: "Crypto news & data" },
  protos: { title: "Protos", url: "https://protos.com/feed/", category: "crypto", source: "protos.com", description: "Crypto investigative news" },
};

const tools: McpToolExport['tools'] = [
  {
    name: 'list_feeds',
    description: 'List the curated crypto feeds (id, title, category, source). Optionally filter by category (crypto) or keyword. Pass an id to read_feed.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by category: crypto.' },
        query: { type: 'string', description: 'Keyword to match in feed title/source/description.' },
      },
    },
  },
  {
    name: 'read_feed',
    description: 'Read a curated crypto feed by its id (from list_feeds). Returns normalized items (title, link, published, summary). Optionally filter items by keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        feed: { type: 'string', description: 'Curated feed id (from list_feeds).' },
        query: { type: 'string', description: 'Keyword filter over item title/summary.' },
        limit: { type: 'number', description: 'Max items (1-50, default 20).' },
      },
      required: ['feed'],
    },
  },
  {
    name: 'fetch_feed',
    description: 'Fetch and normalize any RSS / Atom / RDF feed by URL. CF-robust: fetches directly and falls back to a proxy if the source blocks the gateway. Use list_feeds first for curated sources.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Feed URL, e.g. "https://news.ycombinator.com/rss".' },
        query: { type: 'string', description: 'Keyword filter over item title/summary.' },
        limit: { type: 'number', description: 'Max items (1-50, default 20).' },
      },
      required: ['url'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_feeds':
      return listFeeds(args);
    case 'read_feed': {
      const id = String(args.feed ?? '').trim();
      const def = FEEDS[id];
      if (!def) throw new Error(`Unknown feed "${args.feed}". Use list_feeds to see valid ids.`);
      return readFeed(def.url, args, { id, ...def });
    }
    case 'fetch_feed': {
      const url = String(args.url ?? '').trim();
      // `user_error:` prefix is the gateway's pack-side classification escape
      // hatch (see classifyToolError). Without it an omitted `url` logged as
      // class `error` -- i.e. OUR bug -- and that was 8 of the 9 recorded
      // failures on us-news-feeds:fetch_feed, inflating the one metric that is
      // supposed to isolate defects we can actually fix. Also name the sibling
      // tool, since a caller who omits `url` usually wanted the curated registry.
      if (!/^https?:\/\//i.test(url)) throw new Error('user_error: Pass a valid feed `url` (http/https), or call `list_feeds` then `read_feed` to use this pack\'s curated sources.');
      return readFeed(url, args);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function listFeeds(args: Record<string, unknown>): unknown {
  const cat = typeof args.category === 'string' ? args.category.trim().toLowerCase() : '';
  const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const feeds = Object.entries(FEEDS)
    .filter(([, d]) => (!cat || d.category === cat) && (!q || `${d.title} ${d.source} ${d.description}`.toLowerCase().includes(q)))
    .map(([id, d]) => ({ id, title: d.title, category: d.category, source: d.source, description: d.description }));
  return { categories: [...new Set(Object.values(FEEDS).map((d) => d.category))].sort(), count: feeds.length, feeds };
}

async function readFeed(url: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<unknown> {
  const limit = clamp(numArg(args.limit, 20), 1, MAX_ITEMS);
  const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const { items, via } = await getFeed(url);
  let out = items;
  if (q) out = out.filter((i) => `${i.title} ${i.summary}`.toLowerCase().includes(q));
  return {
    feed: meta ? { id: meta.id, title: meta.title, source: meta.source } : { url },
    via,
    total_matching: out.length,
    count: Math.min(out.length, limit),
    items: out.slice(0, limit),
  };
}

interface FeedItem { title: string; link: string; published?: string; summary?: string; author?: string; categories?: string[]; id?: string }

async function getFeed(url: string): Promise<{ items: FeedItem[]; via: string }> {
  // Direct fetch, rss2json fallback, and — when both fail — an error that
  // reports only what was OBSERVED (status, final URL, content-type, what the
  // proxy said). It used to name a datacenter-egress block as the CAUSE of any
  // failure, including a plain 404, and that guess was believed: six working
  // packs were filed as egress-blocked on the strength of it (fleet #2105).
  const src = await fetchFeedSource(url, { label: PACK_LABEL, userAgent: UA, proxyUrl: PROXY });
  if (src.via === 'direct') return { items: parseFeed(src.xml), via: 'direct' };
  return {
    items: src.items.slice(0, MAX_ITEMS).map((i) => ({
      title: clean(i.title), link: i.link || '', published: i.pubDate || undefined,
      summary: clean(i.description)?.slice(0, 500) || undefined, author: i.author || undefined,
      categories: Array.isArray(i.categories) ? i.categories : undefined, id: i.guid || i.link,
    })),
    via: 'proxy',
  };
}

function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  for (const b of blocks) {
    const link = extractLink(b);
    out.push({
      title: clean(tag(b, 'title')),
      link,
      published: tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date') || undefined,
      summary: clean(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content'))?.slice(0, 500) || undefined,
      author: clean(tag(b, 'dc:creator') || authorName(b)) || undefined,
      categories: cats(b),
      id: tag(b, 'guid') || tag(b, 'id') || link,
    });
  }
  return out;
}

function extractLink(b: string): string {
  const rss = b.match(/<link>([\s\S]*?)<\/link>/i);
  if (rss && rss[1].trim()) return clean(rss[1]);
  const alt = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || b.match(/<link[^>]*href=["']([^"']+)["']/i);
  return alt ? alt[1].trim() : '';
}
function authorName(b: string): string {
  const a = b.match(/<author>([\s\S]*?)<\/author>/i);
  if (!a) return '';
  const name = a[1].match(/<name>([\s\S]*?)<\/name>/i);
  return name ? name[1] : a[1];
}
function cats(b: string): string[] | undefined {
  const list: string[] = [];
  for (const m of b.matchAll(/<category[^>]*?(?:term=["']([^"']+)["'][^>]*)?>([\s\S]*?)<\/category>/gi)) {
    const v = clean(m[1] || m[2]);
    if (v) list.push(v);
  }
  for (const m of b.matchAll(/<category[^>]*term=["']([^"']+)["'][^>]*\/>/gi)) list.push(m[1]);
  return list.length ? [...new Set(list)].slice(0, 10) : undefined;
}
function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name.replace(':', '\\:')}[^>]*>([\\s\\S]*?)<\\/${name.replace(':', '\\:')}>`, 'i'));
  return m ? unwrap(m[1]) : '';
}
function unwrap(s: string): string {
  const m = s.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (m ? m[1] : s).trim();
}
function clean(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
function numArg(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
