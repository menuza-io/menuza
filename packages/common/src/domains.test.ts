import { describe, expect, it } from 'vitest'
import {
	describeHostname,
	hostsForConnect,
	isDomainLive,
	isReservedHostname,
	normalizeHostname,
	parseHostname,
	siblingHostname,
} from './domains.ts'

describe('normalizeHostname', () => {
	it.each([
		['Example.COM', 'example.com'],
		['https://www.Example.com/menu?a=1#x', 'www.example.com'],
		['http://example.com:8080/', 'example.com'],
		['example.com.', 'example.com'],
		['  www.example.com  ', 'www.example.com'],
		['user:pw@example.com', 'example.com'],
		['bücher.example', 'xn--bcher-kva.example'],
		['مطعم.com', 'xn--2gbe8ac.com'],
	])('%s -> %s', (input, expected) => {
		expect(normalizeHostname(input)).toBe(expected)
	})

	it('returns an empty string for input that is not a host', () => {
		expect(normalizeHostname('')).toBe('')
		expect(normalizeHostname('https://')).toBe('')
		expect(normalizeHostname('bad host.com')).toBe('')
	})
})

describe('parseHostname', () => {
	it('accepts normal hosts, subdomains and country suffixes', () => {
		for (const host of [
			'example.com',
			'www.example.co.uk',
			'order.alrestaurant.com.sa',
		]) {
			expect(parseHostname(host)).toEqual({ ok: true, hostname: host })
		}
	})

	it('rejects empties, IPs, single labels and bare suffixes', () => {
		expect(parseHostname('')).toEqual({ ok: false, error: 'empty' })
		expect(parseHostname('10.0.0.1')).toEqual({
			ok: false,
			error: 'ip_address',
		})
		expect(parseHostname('[::1]')).toEqual({ ok: false, error: 'ip_address' })
		expect(parseHostname('localhost')).toEqual({ ok: false, error: 'invalid' })
		expect(parseHostname('co.uk')).toEqual({
			ok: false,
			error: 'no_registrable_domain',
		})
		expect(parseHostname('a..com').ok).toBe(false)
		expect(parseHostname('-bad.com').ok).toBe(false)
		expect(parseHostname(`${'a'.repeat(64)}.com`).ok).toBe(false)
	})
})

describe('describeHostname', () => {
	it('splits registrable domain, subdomain and role', () => {
		expect(describeHostname('example.com')).toMatchObject({
			apex: 'example.com',
			subdomain: null,
			role: 'apex',
		})
		expect(describeHostname('www.example.co.uk')).toMatchObject({
			apex: 'example.co.uk',
			subdomain: 'www',
			role: 'www',
		})
		expect(describeHostname('order.eu.example.com')).toMatchObject({
			apex: 'example.com',
			subdomain: 'order.eu',
			role: 'subdomain',
		})
	})
})

describe('hostsForConnect', () => {
	it('sets up both forms with the chosen primary', () => {
		expect(hostsForConnect('example.com', 'www')).toEqual({
			primary: 'www.example.com',
			redirects: ['example.com'],
		})
		expect(hostsForConnect('www.example.com', 'apex')).toEqual({
			primary: 'example.com',
			redirects: ['www.example.com'],
		})
	})

	it('connects another subdomain as itself', () => {
		expect(hostsForConnect('order.example.com', 'www')).toEqual({
			primary: 'order.example.com',
			redirects: [],
		})
	})
})

describe('siblingHostname', () => {
	it('swaps apex and www only', () => {
		expect(siblingHostname('example.com')).toBe('www.example.com')
		expect(siblingHostname('www.example.com')).toBe('example.com')
		expect(siblingHostname('order.example.com')).toBeNull()
	})
})

describe('isReservedHostname', () => {
	const platform = ['menuza.io', 'menuza.test']
	it('refuses the platform domain and every subdomain of it', () => {
		expect(isReservedHostname('menuza.io', platform)).toBe(true)
		expect(isReservedHostname('acme.menuza.io', platform)).toBe(true)
		expect(isReservedHostname('app.menuza.test', platform)).toBe(true)
	})
	it('refuses names that are not public', () => {
		expect(isReservedHostname('shop.local', platform)).toBe(true)
		expect(isReservedHostname('thing.internal', platform)).toBe(true)
	})
	it('allows other hosts, including look-alikes', () => {
		expect(isReservedHostname('alrestaurant.com', platform)).toBe(false)
		expect(isReservedHostname('notmenuza.io', platform)).toBe(false)
	})
})

describe('isDomainLive', () => {
	it('needs an active host and an active certificate', () => {
		expect(isDomainLive({ status: 'active', sslStatus: 'active' })).toBe(true)
		expect(isDomainLive({ status: 'active', sslStatus: null })).toBe(true)
		expect(
			isDomainLive({ status: 'active', sslStatus: 'pending_validation' }),
		).toBe(false)
		expect(isDomainLive({ status: 'pending', sslStatus: 'active' })).toBe(false)
	})
})
