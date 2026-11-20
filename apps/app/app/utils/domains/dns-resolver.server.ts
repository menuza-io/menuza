import {
	parseMxAnswer,
	parseTxtAnswer,
	type HostAnswers,
	type MxRecord,
} from '@repo/common/domain-dns'
import { describeHostname, trimDnsName } from '@repo/common/domains'
import { isDomainsMock } from './config.server.ts'

/**
 * Public DNS lookups over DNS-over-HTTPS (#139, #313): read-only, and only for
 * names the operator typed. The resolver is a function so tests and the local
 * emulator can stand in for the network.
 */

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'NS'

export type DnsAnswer = { type: DnsRecordType; data: string }

export type DnsResolver = (
	name: string,
	type: DnsRecordType,
) => Promise<DnsAnswer[]>

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'
const TYPE_NUMBERS: Record<DnsRecordType, number> = {
	A: 1,
	NS: 2,
	CNAME: 5,
	MX: 15,
	TXT: 16,
	AAAA: 28,
}
export const DNS_LOOKUP_TIMEOUT_MS = 4_000

/** Cloudflare's DoH JSON API. A lookup that fails answers "no records". */
export function createDohResolver(
	fetchImpl: typeof fetch = fetch,
): DnsResolver {
	return async (name, type) => {
		const url = new URL(DOH_ENDPOINT)
		url.searchParams.set('name', name)
		url.searchParams.set('type', type)
		try {
			const response = await fetchImpl(url, {
				headers: { Accept: 'application/dns-json' },
				redirect: 'manual',
				signal: AbortSignal.timeout(DNS_LOOKUP_TIMEOUT_MS),
			})
			if (!response.ok) return []
			const body = (await response.json()) as {
				Answer?: Array<{ type: number; data: string }>
			}
			return (body.Answer ?? [])
				.filter((answer) => answer.type === TYPE_NUMBERS[type])
				.map((answer) => ({ type, data: answer.data }))
		} catch {
			return []
		}
	}
}

/**
 * The emulator's "public DNS": what a resolver would answer on a local
 * deployment. Records are added by the emulated registrar/DNS host and by the
 * emulated Domain Connect, so the whole flow can be driven without a network.
 */
export class MockPublicDns {
	private readonly answers = new Map<string, DnsAnswer[]>()

	private key(name: string, type: DnsRecordType) {
		return `${trimDnsName(name)}|${type}`
	}

	set(name: string, type: DnsRecordType, values: string[]) {
		this.answers.set(
			this.key(name, type),
			values.map((data) => ({ type, data })),
		)
	}

	add(name: string, type: DnsRecordType, data: string) {
		const key = this.key(name, type)
		this.answers.set(key, [...(this.answers.get(key) ?? []), { type, data }])
	}

	remove(name: string, type: DnsRecordType, data?: string) {
		const key = this.key(name, type)
		if (data === undefined) {
			this.answers.delete(key)
			return
		}
		this.answers.set(
			key,
			(this.answers.get(key) ?? []).filter(
				(answer) => trimDnsName(answer.data) !== trimDnsName(data),
			),
		)
	}

	clear() {
		this.answers.clear()
	}

	resolver: DnsResolver = async (name, type) =>
		this.answers.get(this.key(name, type)) ?? []
}

const mockPublicDns = new MockPublicDns()

export function getMockPublicDns() {
	return mockPublicDns
}

let override: DnsResolver | null = null
let defaultResolver: DnsResolver | null = null

/** Tests swap the resolver; `null` restores the default. */
export function setDnsResolver(resolver: DnsResolver | null) {
	override = resolver
}

export function getDnsResolver(): DnsResolver {
	if (override) return override
	if (isDomainsMock()) return mockPublicDns.resolver
	defaultResolver ??= createDohResolver()
	return defaultResolver
}

export async function lookupMany(
	resolver: DnsResolver,
	name: string,
	types: DnsRecordType[],
) {
	const results = await Promise.all(types.map((type) => resolver(name, type)))
	return Object.fromEntries(
		types.map((type, i) => [type, results[i]!]),
	) as Record<DnsRecordType, DnsAnswer[]>
}

const data = (answers: DnsAnswer[]) =>
	answers.map((answer) => trimDnsName(answer.data))

export async function lookupTxt(resolver: DnsResolver, name: string) {
	return (await resolver(name, 'TXT')).map((answer) =>
		parseTxtAnswer(answer.data),
	)
}

export async function lookupMx(
	resolver: DnsResolver,
	name: string,
): Promise<MxRecord[]> {
	return (await resolver(name, 'MX'))
		.map((answer) => parseMxAnswer(answer.data))
		.filter((record): record is MxRecord => record !== null)
}

/**
 * The nameservers of the registrable domain of `hostname`. Resolvers answer NS
 * at the apex only, so a subdomain is looked up through its apex.
 */
export async function lookupNameservers(
	resolver: DnsResolver,
	hostname: string,
): Promise<string[]> {
	const apex = describeHostname(hostname)?.apex ?? hostname
	return data(await resolver(apex, 'NS')).sort()
}

/** Everything the per-host checklist compares (see `evaluateChecklist`). */
export async function fetchHostAnswers(input: {
	resolver: DnsResolver
	hostname: string
	cnameTarget: string
	/** Other names whose TXT or CNAME the checklist needs (ownership, certificate). */
	extraNames?: string[]
}): Promise<HostAnswers> {
	const { resolver, hostname } = input
	const [own, target] = await Promise.all([
		lookupMany(resolver, hostname, ['A', 'AAAA', 'CNAME']),
		lookupMany(resolver, input.cnameTarget, ['A', 'AAAA']),
	])
	const txt: Record<string, string[]> = {}
	const cnameOf: Record<string, string[]> = {}
	await Promise.all(
		(input.extraNames ?? []).map(async (name) => {
			const key = trimDnsName(name)
			const [txtValues, cnames] = await Promise.all([
				lookupTxt(resolver, key),
				resolver(key, 'CNAME'),
			])
			txt[key] = txtValues
			cnameOf[key] = data(cnames)
		}),
	)
	return {
		cname: data(own.CNAME),
		a: data(own.A),
		aaaa: data(own.AAAA),
		txt,
		cnameOf,
		targetA: data(target.A),
		targetAaaa: data(target.AAAA),
	}
}
