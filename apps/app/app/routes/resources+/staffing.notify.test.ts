import {
	ConfigFlag,
	db,
	eq,
	inArray,
	Notification,
	NotificationPreference,
	Organization,
	OrganizationLocation,
	OrganizationRole,
	_OrganizationPermissionToRole,
} from '@repo/database'
import type * as EmailModule from '@repo/email'
import {
	DEFAULT_SCOPE_ID,
	MANAGER_ALERT_KINDS,
	managerAlertEventSchema,
	STAFFING_FLAG_KEYS,
	type ManagerAlertEvent,
} from '@repo/staffing'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

const sendEmailMock = vi.hoisted(() => vi.fn())
const emailSwitch = vi.hoisted(() => ({ on: true }))

vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<typeof EmailModule>()),
	sendEmail: sendEmailMock,
}))
vi.mock('#app/utils/staffing/email-switch.server.ts', () => ({
	isStaffingEmailEnabled: () => emailSwitch.on,
}))

import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './staffing.notify.ts'

const createdFlagIds: string[] = []

async function setFlag(key: string, organizationId: string, value = true) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({ key, value, level: 'organization', organizationId })
		.returning({ id: ConfigFlag.id })
	createdFlagIds.push(row!.id)
}

async function turnOn(
	organizationId: string,
	timeclock = true,
	scheduling = false,
	hiring = false,
) {
	await setFlag(STAFFING_FLAG_KEYS.enabled, organizationId)
	if (timeclock) await setFlag(STAFFING_FLAG_KEYS.timeclock, organizationId)
	if (scheduling) await setFlag(STAFFING_FLAG_KEYS.scheduling, organizationId)
	if (hiring) await setFlag(STAFFING_FLAG_KEYS.hiring, organizationId)
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true })
		.where(eq(Organization.id, organizationId))
}

/** The organization's one implicit scope: the only id an alert may name. */
async function createScope(ignoredOrganizationId: string) {
	return DEFAULT_SCOPE_ID
}

async function roleWith(organizationId: string, permissionIds: string[]) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Custom ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	if (permissionIds.length) {
		await db
			.insert(_OrganizationPermissionToRole)
			.values(
				permissionIds.map((permissionId) => ({ A: role!.id, B: permissionId })),
			)
	}
	return role!.id
}

async function memberWith(organizationId: string, permissionIds: string[]) {
	const user = await createTestUser()
	await addOrganizationMember(
		user.id,
		organizationId,
		await roleWith(organizationId, permissionIds),
	)
	return user
}

async function createLocation(organizationId: string, name = 'Downtown') {
	const slug = `loc-${crypto.randomUUID().slice(0, 8)}`
	const [row] = await db
		.insert(OrganizationLocation)
		.values({ organizationId, name, slug })
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

const READ_TIMESHEET = 'org_perm_read_timesheet_any'
const READ_SCHEDULE = 'org_perm_read_schedule_any'
const READ_HIRING = 'org_perm_read_hiring_any'

function eventFor(
	organizationId: string,
	scopeId: string | null,
	patch: Partial<ManagerAlertEvent> = {},
): ManagerAlertEvent {
	return {
		orgId: organizationId,
		eventId: crypto.randomUUID().replace(/-/g, ''),
		kind: 'no_clock_in',
		scopeId,
		count: 2,
		...patch,
	}
}

function call(
	body: unknown,
	options: { authorized?: boolean; method?: string } = {},
) {
	const url = new URL('http://localhost:3001/resources/staffing/notify')
	return action({
		request: new Request(url, {
			method: options.method ?? 'POST',
			headers: {
				'content-type': 'application/json',
				...(options.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }),
			},
			body: typeof body === 'string' ? body : JSON.stringify(body),
		}),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: '/resources/staffing/notify',
	} as never)
}

async function notificationsFor(userId: string) {
	return db.select().from(Notification).where(eq(Notification.userId, userId))
}

beforeEach(() => {
	sendEmailMock.mockReset().mockResolvedValue({ status: 'success', data: {} })
	emailSwitch.on = true
})

afterEach(async () => {
	if (createdFlagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, createdFlagIds))
		createdFlagIds.length = 0
	}
})

describe('POST /resources/staffing/notify authentication and shape', () => {
	it('answers 403 (not a redirect) without the internal token, and does nothing', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const response = await call(eventFor(organization.id, null), {
			authorized: false,
		})
		expect(response.status).toBe(403)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('is a POST route only', async () => {
		const response = await call({}, { method: 'PUT' })
		expect(response.status).toBe(405)
	})

	it.each([
		['a staff id', { staffId: 'staff-1' }],
		['a name', { name: 'Rana Khalid' }],
		['a time', { startAt: 1_800_000_000_000 }],
		['a pay figure', { rateMinor: 1800 }],
		['an unknown kind', { kind: 'shift_swapped' }],
		['a zero count', { count: 0 }],
	])(
		'rejects an event that carries %s, without echoing it',
		async (_label, patch) => {
			const { organization } = await setupTestOrgWithUser('admin')
			await turnOn(organization.id)
			const response = await call({
				...eventFor(organization.id, null),
				...patch,
			})
			expect(response.status).toBe(400)
			const text = await response.text()
			expect(text).not.toContain('Rana')
			expect(text).not.toContain('staff-1')
		},
	)

	it('rejects a body that is not JSON', async () => {
		expect((await call('nope')).status).toBe(400)
	})

	it('answers 404 for an organization that does not exist or has no regional database', async () => {
		expect(
			(await call(eventFor('clw9x0a12000008l00nobody', null))).status,
		).toBe(404)
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(STAFFING_FLAG_KEYS.enabled, organization.id)
		await setFlag(STAFFING_FLAG_KEYS.timeclock, organization.id)
		expect((await call(eventFor(organization.id, null))).status).toBe(404)
	})
})

describe('flags', () => {
	it('tells nobody while staffing is off, and says why', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await db
			.update(Organization)
			.set({ hasProvisionedDb: true })
			.where(eq(Organization.id, organization.id))
		const response = await call(eventFor(organization.id, null))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			inApp: 0,
			emailed: 0,
			skipped: 'feature_off',
		})
		expect(await notificationsFor(user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('needs the timeclock flag as well as the master switch', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, false)
		const response = await call(eventFor(organization.id, null))
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'feature_off',
		)
		expect(await notificationsFor(user.id)).toHaveLength(0)
	})
})

describe('who is told', () => {
	it('tells members who can read timesheets, in the app and by email, and nobody else', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const scope = await createScope(organization.id)
		const reader = await memberWith(organization.id, [READ_TIMESHEET])
		const outsider = await memberWith(organization.id, [
			'org_perm_read_member_any',
		])
		const event = eventFor(organization.id, scope)

		const response = await call(event)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ inApp: 2, emailed: 2 })

		const told = [admin.id, reader.id]
		for (const id of told) {
			const rows = await notificationsFor(id)
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				type: 'staffing-no-clock-in',
				entityId: event.eventId,
				organizationId: organization.id,
				isRead: false,
			})
		}
		expect(await notificationsFor(outsider.id)).toHaveLength(0)
		const sentTo = sendEmailMock.mock.calls.map(([arg]) => arg.to).sort()
		expect(sentTo).toEqual([admin.email, reader.email].sort())
	})

	it('writes an in-app notification with only ids, a kind and a count', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const scope = await createScope(organization.id)
		await call(
			eventFor(organization.id, scope, {
				kind: 'missed_clock_out',
				count: 3,
			}),
		)
		const [row] = await notificationsFor(user.id)
		expect(JSON.parse(row!.payload)).toEqual({
			kind: 'missed_clock_out',
			scopeId: scope,
			count: 3,
			orgSlug: organization.slug,
		})
		expect(row!.payload).not.toContain(organization.name)
	})

	it('sends an email that names the count but no person', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const scope = await createScope(organization.id)
		await call(eventFor(organization.id, scope, { count: 2 }))
		const [{ subject }] = sendEmailMock.mock.calls[0]!
		expect(subject).toBe('2 people have not clocked in')
	})

	it('answers a skipped reason for a workplace the organization does not have', async () => {
		const mine = await setupTestOrgWithUser('admin')
		const theirs = await setupTestOrgWithUser('admin')
		await turnOn(mine.organization.id)
		const foreign = 'branch_of_another_organization'
		const response = await call(eventFor(mine.organization.id, foreign))
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'unknown_scope',
		)
		expect(await notificationsFor(mine.user.id)).toHaveLength(0)
		expect(await notificationsFor(theirs.user.id)).toHaveLength(0)
	})

	it('does not cross organizations', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		await turnOn(a.organization.id)
		await turnOn(b.organization.id)
		await call(eventFor(a.organization.id, null))
		expect(await notificationsFor(a.user.id)).toHaveLength(1)
		expect(await notificationsFor(b.user.id)).toHaveLength(0)
	})
})

describe('who is told, with locations', () => {
	it('names the location in the copy when the organization has locations', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id, 'Downtown')
		await call(eventFor(organization.id, location, { count: 2 }))
		const [{ subject }] = sendEmailMock.mock.calls[0]!
		expect(subject).toBe('2 people have not clocked in at Downtown')
	})

	it('never tells a member whose location scope excludes the location', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const a = await createLocation(organization.id, 'A')
		const b = await createLocation(organization.id, 'B')
		const scoped = await memberWith(organization.id, [READ_TIMESHEET])
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: scoped.id,
			value: { scope: 'selected', locationIds: [a] },
		})
		await call(eventFor(organization.id, b))
		expect(await notificationsFor(scoped.id)).toHaveLength(0)
		await call(eventFor(organization.id, a))
		expect(await notificationsFor(scoped.id)).toHaveLength(1)
	})

	it('sends an alert that is not about one location only to members with every location', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const a = await createLocation(organization.id)
		const scoped = await memberWith(organization.id, [READ_TIMESHEET])
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: scoped.id,
			value: { scope: 'selected', locationIds: [a] },
		})
		const unscoped = await memberWith(organization.id, [READ_TIMESHEET])
		await call(eventFor(organization.id, null))
		expect(await notificationsFor(scoped.id)).toHaveLength(0)
		expect(await notificationsFor(unscoped.id)).toHaveLength(1)
	})

	it("answers a skipped reason for a location that is not this organization's", async () => {
		const mine = await setupTestOrgWithUser('admin')
		const theirs = await setupTestOrgWithUser('admin')
		await turnOn(mine.organization.id)
		await createLocation(mine.organization.id)
		const foreign = await createLocation(theirs.organization.id)
		const response = await call(eventFor(mine.organization.id, foreign))
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'unknown_scope',
		)
		expect(await notificationsFor(mine.user.id)).toHaveLength(0)
	})

	it('answers a skipped reason when nobody is entitled to hear it', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: user.id,
			value: { scope: 'selected', locationIds: [] },
		})
		const response = await call(eventFor(organization.id, location))
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'no_recipients',
		)
	})
})

describe('notification preferences', () => {
	async function prefer(
		userId: string,
		organizationId: string,
		workflow: string,
		channels: { inApp?: boolean; email?: boolean },
	) {
		await db.insert(NotificationPreference).values({
			userId,
			organizationId,
			workflow,
			...channels,
		})
	}

	it('defaults to in-app and email both on', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		await call(eventFor(organization.id, null))
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
	})

	it('honours an email-off and an in-app-off choice independently', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const quiet = await memberWith(organization.id, [READ_TIMESHEET])
		const mailOnly = await memberWith(organization.id, [READ_TIMESHEET])
		await prefer(quiet.id, organization.id, 'staffing-attendance-workflow', {
			inApp: false,
			email: false,
		})
		await prefer(mailOnly.id, organization.id, 'staffing-attendance-workflow', {
			inApp: false,
			email: true,
		})
		await prefer(user.id, organization.id, 'staffing-attendance-workflow', {
			inApp: true,
			email: false,
		})
		const response = await call(eventFor(organization.id, null))
		expect(await response.json()).toEqual({ inApp: 1, emailed: 1 })
		expect(await notificationsFor(quiet.id)).toHaveLength(0)
		expect(await notificationsFor(mailOnly.id)).toHaveLength(0)
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(sendEmailMock.mock.calls.map(([a]) => a.to)).toEqual([
			mailOnly.email,
		])
	})

	it('keeps attendance and overtime preferences separate', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		await prefer(user.id, organization.id, 'staffing-overtime-workflow', {
			inApp: false,
			email: false,
		})
		await call(eventFor(organization.id, null, { kind: 'overtime_reached' }))
		expect(await notificationsFor(user.id)).toHaveLength(0)
		await call(eventFor(organization.id, null, { kind: 'no_clock_in' }))
		expect(await notificationsFor(user.id)).toHaveLength(1)
	})

	it("does not use another organization's preference", async () => {
		const a = await setupTestOrgWithUser('admin')
		await turnOn(a.organization.id)
		const other = await setupTestOrgWithUser('admin')
		await prefer(
			a.user.id,
			other.organization.id,
			'staffing-attendance-workflow',
			{
				inApp: false,
				email: false,
			},
		)
		await call(eventFor(a.organization.id, null))
		expect(await notificationsFor(a.user.id)).toHaveLength(1)
	})
})

describe('email kill switch', () => {
	it('stops the email and keeps the in-app notification', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		emailSwitch.on = false
		const response = await call(eventFor(organization.id, null))
		expect(await response.json()).toEqual({ inApp: 1, emailed: 0 })
		expect(sendEmailMock).not.toHaveBeenCalled()
		expect(await notificationsFor(user.id)).toHaveLength(1)
	})

	it('survives a mail provider that fails or throws', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		sendEmailMock.mockResolvedValueOnce({
			status: 'error',
			error: { message: 'x' },
		})
		const first = await call(eventFor(organization.id, null))
		expect(first.status).toBe(200)
		sendEmailMock.mockRejectedValueOnce(new Error('boom'))
		const second = await call(eventFor(organization.id, null))
		expect(second.status).toBe(200)
		expect(await notificationsFor(user.id)).toHaveLength(2)
		// What is logged names no address and no error text.
		expect(JSON.stringify(consoleError.mock.calls)).not.toContain('@')
		consoleError.mockRestore()
	})
})

describe('idempotency', () => {
	it('repeats neither the notification nor the email when an event is delivered twice', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const event = eventFor(organization.id, null)
		const first = await (await call(event)).json()
		const second = await (await call(event)).json()
		expect(first).toEqual({ inApp: 1, emailed: 1 })
		expect(second).toEqual({ inApp: 0, emailed: 0 })
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
	})

	it('completes the members a half-finished delivery missed', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const late = await memberWith(organization.id, [READ_TIMESHEET])
		const event = eventFor(organization.id, null)
		// The first attempt reached only the admin.
		await db.insert(Notification).values({
			userId: user.id,
			organizationId: organization.id,
			type: 'staffing-no-clock-in',
			entityId: event.eventId,
			payload: '{}',
		})
		const result = await (await call(event)).json()
		expect(result).toEqual({ inApp: 1, emailed: 1 })
		expect(await notificationsFor(late.id)).toHaveLength(1)
		expect(await notificationsFor(user.id)).toHaveLength(1)
	})

	it('treats different events as different notifications', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		await call(eventFor(organization.id, null))
		await call(eventFor(organization.id, null))
		expect(await notificationsFor(user.id)).toHaveLength(2)
	})
})

describe('every alert kind', () => {
	it.each(MANAGER_ALERT_KINDS)('delivers %s', async (kind) => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, true, true, true)
		const scope = await createScope(organization.id)
		const event = eventFor(organization.id, scope, { kind, count: 1 })
		expect(managerAlertEventSchema.safeParse(event).success).toBe(true)
		const response = await call(event)
		expect(await response.json()).toEqual({ inApp: 1, emailed: 1 })
		const [row] = await notificationsFor(user.id)
		expect(row!.type.startsWith('staffing-')).toBe(true)
		const [{ subject }] = sendEmailMock.mock.calls[0]!
		expect(subject).toMatch(
			kind === 'schedule_published'
				? /schedule was published/
				: kind === 'new_applicant'
					? /new applicant/
					: kind === 'onboarding_due'
						? /onboarding task needs attention/
						: kind === 'certificate_expiring'
							? /certificate needs renewing/
							: /1 person/,
		)
	})
})

describe('a published schedule', () => {
	it('needs the scheduling flag, not the time clock', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, true, false)
		const scope = await createScope(organization.id)
		const response = await call(
			eventFor(organization.id, scope, { kind: 'schedule_published' }),
		)
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'feature_off',
		)
		expect(await notificationsFor(user.id)).toHaveLength(0)
		// And it works with scheduling on while the time clock is off.
		const other = await setupTestOrgWithUser('admin')
		await turnOn(other.organization.id, false, true)
		const loc = await createScope(other.organization.id)
		const ok = await call(
			eventFor(other.organization.id, loc, { kind: 'schedule_published' }),
		)
		expect(await ok.json()).toEqual({ inApp: 1, emailed: 1 })
	})

	it('goes to members who can read the schedule, not those who only read timesheets', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, true, true)
		const scope = await createScope(organization.id)
		const scheduler = await memberWith(organization.id, [READ_SCHEDULE])
		const timesheets = await memberWith(organization.id, [READ_TIMESHEET])
		const event = eventFor(organization.id, scope, {
			kind: 'schedule_published',
			count: 1,
		})
		expect(await (await call(event)).json()).toEqual({ inApp: 2, emailed: 2 })
		for (const id of [admin.id, scheduler.id]) {
			const [row] = await notificationsFor(id)
			expect(row).toMatchObject({ type: 'staffing-schedule-published' })
			expect(JSON.parse(row!.payload as string)).toEqual({
				kind: 'schedule_published',
				scopeId: scope,
				count: 1,
				orgSlug: organization.slug,
			})
		}
		expect(await notificationsFor(timesheets.id)).toHaveLength(0)
	})

	it('leaves the person who published out of their own alert', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, false, true)
		const scope = await createScope(organization.id)
		const other = await memberWith(organization.id, [READ_SCHEDULE])
		const event = eventFor(organization.id, scope, {
			kind: 'schedule_published',
			actorUserId: admin.id,
		})
		expect(await (await call(event)).json()).toEqual({ inApp: 1, emailed: 1 })
		expect(await notificationsFor(admin.id)).toHaveLength(0)
		expect(await notificationsFor(other.id)).toHaveLength(1)
		// Alone, the publisher is told nobody else needs to be.
		const solo = await setupTestOrgWithUser('admin')
		await turnOn(solo.organization.id, false, true)
		const loc = await createScope(solo.organization.id)
		const response = await call(
			eventFor(solo.organization.id, loc, {
				kind: 'schedule_published',
				actorUserId: solo.user.id,
			}),
		)
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'no_recipients',
		)
	})

	it('rejects an actor that is not an opaque id', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, false, true)
		const response = await call({
			...eventFor(organization.id, null, { kind: 'schedule_published' }),
			actorUserId: '../etc/passwd',
		})
		expect(response.status).toBe(400)
	})
})

describe.each([
	['onboarding_due', 'staffing-onboarding-due'],
	['certificate_expiring', 'staffing-certificate-expiring'],
] as const)('%s', (kind, type) => {
	it('needs the hiring flag, not the time clock or scheduling', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, true, true, false)
		const scope = await createScope(organization.id)
		const response = await call(
			eventFor(organization.id, scope, { kind, count: 1 }),
		)
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'feature_off',
		)
		expect(await notificationsFor(user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('goes to members who can read hiring, with a count and a place only', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, true, true, true)
		const scope = await createScope(organization.id)
		const recruiter = await memberWith(organization.id, [READ_HIRING])
		const timesheets = await memberWith(organization.id, [READ_TIMESHEET])
		const event = eventFor(organization.id, scope, { kind, count: 3 })
		expect(await (await call(event)).json()).toEqual({ inApp: 2, emailed: 2 })
		for (const id of [admin.id, recruiter.id]) {
			const [row] = await notificationsFor(id)
			expect(row).toMatchObject({ type })
			expect(JSON.parse(row!.payload as string)).toEqual({
				kind,
				scopeId: scope,
				count: 3,
				orgSlug: organization.slug,
			})
		}
		expect(await notificationsFor(timesheets.id)).toHaveLength(0)
	})

	it('refuses an event that carries a person', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, true, true, true)
		const response = await call({
			...eventFor(organization.id, null, { kind }),
			staffId: 'staff-1',
		} as never)
		expect(response.status).toBe(400)
	})
})

describe('a new applicant', () => {
	it('needs the hiring flag, not the time clock or scheduling', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, true, true, false)
		const scope = await createScope(organization.id)
		const response = await call(
			eventFor(organization.id, scope, { kind: 'new_applicant', count: 1 }),
		)
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'feature_off',
		)
		expect(await notificationsFor(user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
		// And it works with only hiring on.
		const other = await setupTestOrgWithUser('admin')
		await turnOn(other.organization.id, false, false, true)
		const loc = await createScope(other.organization.id)
		const ok = await call(
			eventFor(other.organization.id, loc, { kind: 'new_applicant', count: 3 }),
		)
		expect(await ok.json()).toEqual({ inApp: 1, emailed: 1 })
	})

	it('goes to members who can read applicants, not to those who only read timesheets or schedules', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, true, true, true)
		const scope = await createScope(organization.id)
		const recruiter = await memberWith(organization.id, [READ_HIRING])
		const timesheets = await memberWith(organization.id, [READ_TIMESHEET])
		const scheduler = await memberWith(organization.id, [READ_SCHEDULE])
		const event = eventFor(organization.id, scope, {
			kind: 'new_applicant',
			count: 2,
		})
		expect(await (await call(event)).json()).toEqual({ inApp: 2, emailed: 2 })
		for (const id of [admin.id, recruiter.id]) {
			const [row] = await notificationsFor(id)
			expect(row).toMatchObject({ type: 'staffing-new-applicant' })
			// Ids and a count only: never a name, an answer or a score.
			expect(JSON.parse(row!.payload as string)).toEqual({
				kind: 'new_applicant',
				scopeId: scope,
				count: 2,
				orgSlug: organization.slug,
			})
		}
		expect(await notificationsFor(timesheets.id)).toHaveLength(0)
		expect(await notificationsFor(scheduler.id)).toHaveLength(0)
	})

	it('respects the hiring preference separately from the other alerts', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, true, true, true)
		const scope = await createScope(organization.id)
		await db.insert(NotificationPreference).values({
			userId: user.id,
			organizationId: organization.id,
			workflow: 'staffing-hiring-workflow',
			email: false,
			inApp: true,
		})
		expect(
			await (
				await call(
					eventFor(organization.id, scope, {
						kind: 'new_applicant',
						count: 1,
					}),
				)
			).json(),
		).toEqual({ inApp: 1, emailed: 0 })
		// The attendance preference is untouched.
		expect(
			await (
				await call(eventFor(organization.id, scope, { kind: 'no_clock_in' }))
			).json(),
		).toEqual({ inApp: 1, emailed: 1 })
	})

	it('says nothing about a person in the email', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, false, false, true)
		const scope = await createScope(organization.id)
		await call(
			eventFor(organization.id, scope, { kind: 'new_applicant', count: 1 }),
		)
		const [{ subject, react }] = sendEmailMock.mock.calls[0]! as [
			{ subject: string; react?: unknown },
		]
		expect(subject).toBe('A new applicant')
		expect(JSON.stringify(react ?? '')).not.toMatch(/@|phone|answer/i)
	})

	it('rejects extra fields that would carry a person', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, false, false, true)
		const response = await call({
			...eventFor(organization.id, null, { kind: 'new_applicant' }),
			applicantName: 'Sara Ali',
		})
		expect(response.status).toBe(400)
	})
})
