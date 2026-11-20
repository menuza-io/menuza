import { describe, expect, it } from 'vitest'
import {
	analyzeMail,
	analyzeWebsite,
	buildHostChecklist,
	checklistComplete,
	evaluateChecklist,
	findAcmeLeftovers,
	parseMxAnswer,
	parseTxtAnswer,
	type HostAnswers,
} from './domain-dns.ts'

const empty: HostAnswers = {
	cname: [],
	a: [],
	aaaa: [],
	txt: {},
	cnameOf: {},
	targetA: ['198.51.100.7'],
	targetAaaa: [],
}

describe('host checklist', () => {
	const ownership = {
		type: 'txt',
		name: '_cf-custom-hostname.www.example.com',
		value: 'abc-123',
	}

	it('asks www for a CNAME and the root for an ALIAS with A fallbacks', () => {
		const www = buildHostChecklist({
			hostname: 'www.example.com',
			role: 'www',
			cnameTarget: 'sites.menuza.io',
			ownership,
		})
		expect(www.map((r) => [r.kind, r.type, r.name, r.value])).toEqual([
			['route', 'CNAME', 'www.example.com', 'sites.menuza.io'],
			['ownership', 'TXT', '_cf-custom-hostname.www.example.com', 'abc-123'],
		])
		const root = buildHostChecklist({
			hostname: 'example.com',
			role: 'apex',
			cnameTarget: 'sites.menuza.io',
			apexIps: { a: ['192.0.2.1'], aaaa: ['2001:db8::1'] },
		})
		expect(root).toHaveLength(1)
		expect(root[0]).toMatchObject({ type: 'ALIAS', value: 'sites.menuza.io' })
		expect(root[0]!.alternatives).toEqual([
			{ type: 'A', name: 'example.com', values: ['192.0.2.1'] },
			{ type: 'AAAA', name: 'example.com', values: ['2001:db8::1'] },
		])
	})

	it('reports each record as found, missing or mismatched', () => {
		const input = {
			hostname: 'www.example.com',
			role: 'www' as const,
			cnameTarget: 'sites.menuza.io',
			ownership,
		}
		const records = buildHostChecklist(input)

		const none = evaluateChecklist(records, input, empty)
		expect(none.map((r) => r.check)).toEqual(['missing', 'missing'])
		expect(checklistComplete(records, none)).toBe(false)

		const elsewhere = evaluateChecklist(records, input, {
			...empty,
			cname: ['shops.wixdns.net.'],
		})
		expect(elsewhere[0]).toEqual({
			id: 'route',
			check: 'mismatch',
			current: ['shops.wixdns.net'],
		})

		const done = evaluateChecklist(records, input, {
			...empty,
			cname: ['Sites.Menuza.io.'],
			txt: { '_cf-custom-hostname.www.example.com': ['abc-123'] },
		})
		expect(done.map((r) => r.check)).toEqual(['found', 'found'])
		expect(checklistComplete(records, done)).toBe(true)
	})

	it('accepts a flattened or proxied root that answers with our addresses', () => {
		const input = {
			hostname: 'example.com',
			role: 'apex' as const,
			cnameTarget: 'sites.menuza.io',
		}
		const records = buildHostChecklist(input)
		expect(
			evaluateChecklist(records, input, { ...empty, a: ['198.51.100.7'] })[0]!
				.check,
		).toBe('found')
		expect(
			evaluateChecklist(records, input, { ...empty, a: ['203.0.113.9'] })[0]!
				.check,
		).toBe('mismatch')
		expect(evaluateChecklist(records, input, empty)[0]!.check).toBe('missing')
	})

	it('does not need the optional ownership record to be complete', () => {
		const input = {
			hostname: 'www.example.com',
			role: 'www' as const,
			cnameTarget: 'sites.menuza.io',
			ownership,
		}
		const records = buildHostChecklist(input)
		const results = evaluateChecklist(records, input, {
			...empty,
			cname: ['sites.menuza.io'],
		})
		expect(results[1]!.check).toBe('missing')
		expect(checklistComplete(records, results)).toBe(true)
	})
})

describe('analyzeMail', () => {
	it('finds mail from MX records, names the provider and lists records to keep', () => {
		const findings = analyzeMail(
			{
				mx: [
					{ priority: 10, host: 'alt1.aspmx.l.google.com' },
					{ priority: 1, host: 'aspmx.l.google.com' },
				],
				apexTxt: [
					'v=spf1 include:_spf.google.com ~all',
					'google-site-verification=abc',
				],
				dmarcTxt: ['v=DMARC1; p=none'],
				dkim: [
					{ selector: 'google', values: ['v=DKIM1; k=rsa; p=AAA'] },
					{ selector: 'k1', values: [] },
				],
			},
			'example.com',
		)
		expect(findings.kind).toBe('mail')
		expect(findings.provider).toEqual({
			id: 'google',
			name: 'Google Workspace',
		})
		expect(findings.mx[0]!.priority).toBe(1)
		expect(findings.recordsToKeep.map((r) => r.label).sort()).toEqual(
			['dkim', 'dmarc', 'mx', 'mx', 'spf', 'verification'].sort(),
		)
		expect(findings.recordsToKeep.find((r) => r.label === 'dkim')!.name).toBe(
			'google._domainkey.example.com',
		)
	})

	it('flags mail records with no MX, and reports none for a clean domain', () => {
		expect(
			analyzeMail(
				{ mx: [], apexTxt: ['v=spf1 -all'], dmarcTxt: [], dkim: [] },
				'example.com',
			).kind,
		).toBe('records_only')
		expect(
			analyzeMail(
				{ mx: [], apexTxt: ['hello'], dmarcTxt: [], dkim: [] },
				'example.com',
			).kind,
		).toBe('none')
	})
})

describe('analyzeWebsite and leftovers', () => {
	it('detects a website builder from where www points', () => {
		const result = analyzeWebsite({
			apexA: ['198.51.100.1'],
			apexAaaa: [],
			apexCname: [],
			wwwA: [],
			wwwCname: ['ext-cust.squarespace.com.'],
			cnameTarget: 'sites.menuza.io',
		})
		expect(result.hasWebsite).toBe(true)
		expect(result.builder).toBe('Squarespace')
	})

	it('ignores records that already point at us', () => {
		const result = analyzeWebsite({
			apexA: [],
			apexAaaa: [],
			apexCname: [],
			wwwA: [],
			wwwCname: ['sites.menuza.io'],
			cnameTarget: 'sites.menuza.io',
		})
		expect(result.hasWebsite).toBe(false)
	})

	it('lists certificate-challenge leftovers', () => {
		expect(
			findAcmeLeftovers({
				hostname: 'www.example.com',
				challengeTxt: ['token'],
				challengeCname: ['x.acme.provider.com.'],
			}),
		).toEqual([
			'TXT _acme-challenge.www.example.com token',
			'CNAME _acme-challenge.www.example.com x.acme.provider.com',
		])
	})
})

describe('answer parsers', () => {
	it('parses MX and joins split TXT strings', () => {
		expect(parseMxAnswer('10 mx.example.com.')).toEqual({
			priority: 10,
			host: 'mx.example.com',
		})
		expect(parseMxAnswer('nonsense')).toBeNull()
		expect(parseTxtAnswer('"v=spf1 include:a" " include:b ~all"')).toBe(
			'v=spf1 include:a include:b ~all',
		)
	})
})
