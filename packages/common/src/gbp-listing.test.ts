import { describe, expect, it } from 'vitest'
import {
	canRequestPostcard,
	deriveAttributes,
	descriptionProblems,
	gbpErrorFromResponse,
	heldFieldsWhilePending,
	orderLinkShouldBeRemoved,
	shouldPushField,
	suggestAttributeChanges,
	verificationGuide,
} from './gbp-listing.ts'

const now = new Date('2026-12-20T12:00:00Z')
const minutesAgo = (minutes: number) =>
	new Date(now.getTime() - minutes * 60_000)

describe('orderLinkShouldBeRemoved', () => {
	it('leaves Google alone for a 10 minute pause', () => {
		expect(
			orderLinkShouldBeRemoved(
				{
					orderingPausedAt: minutesAgo(10),
					orderingPausedUntil: new Date(now.getTime() + 20 * 60_000),
				},
				now,
			),
		).toBe(false)
		expect(
			orderLinkShouldBeRemoved(
				{ orderingPausedAt: minutesAgo(10), orderingPausedUntil: null },
				now,
			),
		).toBe(false)
	})
	it('removes the link once a pause has lasted past the threshold', () => {
		expect(
			orderLinkShouldBeRemoved(
				{ orderingPausedAt: minutesAgo(90), orderingPausedUntil: null },
				now,
			),
		).toBe(true)
	})
	it('removes it at once for a pause planned to last longer than the threshold', () => {
		expect(
			orderLinkShouldBeRemoved(
				{
					orderingPausedAt: minutesAgo(1),
					orderingPausedUntil: new Date(now.getTime() + 4 * 3600_000),
				},
				now,
			),
		).toBe(true)
	})
	it('restores it when ordering resumes or the pause ends', () => {
		expect(
			orderLinkShouldBeRemoved(
				{ orderingPausedAt: null, orderingPausedUntil: null },
				now,
			),
		).toBe(false)
		expect(
			orderLinkShouldBeRemoved(
				{
					orderingPausedAt: minutesAgo(200),
					orderingPausedUntil: minutesAgo(5),
				},
				now,
			),
		).toBe(false)
	})
	it('never removes it for a pause planned to be short', () => {
		expect(
			orderLinkShouldBeRemoved(
				{
					orderingPausedAt: minutesAgo(90),
					orderingPausedUntil: new Date(
						minutesAgo(90).getTime() + 30 * 60_000 + 3 * 3600_000,
					),
				},
				now,
			),
		).toBe(true)
		expect(
			orderLinkShouldBeRemoved(
				{
					orderingPausedAt: minutesAgo(90),
					orderingPausedUntil: new Date(minutesAgo(90).getTime() + 30 * 60_000),
				},
				now,
			),
		).toBe(false)
	})
})

describe('quota: the same field is not retried within an hour', () => {
	const attempt = (status: string, ago: number, fp = 'abc') => ({
		friday: {
			fingerprint: fp,
			attemptedAt: minutesAgo(ago).toISOString(),
			status,
		},
	})
	it('sends a never-sent field and a changed value at once', () => {
		expect(shouldPushField({}, 'friday', 'abc', now)).toBe(true)
		expect(shouldPushField(attempt('failed', 1), 'friday', 'new', now)).toBe(
			true,
		)
	})
	it('does not resend what Google accepted or still holds for review', () => {
		expect(shouldPushField(attempt('sent', 500), 'friday', 'abc', now)).toBe(
			false,
		)
		expect(
			shouldPushField(attempt('pending_google', 500), 'friday', 'abc', now),
		).toBe(false)
	})
	it('retries a failure only after an hour and never a refusal', () => {
		expect(shouldPushField(attempt('failed', 30), 'friday', 'abc', now)).toBe(
			false,
		)
		expect(shouldPushField(attempt('failed', 61), 'friday', 'abc', now)).toBe(
			true,
		)
		expect(
			shouldPushField(attempt('rejected', 600), 'friday', 'abc', now),
		).toBe(false)
	})
})

describe('verification rules', () => {
	it('refuses a second postcard within 14 days', () => {
		expect(canRequestPostcard(null, now)).toBe(true)
		expect(
			canRequestPostcard(new Date(now.getTime() - 13 * 86_400_000), now),
		).toBe(false)
		expect(
			canRequestPostcard(new Date(now.getTime() - 14 * 86_400_000), now),
		).toBe(true)
	})
	it('holds name, address and category edits while a code is pending', () => {
		const pending = {
			verificationState: 'pending',
			verificationMethod: 'ADDRESS',
		}
		expect(
			heldFieldsWhilePending(pending, [
				'name',
				'hours',
				'address',
				'categories',
			]),
		).toEqual(['name', 'address', 'categories'])
		expect(
			heldFieldsWhilePending(
				{ verificationState: 'unverified', verificationMethod: null },
				['name'],
			),
		).toEqual([])
	})
	it('maps states to what the screen shows', () => {
		const options = [{ method: 'ADDRESS' as const, destination: '1 Main St' }]
		expect(
			verificationGuide({
				verificationState: 'verified',
				connectionState: 'ok',
				options: null,
			}).kind,
		).toBe('verified')
		expect(
			verificationGuide({
				verificationState: 'unverified',
				connectionState: 'not_verified',
				options,
			}).kind,
		).toBe('choose')
		expect(
			verificationGuide({
				verificationState: 'unverified',
				connectionState: 'not_verified',
				options: [],
			}).kind,
		).toBe('no_method')
		expect(
			verificationGuide({
				verificationState: 'pending',
				connectionState: 'not_verified',
				options,
			}).kind,
		).toBe('enter_code')
		expect(
			verificationGuide({
				verificationState: 'unverified',
				connectionState: 'not_verified',
				options,
				alreadyHasCode: true,
			}).kind,
		).toBe('enter_code')
		expect(
			verificationGuide({
				verificationState: 'unverified',
				connectionState: 'suspended',
				options,
			}).kind,
		).toBe('suspended')
		expect(
			verificationGuide({
				verificationState: 'unverified',
				connectionState: 'access_lost',
				options,
			}).kind,
		).toBe('managed_elsewhere')
	})
})

describe('error mapping', () => {
	it('maps Google failures to our codes', () => {
		expect(gbpErrorFromResponse(401).code).toBe('gbp_token_expired')
		expect(gbpErrorFromResponse(429).code).toBe('gbp_rate_limited')
		expect(
			gbpErrorFromResponse(403, { error: { message: 'Location is suspended' } })
				.code,
		).toBe('gbp_suspended')
		expect(
			gbpErrorFromResponse(403, {
				error: { message: 'The location must be verified' },
			}).code,
		).toBe('gbp_not_verified')
		expect(gbpErrorFromResponse(403).code).toBe('gbp_access_lost')
		expect(
			gbpErrorFromResponse(400, { error: { message: 'Bad phone' } }).code,
		).toBe('gbp_rejected')
		expect(gbpErrorFromResponse(500).code).toBe('gbp_api_error')
	})
})

describe('description and attributes', () => {
	it('rejects links, phone numbers and over-long text', () => {
		expect(descriptionProblems('Family run since 1998.')).toEqual([])
		expect(descriptionProblems('Visit https://acme.com today')).toContain(
			'has_link',
		)
		expect(descriptionProblems('Visit acme.com today')).toContain('has_link')
		expect(descriptionProblems('Call +1 555 010 0100')).toContain('has_phone')
		expect(descriptionProblems('x'.repeat(751))).toContain('too_long')
	})
	it('derives delivery, takeout and reservations from Menuza settings', () => {
		const derived = deriveAttributes({
			fulfillment: {
				delivery: true,
				pickup: false,
				dineIn: true,
				curbside: false,
			},
			reservationsEnabled: true,
			onlinePaymentsConnected: false,
		})
		expect(derived['attributes/has_delivery']).toBe(true)
		expect(derived['attributes/has_takeout']).toBe(false)
		expect(derived['attributes/accepts_reservations']).toBe(true)
	})
	it('suggests only differing attributes Google lists for the category', () => {
		const suggestions = suggestAttributeChanges(
			{
				'attributes/has_delivery': true,
				'attributes/has_takeout': true,
				'attributes/has_dine_in': true,
			},
			{ 'attributes/has_delivery': false, 'attributes/has_takeout': true },
			[
				{
					name: 'attributes/has_delivery',
					displayName: 'Delivery',
					valueType: 'BOOL',
				},
				{
					name: 'attributes/has_takeout',
					displayName: 'Takeout',
					valueType: 'BOOL',
				},
			],
		)
		expect(suggestions.map((s) => s.name)).toEqual(['attributes/has_delivery'])
	})
})
