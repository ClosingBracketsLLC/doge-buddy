export function parseAddrSpecs(header: string | null | undefined): string[] {
  if (!header) return []

  // Step 1: Strip quoted display names BEFORE looking for bare addresses
  // This prevents spoofing like "evil@spoof.com" <real@addr.com>
  const stripped = header.replace(/"(?:\\"|[^"])*"/g, ' ')

  // Step 2: Split on commas (now safe since quoted strings are gone)
  const mailboxes = stripped.split(',')

  const results: string[] = []
  const addrRegex = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/

  for (const mailbox of mailboxes) {
    let addr = mailbox.trim()

    // Step 3: Extract from angle brackets if present, otherwise use bare token
    const angleMatch = addr.match(/<([^>]+)>/)
    if (angleMatch && angleMatch[1]) {
      addr = angleMatch[1]
    }

    // Step 4: Lowercase the address
    addr = addr.toLowerCase()

    // Step 5: Validate with conservative regex
    if (addrRegex.test(addr)) {
      results.push(addr)
    }
  }

  return results
}

export function parseFirstAddrSpec(header: string | null | undefined): string | null {
  const [first] = parseAddrSpecs(header)
  return first ?? null
}
