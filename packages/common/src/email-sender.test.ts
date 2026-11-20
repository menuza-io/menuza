import { describe, expect, it } from 'vitest'
import {
	isPlainEmailAddress,
	isValidSenderDomain,
	isValidSenderLocalPart,
	resolveSender,
	safeDisplayName,
	validateSenderName,
} from './email-sender.ts'

describe('validateSenderName', () => {
	it('accepts a plain name and treats empty as "use the organization name"', () => {
		expect(validateSenderName('  Al   Bait Pizza ')).toEqual({
			ok: true,
			value: 'Al Bait Pizza',
		})
		expect(validateSenderName('')).toEqual({ ok: true, value: null })
		expect(validateSenderName(null)).toEqual({ ok: true, value: null })
		expect(validateSenderName('مطعم البيت')).toEqual({
			ok: true,
			value: 'مطعم البيت',
		})
	})

	it('allows 64 characters and no more', () => {
		expect(validateSenderName('a'.repeat(64)).ok).toBe(true)
		expect(validateSenderName('a'.repeat(65))).toEqual({
			ok: false,
			code: 'invalid_sender_name',
		})
	})

	it.each([
		'Acme <evil@example.com>',
		'evil@example.com',
		'Acme>',
		'Acme\nBcc: x@y.com',
		'Acme\r\nSubject: hi',
		'Acme\u2028Bcc: x@y.com',
		'Acme\u0085',
		'Acme\u0000',
		'Acme "quoted"',
		'Acme, Inc',
		'Acme; drop',
		'Acme\\',
	])('rejects the header-injection attempt %j', (name) => {
		expect(validateSenderName(name)).toEqual({
			ok: false,
			code: 'invalid_sender_name',
		})
	})
})

describe('safeDisplayName', () => {
	it('strips anything that could end the name or the header, whatever was stored', () => {
		expect(safeDisplayName('Acme\r\nBcc: x@y.com')).toBe('Acme Bcc x y.com')
		expect(safeDisplayName('Al <Bait>')).toBe('Al Bait')
		expect(safeDisplayName('"""', 'Menuza')).toBe('Menuza')
		expect(safeDisplayName(null, 'Menuza')).toBe('Menuza')
		expect(safeDisplayName('a'.repeat(100)).length).toBe(64)
	})
})

describe('local parts, addresses and domains', () => {
	it('checks the local part of the sending address', () => {
		for (const ok of ['hello', 'orders', 'a.b', 'team-1'])
			expect(isValidSenderLocalPart(ok)).toBe(true)
		for (const bad of ['', '.a', 'a..b', 'a b', 'A', 'a@b', 'x'.repeat(65)])
			expect(isValidSenderLocalPart(bad)).toBe(false)
	})

	it('accepts a single plain address only', () => {
		expect(isPlainEmailAddress('owner@alrestaurant.com')).toBe(true)
		for (const bad of [
			'a@b',
			'Name <a@b.com>',
			'a@b.com, c@d.com',
			'a@b.com\nBcc: x@y.com',
			'(c)a@b.com',
			'',
		]) {
			expect(isPlainEmailAddress(bad)).toBe(false)
		}
	})

	it('accepts a plain domain', () => {
		expect(isValidSenderDomain('acmepizza.com')).toBe(true)
		expect(isValidSenderDomain('mail.acmepizza.co.uk')).toBe(true)
		expect(isValidSenderDomain('acme')).toBe(false)
		expect(isValidSenderDomain('-bad.com')).toBe(false)
	})
})

describe('resolveSender', () => {
	const platform = { email: 'noreply@menuza.io', name: 'Menuza' }

	it('shows the organization name and reply-to on the platform address until the domain is verified', () => {
		expect(
			resolveSender({
				identity: {
					senderName: null,
					replyTo: 'owner@alrestaurant.com',
					fromEmail: null,
				},
				organizationName: 'Al Bait',
				platform,
			}),
		).toEqual({
			sender: { email: 'noreply@menuza.io', name: 'Al Bait' },
			replyTo: { email: 'owner@alrestaurant.com' },
			customDomain: false,
		})
	})

	it('uses the chosen sender name, and the own domain once verified', () => {
		expect(
			resolveSender({
				identity: {
					senderName: 'Acme Pizza',
					replyTo: null,
					fromEmail: 'hello@acmepizza.com',
				},
				organizationName: 'Al Bait',
				platform,
			}),
		).toEqual({
			sender: { email: 'hello@acmepizza.com', name: 'Acme Pizza' },
			replyTo: null,
			customDomain: true,
		})
	})

	it('falls back to the platform sender when nothing is known, and ignores unsafe values', () => {
		expect(
			resolveSender({ identity: null, organizationName: null, platform }),
		).toEqual({
			sender: platform,
			replyTo: null,
			customDomain: false,
		})
		const odd = resolveSender({
			identity: {
				senderName: 'X\r\nBcc: a@b.com',
				replyTo: 'a@b.com\nBcc: c@d.com',
				fromEmail: 'x@y.com\nBcc: z@z.com',
			},
			organizationName: null,
			platform,
		})
		expect(odd.sender.email).toBe('noreply@menuza.io')
		expect(odd.sender.name).not.toMatch(/[\r\n<>@]/u)
		expect(odd.replyTo).toBeNull()
	})
})
