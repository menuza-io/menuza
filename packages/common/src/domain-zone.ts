import { trimDnsName } from './domains.ts'

/**
 * The DNS records of a domain Menuza manages (#283): the record shape, the
 * checks every change goes through, SPF merging, zone file import and export,
 * and the plan for "Connect automatically" (#313). Pure; the provider call and
 * the audit entry are the App's job.
 */

export const ZONE_RECORD_TYPES = [
	'A',
	'AAAA',
	'CNAME',
	'MX',
	'TXT',
	'SRV',
	'CAA',
	'NS',
] as const
export type ZoneRecordType = (typeof ZONE_RECORD_TYPES)[number]

/** Who owns a record: null is the operator's (imported or typed). */
export type ZoneRecordManager =
	'site' | 'email_forwarding' | 'email_sending' | 'registrar'

export type ZoneRecord = {
	id?: string
	type: ZoneRecordType
	/** Fully qualified, lower case, no trailing dot (`www.example.com`). */
	name: string
	content: string
	/** 1 means automatic; otherwise 60 to 86400 seconds. */
	ttl?: number
	/** MX and SRV only. */
	priority?: number | null
	proxied?: boolean
	managedBy?: ZoneRecordManager | null
}

export const MAX_ZONE_RECORDS = 200

export type RecordIssueCode =
	| 'invalid_type'
	| 'invalid_name'
	| 'name_outside_zone'
	| 'invalid_content'
	| 'invalid_ttl'
	| 'mx_priority_required'
	| 'duplicate'
	| 'spf_duplicate'
	| 'cname_conflict'
	| 'managed_readonly'
	| 'apex_ns'
	| 'too_many_records'
	| 'txt_too_long'

export type RecordIssue = { field: string; code: RecordIssueCode }

const IPV4_RE =
	/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/u
const HOST_RE =
	/^(?:[a-z0-9_*](?:[a-z0-9_-]{0,61}[a-z0-9_])?)(?:\.[a-z0-9_*](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/u

export function isIpv4(value: string): boolean {
	return IPV4_RE.test(value)
}

export function isIpv6(value: string): boolean {
	if (!value.includes(':') || /[^0-9a-f:.]/iu.test(value)) return false
	try {
		return new URL(`http://[${value}]`).hostname.length > 2
	} catch {
		return false
	}
}

function isHostName(value: string): boolean {
	const host = trimDnsName(value)
	return host.length > 0 && host.length <= 253 && HOST_RE.test(host)
}

/** Whether a TXT value is an SPF record. */
export function isSpf(value: string): boolean {
	return /^v=spf1(\s|$)/iu.test(value.trim())
}

function sameRecord(a: ZoneRecord, b: ZoneRecord): boolean {
	return (
		a.type === b.type &&
		trimDnsName(a.name) === trimDnsName(b.name) &&
		(a.type === 'TXT'
			? a.content.trim() === b.content.trim()
			: trimDnsName(a.content) === trimDnsName(b.content)) &&
		(a.priority ?? null) === (b.priority ?? null)
	)
}

export function isMailRecord(record: ZoneRecord, domain: string): boolean {
	if (record.type === 'MX') return true
	if (record.type !== 'TXT' && record.type !== 'CNAME') return false
	const name = trimDnsName(record.name)
	if (name.endsWith(`._domainkey.${domain}`)) return true
	if (name === `_dmarc.${domain}`) return true
	if (record.type === 'TXT' && name === domain) {
		return (
			isSpf(record.content) ||
			/^(google-site-verification=|ms=)/iu.test(record.content)
		)
	}
	return false
}

/**
 * Checks one record against the zone before it is saved: the rules the screen
 * promises (one SPF per name, MX needs a priority, no duplicates, records we
 * manage for the site cannot be changed).
 */
export function validateRecord(input: {
	domain: string
	existing: ZoneRecord[]
	next: ZoneRecord
	/** The record being edited (excluded from the duplicate checks). */
	editing?: ZoneRecord | null
}): RecordIssue[] {
	const issues: RecordIssue[] = []
	const { domain, next } = input
	const name = trimDnsName(next.name)
	const others = input.existing.filter(
		(record) => !(input.editing?.id && record.id === input.editing.id),
	)

	if (input.editing?.managedBy) {
		return [{ field: 'record', code: 'managed_readonly' }]
	}
	if (!(ZONE_RECORD_TYPES as readonly string[]).includes(next.type)) {
		return [{ field: 'type', code: 'invalid_type' }]
	}
	if (!isHostName(name)) {
		issues.push({ field: 'name', code: 'invalid_name' })
	} else if (name !== domain && !name.endsWith(`.${domain}`)) {
		issues.push({ field: 'name', code: 'name_outside_zone' })
	}

	const content = next.content.trim()
	switch (next.type) {
		case 'A':
			if (!isIpv4(content))
				issues.push({ field: 'content', code: 'invalid_content' })
			break
		case 'AAAA':
			if (!isIpv6(content))
				issues.push({ field: 'content', code: 'invalid_content' })
			break
		case 'CNAME':
			if (!isHostName(content))
				issues.push({ field: 'content', code: 'invalid_content' })
			break
		case 'MX':
			if (!isHostName(content))
				issues.push({ field: 'content', code: 'invalid_content' })
			if (
				next.priority === undefined ||
				next.priority === null ||
				!Number.isInteger(next.priority) ||
				next.priority < 0 ||
				next.priority > 65535
			) {
				issues.push({ field: 'priority', code: 'mx_priority_required' })
			}
			break
		case 'TXT':
			if (!content) issues.push({ field: 'content', code: 'invalid_content' })
			else if (content.length > 2048)
				issues.push({ field: 'content', code: 'txt_too_long' })
			break
		case 'NS':
			if (!isHostName(content))
				issues.push({ field: 'content', code: 'invalid_content' })
			if (name === domain) issues.push({ field: 'type', code: 'apex_ns' })
			break
		case 'SRV':
		case 'CAA':
			if (!content) issues.push({ field: 'content', code: 'invalid_content' })
			break
	}

	if (
		next.ttl !== undefined &&
		next.ttl !== 1 &&
		(!Number.isInteger(next.ttl) || next.ttl < 60 || next.ttl > 86400)
	) {
		issues.push({ field: 'ttl', code: 'invalid_ttl' })
	}

	if (others.length >= MAX_ZONE_RECORDS) {
		issues.push({ field: 'record', code: 'too_many_records' })
	}
	if (others.some((record) => sameRecord(record, { ...next, name }))) {
		issues.push({ field: 'record', code: 'duplicate' })
	}
	if (
		next.type === 'TXT' &&
		isSpf(content) &&
		others.some(
			(record) =>
				record.type === 'TXT' &&
				trimDnsName(record.name) === name &&
				isSpf(record.content),
		)
	) {
		issues.push({ field: 'content', code: 'spf_duplicate' })
	}
	// The site's own CNAME at the root is flattened by the zone host (it answers
	// with addresses), so mail records may sit beside it; any other CNAME may not
	// share its name with other records.
	const sameName = others.filter(
		(record) =>
			trimDnsName(record.name) === name &&
			!(
				name === domain &&
				record.type === 'CNAME' &&
				record.managedBy === 'site'
			),
	)
	if (
		(next.type === 'CNAME' && sameName.length > 0) ||
		(next.type !== 'CNAME' &&
			sameName.some((record) => record.type === 'CNAME'))
	) {
		issues.push({ field: 'type', code: 'cname_conflict' })
	}
	return issues
}

/** Whether a record may be removed (we never remove what we manage). */
export function validateRecordRemoval(record: ZoneRecord): RecordIssue[] {
	return record.managedBy ? [{ field: 'record', code: 'managed_readonly' }] : []
}

// ---------------------------------------------------------------------------
// SPF: one record per name, senders merged
// ---------------------------------------------------------------------------

/**
 * Merges mechanisms into the one SPF record of a name. Mechanisms already
 * there are kept in order, new ones go before the final `all`, whose
 * qualifier the existing record chose stays. Without an existing record the
 * result is `v=spf1 <mechanisms> ~all`.
 */
export function mergeSpf(
	existing: string | null,
	mechanisms: string[],
): string {
	const parts = (existing ?? 'v=spf1').trim().split(/\s+/u).filter(Boolean)
	const head = parts[0]?.toLowerCase() === 'v=spf1' ? parts.slice(1) : parts
	const allIndex = head.findIndex((part) => /^[+\-~?]?all$/iu.test(part))
	const all = allIndex >= 0 ? head[allIndex]! : '~all'
	const body =
		allIndex >= 0 ? head.filter((_, index) => index !== allIndex) : head
	for (const mechanism of mechanisms) {
		const wanted = mechanism.trim()
		if (
			wanted &&
			!body.some((part) => part.toLowerCase() === wanted.toLowerCase())
		) {
			body.push(wanted)
		}
	}
	return ['v=spf1', ...body, all].join(' ')
}

/** The mechanisms of an SPF record that name a sender. */
export function spfMechanisms(record: string): string[] {
	return record
		.trim()
		.split(/\s+/u)
		.slice(1)
		.filter((part) => !/^[+\-~?]?all$/iu.test(part))
}

// ---------------------------------------------------------------------------
// Zone files
// ---------------------------------------------------------------------------

const ZONE_TYPES = new Set<string>([...ZONE_RECORD_TYPES, 'SOA'])

export type ZoneFileResult = {
	records: ZoneRecord[]
	errors: Array<{ line: number; message: string }>
}

function stripComment(line: string): string {
	let inQuote = false
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index]
		if (char === '\\') {
			index += 1
			continue
		}
		if (char === '"') inQuote = !inQuote
		if (char === ';' && !inQuote) return line.slice(0, index)
	}
	return line
}

function tokenize(line: string): string[] {
	const tokens: string[] = []
	const re = /"((?:[^"\\]|\\.)*)"|(\S+)/gu
	let match: RegExpExecArray | null
	while ((match = re.exec(line))) {
		tokens.push(match[1] !== undefined ? `"${match[1]}"` : match[2]!)
	}
	return tokens
}

function absolute(name: string, origin: string): string {
	if (name === '@') return origin
	if (name.endsWith('.')) return trimDnsName(name)
	return trimDnsName(`${name}.${origin}`)
}

/**
 * Reads a BIND-style zone file (the export every registrar offers). SOA and
 * the apex NS records are left out: the zone brings its own. Unknown record
 * types are reported rather than guessed at.
 */
export function parseZoneFile(text: string, domain: string): ZoneFileResult {
	const records: ZoneRecord[] = []
	const errors: ZoneFileResult['errors'] = []
	let origin = trimDnsName(domain)
	let defaultTtl: number | undefined
	let lastName = origin

	// Join parenthesised multi-line records (SOA and long TXT) into one line.
	const logical: Array<{ line: number; text: string; startsBlank: boolean }> =
		[]
	let buffer = ''
	let depth = 0
	let startLine = 0
	let startsBlank = false
	for (const [index, raw] of text.replace(/\r/gu, '').split('\n').entries()) {
		const line = stripComment(raw)
		if (depth === 0) {
			if (!line.trim()) continue
			startLine = index + 1
			startsBlank = /^\s/u.test(line)
			buffer = ''
		}
		buffer += ` ${line}`
		depth +=
			(line.match(/\(/gu) ?? []).length - (line.match(/\)/gu) ?? []).length
		if (depth <= 0) {
			depth = 0
			logical.push({
				line: startLine,
				text: buffer.replace(/[()]/gu, ' ').trim(),
				startsBlank,
			})
		}
	}

	for (const entry of logical) {
		const tokens = tokenize(entry.text)
		if (tokens.length === 0) continue
		if (tokens[0]!.toUpperCase() === '$ORIGIN') {
			origin = trimDnsName(tokens[1] ?? origin)
			continue
		}
		if (tokens[0]!.toUpperCase() === '$TTL') {
			defaultTtl = Number(tokens[1]) || undefined
			continue
		}
		if (tokens[0]!.startsWith('$')) continue

		let index = 0
		let name = lastName
		if (!entry.startsBlank) {
			name = absolute(tokens[0]!, origin)
			index = 1
		}
		let ttl = defaultTtl
		if (/^\d+$/u.test(tokens[index] ?? '')) {
			ttl = Number(tokens[index])
			index += 1
		}
		if ((tokens[index] ?? '').toUpperCase() === 'IN') index += 1
		const type = (tokens[index] ?? '').toUpperCase()
		const rdata = tokens.slice(index + 1)
		lastName = name
		if (!ZONE_TYPES.has(type)) {
			errors.push({
				line: entry.line,
				message: `Unsupported record type ${type || '?'}`,
			})
			continue
		}
		if (type === 'SOA') continue
		if (type === 'NS' && name === trimDnsName(domain)) continue
		if (rdata.length === 0) {
			errors.push({ line: entry.line, message: 'Missing record value' })
			continue
		}
		const base = { name, ...(ttl ? { ttl } : {}) }
		switch (type) {
			case 'MX': {
				const priority = Number(rdata[0])
				if (!Number.isInteger(priority) || !rdata[1]) {
					errors.push({
						line: entry.line,
						message: 'MX needs a priority and a host',
					})
					break
				}
				records.push({
					...base,
					type: 'MX',
					priority,
					content: absolute(rdata[1], origin),
				})
				break
			}
			case 'TXT': {
				const content = rdata
					.map((part) =>
						part.startsWith('"') && part.endsWith('"')
							? part.slice(1, -1)
							: part,
					)
					.join('')
				records.push({ ...base, type: 'TXT', content })
				break
			}
			case 'CNAME':
			case 'NS':
				records.push({
					...base,
					type: type as 'CNAME' | 'NS',
					content: absolute(rdata[0]!, origin),
				})
				break
			case 'SRV':
			case 'CAA':
				records.push({
					...base,
					type: type as 'SRV' | 'CAA',
					content: rdata.join(' '),
				})
				break
			default:
				records.push({
					...base,
					type: type as 'A' | 'AAAA',
					content: rdata[0]!,
				})
		}
	}
	return { records, errors }
}

export function exportZoneFile(domain: string, records: ZoneRecord[]): string {
	const origin = trimDnsName(domain)
	const lines = [
		`; Zone file for ${origin}, exported from Menuza`,
		`$ORIGIN ${origin}.`,
		'$TTL 3600',
	]
	const label = (name: string) =>
		name === origin ? '@' : `${name.slice(0, -(origin.length + 1))}`
	for (const record of [...records].sort((a, b) =>
		a.name === b.name
			? a.type.localeCompare(b.type)
			: a.name.localeCompare(b.name),
	)) {
		const ttl = record.ttl && record.ttl > 1 ? record.ttl : 3600
		let rdata = record.content
		if (record.type === 'TXT') {
			rdata = record.content
				.match(/.{1,255}/gu)!
				.map(
					(chunk) => `"${chunk.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`,
				)
				.join(' ')
		} else if (record.type === 'MX') {
			rdata = `${record.priority ?? 10} ${trimDnsName(record.content)}.`
		} else if (record.type === 'CNAME' || record.type === 'NS') {
			rdata = `${trimDnsName(record.content)}.`
		}
		lines.push(`${label(record.name)}\t${ttl}\tIN\t${record.type}\t${rdata}`)
	}
	return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Moving a domain to our nameservers: scan result and the email guard
// ---------------------------------------------------------------------------

export type EmailSafety =
	/** No mail records exist: nothing can be lost. */
	| 'none'
	/** Every mail record found was captured (a zone file backs the scan). */
	| 'captured'
	/** Mail records exist that a DNS scan cannot be sure to have captured. */
	| 'attention'

/**
 * "Website safe, email safe" or "Email may need attention". With mail records
 * on the domain, only a zone file that contains every record the DNS scan
 * found makes the move safe; otherwise the operator must confirm in words.
 */
export function evaluateEmailSafety(input: {
	domain: string
	mailKind: 'none' | 'mail' | 'records_only'
	scanned: ZoneRecord[]
	uploaded: ZoneRecord[] | null
}): EmailSafety {
	if (input.mailKind === 'none') return 'none'
	if (!input.uploaded) return 'attention'
	const inFile = input.uploaded
	const mailInScan = input.scanned.filter((record) =>
		isMailRecord(record, input.domain),
	)
	const allInFile = mailInScan.every((record) =>
		inFile.some((candidate) => sameRecord(candidate, record)),
	)
	return allInFile ? 'captured' : 'attention'
}

/** The words the operator types before an unsafe move continues. */
export function emailConfirmationMatches(
	typed: string,
	domain: string,
): boolean {
	return trimDnsName(typed) === trimDnsName(domain)
}

// ---------------------------------------------------------------------------
// Connect automatically: a plan that never touches mail
// ---------------------------------------------------------------------------

export type DnsChange = {
	action: 'add'
	type: ZoneRecordType
	name: string
	content: string
	ttl?: number
}

/**
 * The records that point a host at Sites. For the root: CNAME at the root
 * (the provider flattens it) or A records. Never anything else.
 */
export function planSiteRecords(input: {
	hostnames: string[]
	cnameTarget: string
	apexOf: (hostname: string) => string
	apexIps?: { a: string[]; aaaa: string[] }
	/** `a_only` providers get A and AAAA instead of a root CNAME. */
	apexMode: 'alias' | 'a_only'
}): DnsChange[] {
	const changes: DnsChange[] = []
	const target = trimDnsName(input.cnameTarget)
	for (const hostname of input.hostnames) {
		const isApex = input.apexOf(hostname) === hostname
		if (isApex && input.apexMode === 'a_only') {
			for (const ip of input.apexIps?.a ?? []) {
				changes.push({ action: 'add', type: 'A', name: hostname, content: ip })
			}
			for (const ip of input.apexIps?.aaaa ?? []) {
				changes.push({
					action: 'add',
					type: 'AAAA',
					name: hostname,
					content: ip,
				})
			}
			continue
		}
		changes.push({
			action: 'add',
			type: 'CNAME',
			name: hostname,
			content: target,
		})
	}
	return changes
}

/** True when a change would add, replace or remove a mail record. */
export function changeTouchesMail(change: DnsChange, domain: string): boolean {
	return isMailRecord(
		{ type: change.type, name: change.name, content: change.content },
		trimDnsName(domain),
	)
}
