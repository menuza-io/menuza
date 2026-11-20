import { trimDnsName } from './domains.ts'

/**
 * What a domain's public DNS says, and what we need it to say (#139, #313).
 * Pure functions over answers the App fetched with DNS-over-HTTPS; nothing here
 * touches the network.
 */

// ---------------------------------------------------------------------------
// The per-host setup checklist
// ---------------------------------------------------------------------------

export type ChecklistRecordType = 'CNAME' | 'ALIAS' | 'A' | 'AAAA' | 'TXT'
export type ChecklistRecordKind = 'route' | 'ownership' | 'ssl'
export type RecordCheck = 'found' | 'missing' | 'mismatch' | 'unknown'

export type ChecklistRecord = {
	id: string
	kind: ChecklistRecordKind
	type: ChecklistRecordType
	/** The host the record goes on (`www.example.com`). */
	name: string
	/** The value to enter. For the root with A records, the first address. */
	value: string
	/**
	 * Other values that do the same job at the root when the DNS provider has
	 * no ALIAS, ANAME or CNAME flattening: the A and AAAA records.
	 */
	alternatives?: Array<{ type: 'A' | 'AAAA'; name: string; values: string[] }>
	/** The record is only needed in some cases (ownership before cut-over). */
	optional?: boolean
}

export type VerificationRecord = {
	type: string
	name: string
	value: string
}

export type ChecklistInput = {
	hostname: string
	role: 'apex' | 'www' | 'subdomain'
	cnameTarget: string
	apexIps?: { a: string[]; aaaa: string[] }
	ownership?: VerificationRecord | null
	sslValidation?: VerificationRecord[] | null
}

export function buildHostChecklist(input: ChecklistInput): ChecklistRecord[] {
	const records: ChecklistRecord[] = []
	const target = trimDnsName(input.cnameTarget)
	if (input.role === 'apex') {
		const alternatives: NonNullable<ChecklistRecord['alternatives']> = []
		if (input.apexIps?.a.length) {
			alternatives.push({
				type: 'A',
				name: input.hostname,
				values: input.apexIps.a,
			})
		}
		if (input.apexIps?.aaaa.length) {
			alternatives.push({
				type: 'AAAA',
				name: input.hostname,
				values: input.apexIps.aaaa,
			})
		}
		records.push({
			id: 'route',
			kind: 'route',
			type: 'ALIAS',
			name: input.hostname,
			value: target,
			...(alternatives.length ? { alternatives } : {}),
		})
	} else {
		records.push({
			id: 'route',
			kind: 'route',
			type: 'CNAME',
			name: input.hostname,
			value: target,
		})
	}
	if (input.ownership?.name) {
		records.push({
			id: 'ownership',
			kind: 'ownership',
			type: 'TXT',
			name: trimDnsName(input.ownership.name),
			value: input.ownership.value,
			optional: true,
		})
	}
	for (const [index, validation] of (input.sslValidation ?? []).entries()) {
		if (!validation.name || !validation.value) continue
		const type = validation.type.toUpperCase() === 'CNAME' ? 'CNAME' : 'TXT'
		records.push({
			id: `ssl-${index}`,
			kind: 'ssl',
			type,
			name: trimDnsName(validation.name),
			value: validation.value,
			optional: true,
		})
	}
	return records
}

/** Answers fetched for one host; every list is already de-quoted and trimmed. */
export type HostAnswers = {
	cname: string[]
	a: string[]
	aaaa: string[]
	/** TXT strings by lower-case record name. */
	txt: Record<string, string[]>
	cnameOf: Record<string, string[]>
	/** The addresses our CNAME target resolves to (flattening / proxy check). */
	targetA: string[]
	targetAaaa: string[]
}

export type RecordResult = {
	id: string
	check: RecordCheck
	/** What the host has now, for a mismatch ("points at 1.2.3.4"). */
	current?: string[]
}

export function evaluateChecklist(
	records: ChecklistRecord[],
	input: Pick<ChecklistInput, 'hostname' | 'role' | 'cnameTarget' | 'apexIps'>,
	answers: HostAnswers,
): RecordResult[] {
	const target = trimDnsName(input.cnameTarget)
	return records.map((record): RecordResult => {
		if (record.kind === 'route') {
			const cnames = answers.cname.map(trimDnsName)
			if (cnames.includes(target)) return { id: record.id, check: 'found' }
			const wantA = new Set([...answers.targetA, ...(input.apexIps?.a ?? [])])
			const wantAaaa = new Set([
				...answers.targetAaaa,
				...(input.apexIps?.aaaa ?? []),
			])
			const hasA = answers.a.some((ip) => wantA.has(ip))
			const hasAaaa = answers.aaaa.some((ip) => wantAaaa.has(ip))
			// A flattened ALIAS or ANAME, or a proxied record, answers with addresses.
			if (hasA || hasAaaa) return { id: record.id, check: 'found' }
			const current = [...cnames, ...answers.a, ...answers.aaaa]
			return current.length
				? { id: record.id, check: 'mismatch', current }
				: { id: record.id, check: 'missing' }
		}
		const values = answers.txt[trimDnsName(record.name)] ?? []
		const cnameValues = (answers.cnameOf[trimDnsName(record.name)] ?? []).map(
			trimDnsName,
		)
		if (record.type === 'CNAME') {
			if (cnameValues.includes(trimDnsName(record.value))) {
				return { id: record.id, check: 'found' }
			}
			return cnameValues.length
				? { id: record.id, check: 'mismatch', current: cnameValues }
				: { id: record.id, check: 'missing' }
		}
		if (values.includes(record.value)) return { id: record.id, check: 'found' }
		return values.length
			? { id: record.id, check: 'mismatch', current: values }
			: { id: record.id, check: 'missing' }
	})
}

/** Every record the host needs is found (optional records are not needed). */
export function checklistComplete(
	records: ChecklistRecord[],
	results: RecordResult[],
): boolean {
	return records
		.filter((record) => record.kind === 'route')
		.every(
			(record) =>
				results.find((result) => result.id === record.id)?.check === 'found',
		)
}

// ---------------------------------------------------------------------------
// Email on the domain
// ---------------------------------------------------------------------------

export type MxRecord = { priority: number; host: string }

export type MailInput = {
	mx: MxRecord[]
	/** TXT strings at the domain itself. */
	apexTxt: string[]
	/** TXT strings at `_dmarc.<domain>`. */
	dmarcTxt: string[]
	/** TXT or CNAME values found at `<selector>._domainkey.<domain>`. */
	dkim: Array<{ selector: string; values: string[] }>
}

export type MailProvider = {
	id: string
	name: string
}

const MX_PROVIDERS: Array<[RegExp, MailProvider]> = [
	[
		/(^|\.)(google\.com|googlemail\.com|aspmx\.l\.google\.com)$/u,
		{ id: 'google', name: 'Google Workspace' },
	],
	[
		/(^|\.)mail\.protection\.outlook\.com$/u,
		{ id: 'microsoft', name: 'Microsoft 365' },
	],
	[/(^|\.)zoho\.(com|eu|in|sa)$/u, { id: 'zoho', name: 'Zoho Mail' }],
	[
		/(^|\.)(protonmail\.ch|proton\.me)$/u,
		{ id: 'proton', name: 'Proton Mail' },
	],
	[/(^|\.)messagingengine\.com$/u, { id: 'fastmail', name: 'Fastmail' }],
	[/(^|\.)icloud\.com$/u, { id: 'icloud', name: 'iCloud Mail' }],
	[/(^|\.)yandex\.(net|ru)$/u, { id: 'yandex', name: 'Yandex Mail' }],
	[
		/(^|\.)(privateemail\.com|registrar-servers\.com)$/u,
		{ id: 'namecheap', name: 'Namecheap email' },
	],
	[/(^|\.)secureserver\.net$/u, { id: 'godaddy', name: 'GoDaddy email' }],
	[/(^|\.)mimecast\.com$/u, { id: 'mimecast', name: 'Mimecast' }],
	[/(^|\.)(improvmx\.com)$/u, { id: 'improvmx', name: 'ImprovMX forwarding' }],
	[
		/(^|\.)mx\.cloudflare\.net$/u,
		{ id: 'cloudflare', name: 'Cloudflare Email Routing' },
	],
]

export function detectMailProvider(mx: MxRecord[]): MailProvider | null {
	for (const record of mx) {
		const host = trimDnsName(record.host)
		for (const [pattern, provider] of MX_PROVIDERS) {
			if (pattern.test(host)) return provider
		}
	}
	return null
}

export type MailRecordToKeep = {
	type: 'MX' | 'TXT' | 'CNAME'
	name: string
	value: string
	priority?: number
	label: 'mx' | 'spf' | 'dmarc' | 'dkim' | 'verification'
}

export type MailFindings = {
	/** `mail`: MX records exist. `records_only`: mail records but no MX. */
	kind: 'none' | 'mail' | 'records_only'
	provider: MailProvider | null
	mx: MxRecord[]
	spf: string[]
	dmarc: string[]
	dkim: Array<{ selector: string; values: string[] }>
	/** Records a change must keep so mail keeps flowing. */
	recordsToKeep: MailRecordToKeep[]
}

const VERIFICATION_TXT =
	/^(google-site-verification=|ms=|MS=|zoho-verification=|protonmail-verification=|fastmail-verification|apple-domain=|atlassian-domain|facebook-domain)/iu

export function analyzeMail(input: MailInput, domain: string): MailFindings {
	const spf = input.apexTxt.filter((value) => /^v=spf1(\s|$)/iu.test(value))
	const dmarc = input.dmarcTxt.filter((value) => /^v=DMARC1/iu.test(value))
	const dkim = input.dkim.filter((entry) => entry.values.length > 0)
	const verification = input.apexTxt.filter((value) =>
		VERIFICATION_TXT.test(value),
	)
	const mx = [...input.mx].sort((a, b) => a.priority - b.priority)
	const hasMailRecords =
		spf.length > 0 ||
		dmarc.length > 0 ||
		dkim.length > 0 ||
		verification.length > 0
	const kind: MailFindings['kind'] =
		mx.length > 0 ? 'mail' : hasMailRecords ? 'records_only' : 'none'

	const recordsToKeep: MailRecordToKeep[] = [
		...mx.map((record) => ({
			type: 'MX' as const,
			name: domain,
			value: trimDnsName(record.host),
			priority: record.priority,
			label: 'mx' as const,
		})),
		...spf.map((value) => ({
			type: 'TXT' as const,
			name: domain,
			value,
			label: 'spf' as const,
		})),
		...dmarc.map((value) => ({
			type: 'TXT' as const,
			name: `_dmarc.${domain}`,
			value,
			label: 'dmarc' as const,
		})),
		...dkim.flatMap((entry) =>
			entry.values.map((value) => ({
				type: 'TXT' as const,
				name: `${entry.selector}._domainkey.${domain}`,
				value,
				label: 'dkim' as const,
			})),
		),
		...verification.map((value) => ({
			type: 'TXT' as const,
			name: domain,
			value,
			label: 'verification' as const,
		})),
	]

	return {
		kind,
		provider: detectMailProvider(mx),
		mx,
		spf,
		dmarc,
		dkim,
		recordsToKeep,
	}
}

/** DKIM selectors worth probing: the common defaults of the big senders. */
export const COMMON_DKIM_SELECTORS = [
	'default',
	'google',
	'selector1',
	'selector2',
	'k1',
	'k2',
	's1',
	's2',
	'mail',
	'dkim',
	'zoho',
	'resend',
] as const

// ---------------------------------------------------------------------------
// An existing website on the domain
// ---------------------------------------------------------------------------

const BUILDERS: Array<[RegExp, string]> = [
	[/(^|\.)wixdns\.net$|(^|\.)wix\.com$/u, 'Wix'],
	[
		/(^|\.)squarespace\.com$|(^|\.)squarespacedns\.com$|ext-cust\.squarespace\.com$/u,
		'Squarespace',
	],
	[/(^|\.)shopify\.com$|(^|\.)myshopify\.com$/u, 'Shopify'],
	[
		/(^|\.)wordpress\.com$|(^|\.)wpengine\.com$|(^|\.)wpenginepowered\.com$/u,
		'WordPress',
	],
	[
		/(^|\.)godaddysites\.com$|(^|\.)secureserver\.net$/u,
		'GoDaddy Website Builder',
	],
	[/(^|\.)weebly\.com$|(^|\.)editmysite\.com$/u, 'Weebly'],
	[/(^|\.)webflow\.io$|(^|\.)proxy-ssl\.webflow\.com$/u, 'Webflow'],
	[/(^|\.)netlify\.app$|(^|\.)netlify\.com$/u, 'Netlify'],
	[/(^|\.)vercel-dns\.com$|(^|\.)vercel\.app$/u, 'Vercel'],
	[/(^|\.)pages\.dev$/u, 'Cloudflare Pages'],
	[/(^|\.)github\.io$/u, 'GitHub Pages'],
	[/(^|\.)toasttab\.com$/u, 'Toast'],
	[/(^|\.)chownow\.com$/u, 'ChowNow'],
]

export type WebsiteFindings = {
	hasWebsite: boolean
	builder: string | null
	/** What the root and www point at today, for the warning. */
	pointsAt: string[]
}

export function analyzeWebsite(input: {
	apexA: string[]
	apexAaaa: string[]
	apexCname: string[]
	wwwA: string[]
	wwwCname: string[]
	cnameTarget: string
}): WebsiteFindings {
	const target = trimDnsName(input.cnameTarget)
	const cnames = [...input.apexCname, ...input.wwwCname].map(trimDnsName)
	const others = cnames.filter((value) => value !== target)
	const addresses = [...input.apexA, ...input.apexAaaa, ...input.wwwA]
	const pointsAt = [...new Set([...others, ...addresses])]
	const builder =
		others
			.map((value) => BUILDERS.find(([pattern]) => pattern.test(value))?.[1])
			.find(Boolean) ?? null
	return {
		hasWebsite: pointsAt.length > 0,
		builder,
		pointsAt,
	}
}

/** A certificate-challenge record a previous provider left behind. */
export function findAcmeLeftovers(input: {
	hostname: string
	challengeTxt: string[]
	challengeCname: string[]
}): string[] {
	const name = `_acme-challenge.${input.hostname}`
	return [
		...input.challengeTxt.map((value) => `TXT ${name} ${value}`),
		...input.challengeCname.map(
			(value) => `CNAME ${name} ${trimDnsName(value)}`,
		),
	]
}

/** Parses an `MX` answer (`10 mx.example.com.`). */
export function parseMxAnswer(data: string): MxRecord | null {
	const match = /^\s*(\d+)\s+(\S+)\s*$/u.exec(data)
	if (!match) return null
	return { priority: Number(match[1]), host: trimDnsName(match[2]!) }
}

/** Joins the quoted chunks of a TXT answer (resolvers split long records). */
export function parseTxtAnswer(data: string): string {
	const chunks = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((match) =>
		match[1]!.replace(/\\(.)/gu, '$1'),
	)
	return chunks.length ? chunks.join('') : data
}
