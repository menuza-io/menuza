import { describe, expect, it } from 'vitest'
import {
	MANAGER_ALERT_KINDS,
	MANAGER_ALERT_PERMISSIONS,
	STAFF_OUTBOX_KINDS,
	managerAlertPath,
} from './clock-ops.ts'
import {
	MAX_NOTICE_SHIFT_IDS,
	SELF_STAFF_ID,
	formatScheduleLinkToken,
	isSchedulePublishedPayload,
	parseScheduleLinkFragment,
	parseScheduleLinkToken,
	resendSchema,
	scheduleLinkFragment,
	scheduleLinkHashMessage,
	scheduleLinkSecretMessage,
	scheduleNoticeKey,
	scheduleNoticePrefix,
	scheduleNoticeRound,
	scheduleRecipients,
	selfAvailabilitySchema,
	selfRangeQuerySchema,
	selfShiftRequestSchema,
	selfTimeOffSchema,
	type PublishedChange,
} from './schedule-publish.ts'

const SECRET = 'a'.repeat(64)

describe('schedule link token', () => {
	it('round trips and keeps the organization in the clear', () => {
		const token = formatScheduleLinkToken('org_1', 'link-0001', SECRET)
		expect(token).toBe(`slk1.org_1.link-0001.${SECRET}`)
		expect(parseScheduleLinkToken(token)).toEqual({
			orgId: 'org_1',
			linkId: 'link-0001',
			secret: SECRET,
		})
	})

	it.each([
		['not a string', 42],
		['empty', ''],
		['wrong prefix', `slk2.org_1.link-0001.${SECRET}`],
		['kiosk secret shape', `kdv1.org_1.link-0001.${SECRET}`],
		['short secret', 'slk1.org_1.link-0001.abc'],
		['upper case secret', `slk1.org_1.link-0001.${'A'.repeat(64)}`],
		['path injection in the org', `slk1.../x.link-0001.${SECRET}`],
		['extra part', `slk1.org_1.link-0001.${SECRET}.x`],
		['very long', `slk1.org_1.link-0001.${SECRET}${'a'.repeat(400)}`],
	])('rejects %s', (_label, value) => {
		expect(parseScheduleLinkToken(value)).toBeNull()
	})

	it('refuses to format parts that would not parse back', () => {
		expect(() => formatScheduleLinkToken('a.b', 'link-0001', SECRET)).toThrow()
		expect(() => formatScheduleLinkToken('org', 'x', SECRET)).toThrow()
		expect(() => formatScheduleLinkToken('org', 'link-0001', 'zz')).toThrow()
	})

	it('derives distinct secrets and hashes per person, link and organization', () => {
		const a = scheduleLinkSecretMessage('o', 'l', 's1')
		expect(a).not.toBe(scheduleLinkSecretMessage('o', 'l', 's2'))
		expect(a).not.toBe(scheduleLinkSecretMessage('o', 'l2', 's1'))
		expect(a).not.toBe(scheduleLinkSecretMessage('o2', 'l', 's1'))
		// The stored-hash message can never equal a derivation message.
		expect(scheduleLinkHashMessage(a)).not.toBe(a)
		expect(scheduleLinkHashMessage('t')).toBe('schedule-link:t')
	})

	it('carries the token in the fragment, not the query', () => {
		const token = formatScheduleLinkToken('org_1', 'link-0001', SECRET)
		const fragment = scheduleLinkFragment('ksa', token)
		expect(fragment.startsWith('#')).toBe(true)
		expect(fragment).not.toContain('?')
		expect(parseScheduleLinkFragment(fragment)).toEqual({
			region: 'ksa',
			token,
		})
		expect(parseScheduleLinkFragment(fragment.slice(1))).toEqual({
			region: 'ksa',
			token,
		})
	})

	it.each([
		'',
		'#',
		'#r=eu&t=x',
		`#r=us`,
		'#r=us&t=not-a-token',
		`#t=${formatScheduleLinkToken('o', 'link-0001', SECRET)}`,
		`#${'x'.repeat(500)}`,
	])('ignores a malformed fragment (%s)', (hash) => {
		expect(parseScheduleLinkFragment(hash)).toBeNull()
	})
})

const change = (
	shiftId: string,
	kind: PublishedChange['kind'],
	staffId: string | null,
	previousStaffId?: string | null,
): PublishedChange => ({
	shiftId,
	kind,
	staffId,
	...(previousStaffId !== undefined ? { previousStaffId } : {}),
})

describe('scheduleRecipients', () => {
	const changes = [
		change('s1', 'created', 'ana'),
		change('s2', 'changed', 'ben', 'ana'),
		change('s3', 'cancelled', 'cy'),
		change('s4', 'created', null),
		change('s5', 'changed', null, 'dee'),
	]

	it('tells nobody in nobody mode', () => {
		expect(
			scheduleRecipients({
				mode: 'nobody',
				changes,
				liveStaffIds: ['ana', 'ben'],
			}),
		).toEqual([])
	})

	it('tells only people with a change in changed mode, including who lost a shift', () => {
		const out = scheduleRecipients({
			mode: 'changed',
			changes,
			liveStaffIds: ['ana', 'ben', 'zed'],
		})
		expect(out.map((r) => r.staffId)).toEqual(['ana', 'ben', 'cy', 'dee'])
		expect(out.find((r) => r.staffId === 'ana')).toMatchObject({
			changedShiftIds: ['s1'],
			removedShiftIds: ['s2'],
			hasShifts: true,
		})
		expect(out.find((r) => r.staffId === 'ben')).toMatchObject({
			changedShiftIds: ['s2'],
			removedShiftIds: [],
		})
		expect(out.find((r) => r.staffId === 'cy')).toMatchObject({
			changedShiftIds: [],
			removedShiftIds: ['s3'],
			hasShifts: false,
		})
		// zed works but nothing of theirs changed: not told in changed mode.
		expect(out.map((r) => r.staffId)).not.toContain('zed')
	})

	it('adds everyone who works that week in everyone mode', () => {
		const out = scheduleRecipients({
			mode: 'everyone',
			changes,
			liveStaffIds: ['ana', 'ben', 'zed'],
		})
		expect(out.map((r) => r.staffId)).toEqual([
			'ana',
			'ben',
			'cy',
			'dee',
			'zed',
		])
		expect(out.find((r) => r.staffId === 'zed')).toMatchObject({
			changedShiftIds: [],
			removedShiftIds: [],
			hasShifts: true,
		})
	})

	it('never notifies for an open shift and never lists someone twice', () => {
		const out = scheduleRecipients({
			mode: 'everyone',
			changes: [change('x', 'created', null), change('y', 'created', 'ana')],
			liveStaffIds: ['ana', 'ana'],
		})
		expect(out.map((r) => r.staffId)).toEqual(['ana'])
	})

	it('does not tell a person they lost a shift they still hold', () => {
		const out = scheduleRecipients({
			mode: 'changed',
			changes: [change('s', 'changed', 'ana', 'ana')],
			liveStaffIds: ['ana'],
		})
		expect(out).toEqual([
			{
				staffId: 'ana',
				changedShiftIds: ['s'],
				removedShiftIds: [],
				hasShifts: true,
			},
		])
	})

	it('caps the shift ids carried per person', () => {
		const many = Array.from({ length: 200 }, (_, i) =>
			change(`s${i}`, 'created', 'ana'),
		)
		const [only] = scheduleRecipients({
			mode: 'changed',
			changes: many,
			liveStaffIds: ['ana'],
		})
		expect(only!.changedShiftIds).toHaveLength(MAX_NOTICE_SHIFT_IDS)
	})

	it('is deterministic regardless of the order of changes', () => {
		const a = scheduleRecipients({
			mode: 'changed',
			changes,
			liveStaffIds: [],
		})
		const b = scheduleRecipients({
			mode: 'changed',
			changes: [...changes].reverse(),
			liveStaffIds: [],
		})
		expect(b.map((r) => r.staffId)).toEqual(a.map((r) => r.staffId))
	})
})

describe('notice keys and payload', () => {
	it('keys one message per publication, person and round', () => {
		expect(scheduleNoticeKey('p1', 's1', 0)).toBe('schedule_published:p1:s1:0')
		expect(
			scheduleNoticeKey('p1', 's1', 2).startsWith(scheduleNoticePrefix('p1')),
		).toBe(true)
		expect(
			scheduleNoticeKey('p10', 's1', 0).startsWith(scheduleNoticePrefix('p1')),
		).toBe(false)
		expect(scheduleNoticeRound(scheduleNoticeKey('p1', 's1', 3))).toBe(3)
		expect(scheduleNoticeRound('garbage')).toBe(0)
		expect(scheduleNoticeRound('a:b:c:-1')).toBe(0)
	})

	it('recognizes only a well formed payload', () => {
		const payload = {
			publicationId: 'p',
			scopeId: 'l',
			weekStart: '2026-03-02',
			version: 1,
			mode: 'changed',
			changedShiftIds: [],
			removedShiftIds: [],
		}
		expect(isSchedulePublishedPayload(payload)).toBe(true)
		expect(isSchedulePublishedPayload({ ...payload, version: '1' })).toBe(false)
		expect(isSchedulePublishedPayload(null)).toBe(false)
		expect(isSchedulePublishedPayload({})).toBe(false)
	})

	it('knows the new outbox and alert kinds', () => {
		expect(STAFF_OUTBOX_KINDS).toContain('schedule_published')
		expect(MANAGER_ALERT_KINDS).toContain('schedule_published')
		expect(MANAGER_ALERT_PERMISSIONS.schedule_published).toEqual([
			'read:schedule:any',
		])
		expect(managerAlertPath('schedule_published', 'loc-1')).toBe(
			'/staff/schedule?scope=loc-1',
		)
		expect(managerAlertPath('schedule_published', null)).toBe('/staff/schedule')
	})

	it('validates a resend', () => {
		expect(resendSchema.parse({})).toEqual({ scope: 'unsent' })
		expect(resendSchema.parse({ scope: 'all' })).toEqual({ scope: 'all' })
		expect(resendSchema.safeParse({ scope: 'x' }).success).toBe(false)
		expect(resendSchema.safeParse({ staffId: 'x' }).success).toBe(false)
	})
})

describe('self service bodies', () => {
	it('records a time-off request as the person own, waiting for a decision', () => {
		const parsed = selfTimeOffSchema.parse({
			startDate: '2026-04-01',
			endDate: '2026-04-02',
			// A hostile body cannot approve itself or name someone else.
			submission: 'manager_entered',
			staffId: 'someone-else',
		}) as { staffId: string; submission: string }
		expect(parsed.submission).toBe('staff_request')
		expect(parsed.staffId).toBe(SELF_STAFF_ID)
	})

	it('still applies the time-off rules', () => {
		expect(
			selfTimeOffSchema.safeParse({
				startDate: '2026-04-03',
				endDate: '2026-04-02',
			}).success,
		).toBe(false)
		expect(selfTimeOffSchema.safeParse('x').success).toBe(false)
		expect(selfTimeOffSchema.safeParse(null).success).toBe(false)
		expect(selfTimeOffSchema.safeParse([]).success).toBe(false)
		expect(
			selfTimeOffSchema.safeParse({
				startDate: '2026-04-01',
				endDate: '2026-04-01',
				extra: 1,
			}).success,
		).toBe(false)
	})

	it('records availability as a request, never final', () => {
		const parsed = selfAvailabilitySchema.parse({
			rows: [{ kind: 'weekly', weekday: 1, availability: 'unavailable' }],
			submission: 'manager_entered',
		}) as { submission: string; staffId: string }
		expect(parsed.submission).toBe('staff_request')
		expect(parsed.staffId).toBe(SELF_STAFF_ID)
	})

	it('records a swap, cover or drop as the requester own', () => {
		const drop = selfShiftRequestSchema.parse({
			kind: 'drop',
			shiftId: 's1',
			requesterStaffId: 'someone-else',
			submission: 'manager_entered',
		}) as { requesterStaffId: string; submission: string }
		expect(drop.requesterStaffId).toBe(SELF_STAFF_ID)
		expect(drop.submission).toBe('staff_request')
		expect(
			selfShiftRequestSchema.safeParse({ kind: 'swap', shiftId: 's1' }).success,
		).toBe(false)
		expect(
			selfShiftRequestSchema.safeParse({ kind: 'cover', shiftId: 's1' })
				.success,
		).toBe(false)
		expect(
			selfShiftRequestSchema.safeParse({
				kind: 'cover',
				shiftId: 's1',
				targetStaffId: 't1',
			}).success,
		).toBe(true)
	})

	it('validates a range', () => {
		expect(selfRangeQuerySchema.safeParse({}).success).toBe(true)
		expect(
			selfRangeQuerySchema.safeParse({ from: '2026-04-02', to: '2026-04-01' })
				.success,
		).toBe(false)
		expect(selfRangeQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(
			false,
		)
	})
})
