import { describe, expect, it } from 'vitest'
import {
	autoResolveAt,
	callLink,
	callNeedsFollowUp,
	callNotificationEvents,
	CallFinishExtrasSchema,
	type CallFacts,
	formatStaffNotification,
	matchedNotificationEvents,
	outcomeSummary,
} from './call-report.ts'

const base: CallFacts = {
	outcome: 'resolved',
	tags: [],
	importantTagIds: ['complaint'],
	rating: null,
	sentiment: null,
	transferResult: 'none',
	voicemail: false,
	requestTypes: [],
	linkSent: false,
}

describe('call follow-up', () => {
	it('defaults every extra so older workers still parse', () => {
		expect(CallFinishExtrasSchema.parse({})).toMatchObject({
			tags: [],
			transferResult: 'none',
			notifications: null,
		})
	})

	it('leaves plain resolved calls closed', () => {
		expect(callNeedsFollowUp(base, null)).toBe(false)
		expect(callNotificationEvents(base)).toEqual(['every_call'])
	})

	it('opens calls with voicemail, missed transfers, or low ratings', () => {
		expect(callNeedsFollowUp({ ...base, voicemail: true }, null)).toBe(true)
		expect(
			callNeedsFollowUp({ ...base, transferResult: 'no_answer' }, null),
		).toBe(true)
		expect(callNeedsFollowUp({ ...base, rating: 2 }, null)).toBe(true)
		expect(callNeedsFollowUp({ ...base, rating: 4 }, null)).toBe(false)
	})

	it('keeps answered transfers open only when asked', () => {
		const facts = { ...base, transferResult: 'answered' as const }
		expect(callNeedsFollowUp(facts, { keepTransferredOpen: false })).toBe(false)
		expect(callNeedsFollowUp(facts, { keepTransferredOpen: true })).toBe(true)
		const referred = { ...base, transferResult: 'referred' as const }
		expect(callNeedsFollowUp(referred, { keepTransferredOpen: false })).toBe(
			false,
		)
		expect(callNeedsFollowUp(referred, { keepTransferredOpen: true })).toBe(
			true,
		)
	})

	it('never auto-resolves important calls', () => {
		const now = new Date('2026-01-01T00:00:00Z')
		expect(
			autoResolveAt(base, { autoResolveAfterDays: 3 }, now)?.toISOString(),
		).toBe('2026-01-04T00:00:00.000Z')
		expect(
			autoResolveAt(
				{ ...base, tags: ['complaint'] },
				{ autoResolveAfterDays: 3 },
				now,
			),
		).toBeNull()
		expect(autoResolveAt(base, { autoResolveAfterDays: 0 }, now)).toBeNull()
	})
})

describe('staff notifications', () => {
	it('matches subscribed events by urgency', () => {
		const triggered = callNotificationEvents({
			...base,
			voicemail: true,
			tags: ['complaint'],
		})
		expect(
			matchedNotificationEvents(triggered, ['voicemail', 'complaint']),
		).toEqual(['complaint', 'voicemail'])
		expect(matchedNotificationEvents(triggered, ['low_rating'])).toEqual([])
	})

	it('formats a short message and keeps the link when trimming', () => {
		const link = callLink(
			'https://app.example.com/acme/phone-agent/calls',
			'c1',
		)
		expect(link).toBe('https://app.example.com/acme/phone-agent/calls?call=c1')
		const text = formatStaffNotification({
			businessName: 'Acme',
			events: ['voicemail'],
			callerPhone: '+15551234567',
			summary: 'x'.repeat(1000),
			tags: [{ id: 'vip', name: 'VIP' }],
			callUrl: link,
			maxLength: 200,
		})
		expect(text.length).toBeLessThanOrEqual(200)
		expect(text.startsWith('Acme: New voicemail\nFrom +15551234567')).toBe(true)
		expect(text.endsWith(link!)).toBe(true)
	})

	it('alerts on texted links with the vertical headline if it has one', () => {
		const events = callNotificationEvents({ ...base, linkSent: true })
		expect(events).toContain('link_sent')
		const input = {
			businessName: 'Acme',
			events: ['link_sent'] as const,
			callerPhone: null,
			summary: null,
			tags: [],
			callUrl: null,
		}
		expect(formatStaffNotification(input)).toBe(
			'Acme: Link sent\nCaller ID hidden',
		)
		expect(
			formatStaffNotification({
				...input,
				headlines: { link_sent: 'Booking link sent' },
			}),
		).toBe('Acme: Booking link sent\nCaller ID hidden')
	})

	it('words outcomes for the call log', () => {
		expect(outcomeSummary('link_sent')).toBe('Link sent.')
		expect(outcomeSummary('link_sent', { link_sent: 'Form sent.' })).toBe(
			'Form sent.',
		)
	})
})
