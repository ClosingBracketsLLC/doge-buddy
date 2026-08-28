import { writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGmailAuth } from '../src/auth.ts'
import { createGmailClient } from '../src/client.ts'

/**
 * GMAIL_CONTRACT=1 fixture re-recorder.
 *
 * Records real Gmail API request/response pairs against the live support mailbox and rewrites
 * packages/gmail/test/fixtures/*.json in place, in the exact
 * `{ request: { method, path, query }, response: { status, body } }` shape the contract suite
 * (packages/gmail/test/client.test.ts) already reads — the output is a drop-in replacement, not a
 * new format.
 *
 * Usage (from repo root):
 *   GMAIL_CONTRACT=1 env $(grep -v '^#' apps/ops/.env | xargs) \
 *     pnpm --filter @doge-buddy/gmail exec tsx scripts/record-fixtures.ts
 *
 * Required env vars (read directly from process.env — apps/ops's loadDotEnv helper isn't
 * reachable from this package, hence the `env $(...)` invocation above pulling values out of
 * apps/ops/.env): GMAIL_SERVICE_ACCOUNT_EMAIL, GMAIL_SERVICE_ACCOUNT_KEY, GMAIL_IMPERSONATE,
 * SUPPORT_ADDRESS. GMAIL_SERVICE_ACCOUNT_KEY's literal `\n` sequences are unescaped the same way
 * apps/ops/src/config.ts does for the live server.
 *
 * Before running: seed at least two owner test messages in the support inbox — one plain
 * single-part message and one multipart message (e.g. with an HTML alternative or an attachment)
 * — so the nested-multipart / single-part fixture pair below has real examples to record.
 *
 * With GMAIL_CONTRACT unset (or not '1'), this prints usage and exits 0 without touching the
 * network or the filesystem — safe to invoke by accident, and this is the only path exercised in
 * environments without credentials (including this one).
 *
 * Recorded endpoints: getProfile, listHistory (1 page — no pageToken follow-up), listMessages,
 * getThread, getMessage (format=full for one nested-multipart + one single-part owner-seeded test
 * message; format=metadata for the nested one AND for a message carrying an Authentication-Results
 * header — the money gate's input, FR9), listLabels. See `RECORDED_FIXTURE_NAMES` for the exact
 * file list. Everything else in the fixtures directory (404/error fixtures, label-create,
 * send-reply, message-metadata-proposal-marker) is hand-authored and left untouched — the
 * X-DogeBuddy-Proposal marker only rides OUR OWN sends, which the recorder never performs.
 *
 * NEVER records:
 *   - sendReply — no unsolicited sends against a real mailbox.
 *   - the JWT/token-exchange path — createGmailAuth below is given no fetchFn override, so its
 *     token fetch uses the plain global fetch, never the recording wrapper. That path is unit-
 *     tested with a throwaway key in packages/gmail/test/auth.test.ts and must never touch a real
 *     fixture file (6A scrubbing contract).
 *
 * Scrubbing: fixture files never carry a request-headers field at all (the shape above only ever
 * has `request: { method, path, query }`), so the Authorization bearer token is excluded
 * structurally, by construction, not by best-effort redaction. assertScrubbed() below is still run
 * on every captured fixture right before any file is written, as defense-in-depth against the same
 * binding contract: no fixture file may ever contain the strings "Bearer " or "PRIVATE KEY".
 */

interface CapturedFixture {
  request: { method: string; path: string; query?: Record<string, string | string[]> }
  response: { status: number; body: unknown }
}

/**
 * The fixture files a live `GMAIL_CONTRACT=1` run (re)writes, as an explicit exported list so a unit
 * test can assert the money-gate inputs are among them (FR9). `message-metadata-auth-results.json`
 * is the money gate's own input: the refund sender-auth check parses the topmost
 * `Authentication-Results` header, and before this it was backed ONLY by a hand-authored fixture, so
 * a live re-record could never validate `authenticationResults` normalization against real Gmail.
 *
 * NOT in this list (deliberate): `message-metadata-proposal-marker.json`. The `X-DogeBuddy-Proposal`
 * marker only appears on OUR OWN sends, which the recorder never performs (no unsolicited sends
 * against a real mailbox) — its real-Gmail verification is the OWNER-CHECKLIST Tier-2 metadata
 * assertion, not this recorder. The remaining hand-authored fixtures (404/error, label-create,
 * send-reply) are also intentionally absent — the recorder leaves them untouched.
 */
export const RECORDED_FIXTURE_NAMES = [
  'profile.json',
  'history-page1.json',
  'messages-list.json',
  'thread-get.json',
  'message-full-nested.json',
  'message-full-singlepart.json',
  'message-metadata.json',
  'message-metadata-auth-results.json',
  'labels-list.json',
] as const

export interface FixtureFile {
  name: string
  fixture: unknown
}

const FORBIDDEN_SUBSTRINGS = ['Bearer ', 'PRIVATE KEY']

/**
 * Throws (listing every offending file name) if any fixture's serialized JSON contains an
 * Authorization: Bearer header anywhere in its structure, or the bare substrings "Bearer " /
 * "PRIVATE KEY" wherever they appear. Serializing first (rather than walking keys) catches both
 * cases with one check: a nested `{ "Authorization": "Bearer x" }` and a leaked string value both
 * become substring-detectable once stringified. Clean fixtures pass through untouched.
 */
export function assertScrubbed(files: FixtureFile[]): void {
  const offenders = files
    .filter(({ fixture }) => {
      const serialized = JSON.stringify(fixture)
      return FORBIDDEN_SUBSTRINGS.some((needle) => serialized.includes(needle))
    })
    .map(({ name }) => name)

  if (offenders.length > 0) {
    throw new Error(`assertScrubbed: fixture(s) contain auth material and must NOT be written: ${offenders.join(', ')}`)
  }
}

/** Mirrors client.test.ts's fixture `query` shape: repeated params become an array, singletons a plain string. */
function buildQuery(searchParams: URLSearchParams): Record<string, string | string[]> | undefined {
  const keys = [...new Set(searchParams.keys())]
  if (keys.length === 0) return undefined
  const query: Record<string, string | string[]> = {}
  for (const key of keys) {
    const values = searchParams.getAll(key)
    query[key] = values.length > 1 ? values : (values[0] as string)
  }
  return query
}

async function captureBody(res: Response): Promise<unknown> {
  // Clone before reading — the original Response body stream still has to reach the real
  // client's own res.text()/JSON.parse() unconsumed.
  const text = await res.clone().text()
  return text.length > 0 ? JSON.parse(text) : null
}

/**
 * Wraps the real global fetch as the client's `fetchFn` seam, capturing each request/response
 * pair keyed by whatever fixture name `target.current` names at call time. `target` is a mutable
 * box the recording sequence below flips between client calls, so unrelated calls never collide
 * and a retried call (e.g. a transient 401) simply overwrites with its own final response.
 */
function createRecordingFetch(target: { current: string | null }, captured: Map<string, CapturedFixture>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const res = await fetch(url, init)
    if (target.current) {
      const u = new URL(String(url))
      captured.set(target.current, {
        request: {
          method: (init?.method ?? 'GET').toUpperCase(),
          path: u.pathname,
          query: buildQuery(u.searchParams),
        },
        response: { status: res.status, body: await captureBody(res) },
      })
    }
    return res
  }) as unknown as typeof fetch
}

interface RequiredEnv {
  saEmail: string
  saKey: string
  impersonate: string
  supportAddress: string
}

function requireEnv(): RequiredEnv {
  const saEmail = process.env.GMAIL_SERVICE_ACCOUNT_EMAIL
  const saKeyRaw = process.env.GMAIL_SERVICE_ACCOUNT_KEY
  const impersonate = process.env.GMAIL_IMPERSONATE
  const supportAddress = process.env.SUPPORT_ADDRESS

  const missing = [
    !saEmail && 'GMAIL_SERVICE_ACCOUNT_EMAIL',
    !saKeyRaw && 'GMAIL_SERVICE_ACCOUNT_KEY',
    !impersonate && 'GMAIL_IMPERSONATE',
    !supportAddress && 'SUPPORT_ADDRESS',
  ].filter((v): v is string => v !== false)

  if (missing.length > 0) {
    throw new Error(`record-fixtures: GMAIL_CONTRACT=1 requires ${missing.join(', ')} to be set.`)
  }

  return {
    saEmail: saEmail as string,
    // Same unescaping apps/ops/src/config.ts applies for the live server — env files carry the
    // PEM's newlines as literal `\n` two-character sequences.
    saKey: (saKeyRaw as string).replace(/\\n/g, '\n'),
    impersonate: impersonate as string,
    supportAddress: supportAddress as string,
  }
}

const FIXTURES_DIR = new URL('../test/fixtures/', import.meta.url)

async function writeFixtures(captured: Map<string, CapturedFixture>): Promise<void> {
  const files: FixtureFile[] = [...captured.entries()].map(([name, fixture]) => ({ name, fixture }))
  assertScrubbed(files)

  for (const { name, fixture } of files) {
    await writeFile(new URL(name, FIXTURES_DIR), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
    console.log(`record-fixtures: wrote ${name}`)
  }
}

/** Runs the live recording sequence. Only ever invoked when GMAIL_CONTRACT === '1'. */
async function recordFixtures(): Promise<void> {
  const { saEmail, saKey, impersonate, supportAddress } = requireEnv()

  const captured = new Map<string, CapturedFixture>()
  const target: { current: string | null } = { current: null }
  const recordingFetch = createRecordingFetch(target, captured)

  // No fetchFn override here on purpose — createGmailAuth's token fetch goes through the plain
  // global fetch, not `recordingFetch`, so the JWT/token-exchange path is structurally excluded
  // from ever being captured.
  const auth = createGmailAuth({ saEmail, saKey, impersonate })
  const client = createGmailClient({ auth, fromAddress: supportAddress, fetchFn: recordingFetch })

  target.current = 'profile.json'
  const profile = await client.getProfile()

  target.current = 'history-page1.json'
  await client.listHistory({ startHistoryId: profile.historyId })

  target.current = 'messages-list.json'
  const messages = await client.listMessages({ q: 'in:inbox' })

  const firstMessage = messages.ids[0]
  if (!firstMessage) {
    throw new Error(
      'record-fixtures: listMessages returned no messages — seed at least 2 owner test messages ' +
        '(one plain-text, one multipart) in the support inbox before recording.',
    )
  }

  target.current = 'thread-get.json'
  await client.getThread(firstMessage.threadId)

  // Classify owner-seeded messages by real payload shape (payload.parts present -> nested
  // multipart) rather than guessing from listMessages alone, which carries no structural info. The
  // same full-format scan ALSO finds a message that carries an `Authentication-Results` header
  // (FR9) — a real received email naturally has Google's A-R stamp — so its metadata fetch below
  // exercises the money gate's own normalization against real Gmail.
  let nestedId: string | null = null
  let singlepartId: string | null = null
  let authResultsId: string | null = null

  for (const { id } of messages.ids) {
    if (nestedId && singlepartId && authResultsId) break

    const scratchKey = `candidate:${id}`
    target.current = scratchKey
    await client.getMessage(id, { format: 'full' })
    const raw = captured.get(scratchKey)
    captured.delete(scratchKey)
    if (!raw) continue

    const body = raw.response.body as {
      payload?: { parts?: unknown[]; headers?: { name?: string; value?: string }[] }
    }
    const isNested = Array.isArray(body.payload?.parts) && (body.payload?.parts?.length ?? 0) > 0

    if (isNested && !nestedId) {
      nestedId = id
      captured.set('message-full-nested.json', raw)
    } else if (!isNested && !singlepartId) {
      singlepartId = id
      captured.set('message-full-singlepart.json', raw)
    }

    const hasAuthResults = (body.payload?.headers ?? []).some(
      (h) => h.name?.toLowerCase() === 'authentication-results',
    )
    if (hasAuthResults && !authResultsId) authResultsId = id
  }

  if (!nestedId || !singlepartId) {
    throw new Error(
      `record-fixtures: could not find both a nested-multipart and a single-part test message among ` +
        `${messages.ids.length} support-inbox message(s) (found nested=${nestedId !== null} singlepart=${singlepartId !== null}). ` +
        `Seed one of each (see this script's header comment) and retry.`,
    )
  }
  if (!authResultsId) {
    throw new Error(
      'record-fixtures: no inbound message carrying an Authentication-Results header was found — ' +
        'seed a real received email (its Google A-R stamp is the refund money-gate\'s input) so ' +
        'message-metadata-auth-results.json exercises authenticationResults normalization live.',
    )
  }

  target.current = 'message-metadata.json'
  await client.getMessage(nestedId, { format: 'metadata' })

  // FR9: metadata for a message that carries Authentication-Results — the topmost A-R header is the
  // refund sender-auth gate's input, and `getMessage(format:'metadata')` requests it (it is in
  // METADATA_HEADERS), so this fixture validates that normalization against real Gmail.
  target.current = 'message-metadata-auth-results.json'
  await client.getMessage(authResultsId, { format: 'metadata' })

  target.current = 'labels-list.json'
  await client.listLabels()

  target.current = null

  await writeFixtures(captured)
  console.log(`record-fixtures: wrote ${captured.size} fixture file(s) to ${fileURLToPath(FIXTURES_DIR)}`)
}

function printUsage(): void {
  console.log(
    [
      'record-fixtures: GMAIL_CONTRACT is unset (or not "1") — nothing was recorded.',
      '',
      'Usage (from repo root):',
      "  GMAIL_CONTRACT=1 env $(grep -v '^#' apps/ops/.env | xargs) \\",
      '    pnpm --filter @doge-buddy/gmail exec tsx scripts/record-fixtures.ts',
      '',
      'Requires GMAIL_SERVICE_ACCOUNT_EMAIL, GMAIL_SERVICE_ACCOUNT_KEY, GMAIL_IMPERSONATE, SUPPORT_ADDRESS',
      'in the environment, and at least 2 owner-seeded test messages (one plain-text, one multipart)',
      'in the support inbox.',
    ].join('\n'),
  )
}

// Only runs the network/filesystem-touching sequence when this file is the actual process entry
// point (`tsx scripts/record-fixtures.ts`) — never on import, so the test file above can import
// assertScrubbed without triggering a live run or an unwanted process.exit().
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  if (process.env.GMAIL_CONTRACT !== '1') {
    printUsage()
    process.exit(0)
  }

  try {
    await recordFixtures()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
