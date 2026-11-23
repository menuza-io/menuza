import { describe, expect, it } from 'vitest'
import {
	SUPPORT_CONTEXT_KEYS,
	buildSupportContext,
	createSupportRequestSchema,
	isUnreadFor,
	parseStoredSupportContext,
	sanitizeSupportPath,
	statusAfterMessage,
	supportContextSchema,
} from './support-requests.ts'

describe('support request context', () => {
	it('is exactly the allowlist: restaurant, location, page, version and error id', () => {
		expect([...SUPPORT_CONTEXT_KEYS]).toEqual([
			'organizationId',
			'organizationSlug',
			'locationId',
			'path',
			'appVersion',
			'errorId',
		])
	})

	it('refuses any key outside the allowlist, so a guest field cannot ride along', () => {
		for (const key of [
			'guestName',
			'name',
			'phone',
			'email',
			'customerEmail',
			'orderItems',
			'address',
		]) {
			expect(
				supportContextSchema.safeParse({ organizationId: 'org1', [key]: 'x' })
					.success,
			).toBe(false)
		}
	})

	it('keeps only the path: a query or fragment can hold a guest name or a token', () => {
		expect(
			sanitizeSupportPath(
				'/acme/customers?search=Jane%20Doe&phone=%2B15551234567#token=abc',
			),
		).toBe('/acme/customers')
		const context = buildSupportContext({
			organizationId: 'org1',
			organizationSlug: 'acme',
			path: '/acme/orders?email=a@b.co',
			errorId: 'a1b2c3d4e5f6a7b8',
		})
		expect(JSON.stringify(context)).not.toContain('a@b.co')
		expect(Object.keys(context).sort()).toEqual(
			['errorId', 'organizationId', 'organizationSlug', 'path'].sort(),
		)
	})

	it('drops unknown keys when a stored context is read back', () => {
		expect(
			parseStoredSupportContext(
				JSON.stringify({
					organizationId: 'o',
					path: '/x',
					guestPhone: '+1555',
				}),
			),
		).toEqual({ organizationId: 'o', path: '/x' })
		expect(parseStoredSupportContext('not json')).toEqual({})
	})

	it('refuses a request body with an extra field', () => {
		expect(
			createSupportRequestSchema.safeParse({
				kind: 'support',
				message: 'Help',
				organizationSlug: 'acme',
				guestName: 'Jane',
			}).success,
		).toBe(false)
	})
})

describe('status and unread', () => {
	it('support writing waits on the member, the member writing reopens', () => {
		expect(statusAfterMessage('support', 'open')).toBe('waiting_on_you')
		expect(statusAfterMessage('member', 'waiting_on_you')).toBe('open')
		expect(statusAfterMessage('member', 'closed')).toBe('open')
		expect(statusAfterMessage('support', 'closed')).toBe('closed')
	})

	it('is unread for the side that did not write last and has not read since', () => {
		const base = {
			kind: 'support',
			status: 'open',
			lastMessageAt: new Date(2000),
			lastMessageSide: 'support',
			memberReadAt: null,
			supportReadAt: null,
		}
		expect(isUnreadFor('member', base)).toBe(true)
		expect(isUnreadFor('support', base)).toBe(false)
		expect(
			isUnreadFor('member', { ...base, memberReadAt: new Date(3000) }),
		).toBe(false)
		expect(
			isUnreadFor('member', { ...base, memberReadAt: new Date(1000) }),
		).toBe(true)
		expect(isUnreadFor('member', { ...base, kind: 'feedback' })).toBe(false)
	})
})
