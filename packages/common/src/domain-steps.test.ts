import { describe, expect, it } from 'vitest'
import { buildHostChecklist } from './domain-dns.ts'
import { getDomainProvider, GENERIC_PROVIDER } from './domain-providers.ts'
import {
	buildProviderSteps,
	entriesFor,
	renderStepsEnglish,
} from './domain-steps.ts'

const domain = 'example.com'
const records = [
	...buildHostChecklist({
		hostname: 'www.example.com',
		role: 'www',
		cnameTarget: 'sites.menuza.io',
	}),
	...buildHostChecklist({
		hostname: 'example.com',
		role: 'apex',
		cnameTarget: 'sites.menuza.io',
		apexIps: { a: ['192.0.2.1'], aaaa: [] },
	}),
]

describe('provider steps', () => {
	it('uses the provider own words and its root marker', () => {
		const steps = buildProviderSteps(
			getDomainProvider('godaddy'),
			records,
			domain,
		)
		const text = renderStepsEnglish(steps).join('\n')
		expect(text).toContain('Sign in to GoDaddy')
		expect(text).toContain('My Products > Domains > DNS')
		expect(text).toContain('"Add New Record"')
		// GoDaddy has no ALIAS at the root: A records, host @.
		expect(text).toContain('Type: A, Name: @, Data: 192.0.2.1')
		expect(text).toContain('Type: CNAME, Name: www, Data: sites.menuza.io')
		expect(text).toContain('Do not change or delete any MX or TXT records')
	})

	it('offers ALIAS where the provider flattens the root, with the A fallback beside it', () => {
		const { entries, fallbacks } = entriesFor(
			getDomainProvider('namecheap'),
			records,
			domain,
		)
		expect(entries.map((e) => `${e.type} ${e.host}`)).toEqual([
			'CNAME www',
			'ALIAS @',
		])
		expect(fallbacks.map((e) => `${e.type} ${e.value}`)).toEqual([
			'A 192.0.2.1',
		])
	})

	it('writes a provider with a blank root field and extra notes', () => {
		const route53 = renderStepsEnglish(
			buildProviderSteps(getDomainProvider('route53'), records, domain),
		).join('\n')
		expect(route53).toContain('Record name: (leave empty)')
		const cloudflare = renderStepsEnglish(
			buildProviderSteps(getDomainProvider('cloudflare'), records, domain),
		).join('\n')
		expect(cloudflare).toContain('DNS only')
	})

	it('gives unknown providers the generic steps', () => {
		const text = renderStepsEnglish(
			buildProviderSteps(GENERIC_PROVIDER, records, domain),
		).join('\n')
		expect(text).not.toContain('Sign in to')
		expect(text).toContain('Type: CNAME, Host: www, Value: sites.menuza.io')
		expect(text).toContain('Type: A, Host: @, Value: 192.0.2.1')
	})
})
