import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	enabled: vi.fn(),
	permitted: vi.fn(),
}))

vi.mock('#app/utils/staffing/access.server.ts', () => ({
	isStaffingFeatureEnabled: mocks.enabled,
	userHasStaffingPermission: mocks.permitted,
}))

const {
	countVisibleStaffingAlerts,
	filterVisibleNotifications,
	isStaffingNotificationType,
	staffingAlertGroup,
	staffingAlertVisibleOrgIds,
} = await import('./notification-visibility.server.ts')

const note = (id: string, type: string, organizationId: string) => ({
	id,
	type,
	organizationId,
})

beforeEach(() => {
	mocks.enabled.mockReset().mockResolvedValue(true)
	mocks.permitted.mockReset().mockResolvedValue(true)
})

describe('staffing notification visibility', () => {
	it('recognises only staffing types', () => {
		expect(isStaffingNotificationType('staffing-no-clock-in')).toBe(true)
		expect(isStaffingNotificationType('mention')).toBe(false)
	})

	it('shows alerts while the time clock is on and the member can read timesheets', async () => {
		const list = [
			note('1', 'staffing-no-clock-in', 'o1'),
			note('2', 'mention', 'o1'),
		]
		expect(await filterVisibleNotifications('u', list)).toEqual(list)
	})

	it('hides alerts, and only alerts, when the flag is off', async () => {
		mocks.enabled.mockResolvedValue(false)
		const out = await filterVisibleNotifications('u', [
			note('1', 'staffing-missed-clock-out', 'o1'),
			note('2', 'mention', 'o1'),
		])
		expect(out.map((n) => n.id)).toEqual(['2'])
	})

	it('hides alerts after the member loses the permission', async () => {
		mocks.permitted.mockResolvedValue(false)
		expect(
			await filterVisibleNotifications('u', [
				note('1', 'staffing-overtime-reached', 'o1'),
			]),
		).toEqual([])
	})

	it('decides per organization and fails closed on a lookup error', async () => {
		mocks.enabled.mockImplementation(async (orgId: string) => {
			if (orgId === 'bad') throw new Error('down')
			return orgId === 'o1'
		})
		const visible = await staffingAlertVisibleOrgIds('u', [
			'o1',
			'o2',
			'bad',
			'o1',
		])
		expect([...visible]).toEqual(['o1'])
		expect(mocks.enabled).toHaveBeenCalledTimes(3)
	})

	it('does not look anything up when no alert is present', async () => {
		await filterVisibleNotifications('u', [note('1', 'mention', 'o1')])
		expect(mocks.enabled).not.toHaveBeenCalled()
	})
})

describe('published schedule alerts', () => {
	it('belong to the schedule group, everything else to the time clock', () => {
		expect(staffingAlertGroup('staffing-schedule-published')).toBe('schedule')
		expect(staffingAlertGroup('staffing-no-clock-in')).toBe('timeclock')
	})

	it('need scheduling and the schedule grant, not the time clock', async () => {
		mocks.enabled.mockImplementation(
			async (_org: string, feature: string) => feature === 'scheduling',
		)
		mocks.permitted.mockImplementation(
			async (_user: string, _org: string, permission: string) =>
				permission === 'read:schedule:any',
		)
		const out = await filterVisibleNotifications('u', [
			note('1', 'staffing-schedule-published', 'o1'),
			note('2', 'staffing-no-clock-in', 'o1'),
		])
		expect(out.map((n) => n.id)).toEqual(['1'])
	})

	it('are hidden when scheduling is off, even with the time clock on', async () => {
		mocks.enabled.mockImplementation(
			async (_org: string, feature: string) => feature === 'timeclock',
		)
		const out = await filterVisibleNotifications('u', [
			note('1', 'staffing-schedule-published', 'o1'),
			note('2', 'staffing-no-clock-in', 'o1'),
		])
		expect(out.map((n) => n.id)).toEqual(['2'])
	})

	it('are counted by group', async () => {
		mocks.enabled.mockImplementation(
			async (_org: string, feature: string) => feature === 'scheduling',
		)
		expect(
			await countVisibleStaffingAlerts('u', [
				note('1', 'staffing-schedule-published', 'o1'),
				note('2', 'staffing-schedule-published', 'o2'),
				note('3', 'staffing-overtime-reached', 'o1'),
			]),
		).toBe(2)
		expect(await countVisibleStaffingAlerts('u', [])).toBe(0)
	})

	it('check the org lookup per group and fail closed', async () => {
		mocks.enabled.mockRejectedValue(new Error('down'))
		expect([
			...(await staffingAlertVisibleOrgIds('u', ['o1'], 'schedule')),
		]).toEqual([])
	})
})

describe('new applicant alerts', () => {
	it('belong to the hiring group', () => {
		expect(staffingAlertGroup('staffing-new-applicant')).toBe('hiring')
		expect(staffingAlertGroup('staffing-schedule-published')).toBe('schedule')
	})

	it('need hiring and the hiring grant, not the time clock or the schedule', async () => {
		mocks.enabled.mockImplementation(
			async (_org: string, feature: string) => feature === 'hiring',
		)
		mocks.permitted.mockImplementation(
			async (_user: string, _org: string, permission: string) =>
				permission === 'read:hiring:any',
		)
		const out = await filterVisibleNotifications('u', [
			note('1', 'staffing-new-applicant', 'o1'),
			note('2', 'staffing-no-clock-in', 'o1'),
			note('3', 'staffing-schedule-published', 'o1'),
		])
		expect(out.map((n) => n.id)).toEqual(['1'])
	})

	it('are hidden once hiring is turned off', async () => {
		mocks.enabled.mockImplementation(
			async (_org: string, feature: string) => feature !== 'hiring',
		)
		const out = await filterVisibleNotifications('u', [
			note('1', 'staffing-new-applicant', 'o1'),
			note('2', 'staffing-no-clock-in', 'o1'),
		])
		expect(out.map((n) => n.id)).toEqual(['2'])
	})

	it('are hidden from a member who lost the hiring grant, and counted by group', async () => {
		mocks.permitted.mockImplementation(
			async (_user: string, _org: string, permission: string) =>
				permission !== 'read:hiring:any',
		)
		expect(
			await countVisibleStaffingAlerts('u', [
				note('1', 'staffing-new-applicant', 'o1'),
				note('2', 'staffing-no-clock-in', 'o1'),
			]),
		).toBe(1)
	})
})
