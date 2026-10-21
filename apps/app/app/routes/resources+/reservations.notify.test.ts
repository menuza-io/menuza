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
	UserOrganization,
	_OrganizationPermissionToRole,
} from '@repo/database'
import type * as EmailModule from '@repo/email'
import { RESERVATIONS_FLAG_KEYS } from '@repo/reservations'
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
vi.mock('#app/utils/reservations/email-switch.server.ts', () => ({
	isReservationsEmailEnabled: () => emailSwitch.on,
}))

import {
	RESERVATION_ALERT_KINDS,
	RESERVATION_ALERT_MARKER_TYPE,
	type ReservationAlertEvent,
} from '#app/utils/reservations/manager-alerts.ts'
import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './reservations.notify.ts'

const createdFlagIds: string[] = []

async function turnOn(organizationId: string, provisioned = true) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: RESERVATIONS_FLAG_KEYS.enabled,
			value: true,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	createdFlagIds.push(row!.id)
	await db
		.update(Organization)
		.set({ hasProvisionedDb: provisioned })
		.where(eq(Organization.id, organizationId))
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
	await db
		.insert(_OrganizationPermissionToRole)
		.values(
			permissionIds.map((permissionId) => ({ A: role!.id, B: permissionId })),
		)
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
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name,
			slug: `loc-${crypto.randomUUID().slice(0, 8)}`,
		})
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

const READ_RESERVATION = 'org_perm_read_reservation_any'
const UPDATE_RESERVATION = 'org_perm_update_reservation_any'
const UPDATE_SETTINGS = 'org_perm_update_reservation_settings_any'
const READ_GUEST = 'org_perm_read_reservation_guest_any'

function eventFor(
	organizationId: string,
	locationId: string,
	patch: Partial<ReservationAlertEvent> = {},
): ReservationAlertEvent {
	return {
		orgId: organizationId,
		eventId: crypto.randomUUID().replace(/-/g, ''),
		kind: 'large_party_request',
		locationId,
		count: 3,
		...patch,
	}
}

function call(
	body: unknown,
	options: { authorized?: boolean; method?: string } = {},
) {
	return action({
		request: new Request(
			'http://localhost:3001/resources/reservations/notify',
			{
				method: options.method ?? 'POST',
				headers: {
					'content-type': 'application/json',
					...(options.authorized === false
						? {}
						: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }),
				},
				body: typeof body === 'string' ? body : JSON.stringify(body),
			},
		),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: '/resources/reservations/notify',
	} as never)
}

async function notificationsFor(userId: string) {
	const rows = await db
		.select()
		.from(Notification)
		.where(eq(Notification.userId, userId))
	return rows.filter((row) => row.type !== RESERVATION_ALERT_MARKER_TYPE)
}

async function markersFor(userId: string) {
	const rows = await db
		.select()
		.from(Notification)
		.where(eq(Notification.userId, userId))
	return rows.filter((row) => row.type === RESERVATION_ALERT_MARKER_TYPE)
}

async function prefer(
	userId: string,
	organizationId: string,
	kind: string,
	channels: { inApp?: boolean; email?: boolean },
) {
	await db.insert(NotificationPreference).values({
		userId,
		organizationId,
		workflow: `reservations.${kind}`,
		...channels,
	})
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

describe('POST /resources/reservations/notify authentication and shape', () => {
	it('answers 401 without the internal token before reading anything, and does nothing', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const response = await call(eventFor(organization.id, location), {
			authorized: false,
		})
		expect(response.status).toBe(401)
		expect(await notificationsFor(user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('refuses a wrong token and an unauthenticated malformed body with 401, not 400', async () => {
		const response = await call('not json', { authorized: false })
		expect(response.status).toBe(401)
	})

	it('is a POST route only', async () => {
		expect((await call({}, { method: 'PUT' })).status).toBe(405)
	})

	it.each([
		['a guest name', { guestName: 'Rana Khalid' }],
		['a phone', { phone: '+15551230000' }],
		['an email', { email: 'rana@example.com' }],
		['an unknown kind', { kind: 'guest_complained' }],
		['a zero count', { count: 0 }],
		['a fractional count', { count: 1.5 }],
		['a missing location', { locationId: undefined }],
	])('rejects an event with %s, without echoing it', async (_label, patch) => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const response = await call({
			...eventFor(organization.id, location),
			...patch,
		})
		expect(response.status).toBe(400)
		const text = await response.text()
		expect(text).not.toContain('Rana')
		expect(text).not.toContain('555')
		expect(text).not.toContain('example.com')
		expect(text).not.toContain('guest_complained')
	})

	it('rejects a body that is not JSON', async () => {
		expect((await call('nope')).status).toBe(400)
	})

	it('answers 404 for an organization that does not exist or has no regional database', async () => {
		expect(
			(await call(eventFor('clw9x0a12000008l00nobody', 'loc_1'))).status,
		).toBe(404)
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, false)
		const location = await createLocation(organization.id)
		expect((await call(eventFor(organization.id, location))).status).toBe(404)
	})
})

describe('flags', () => {
	it('tells nobody while reservations is off, and says why', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await db
			.update(Organization)
			.set({ hasProvisionedDb: true })
			.where(eq(Organization.id, organization.id))
		const location = await createLocation(organization.id)
		const response = await call(eventFor(organization.id, location))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			inApp: 0,
			emailed: 0,
			skipped: 'feature_off',
		})
		expect(await notificationsFor(user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('treats only a literal true as on', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		const [row] = await db
			.insert(ConfigFlag)
			.values({
				key: RESERVATIONS_FLAG_KEYS.enabled,
				value: 'true' as never,
				level: 'organization',
				organizationId: organization.id,
			})
			.returning({ id: ConfigFlag.id })
		createdFlagIds.push(row!.id)
		await db
			.update(Organization)
			.set({ hasProvisionedDb: true })
			.where(eq(Organization.id, organization.id))
		const location = await createLocation(organization.id)
		const response = await call(eventFor(organization.id, location))
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'feature_off',
		)
		expect(await notificationsFor(user.id)).toHaveLength(0)
	})
})

describe('who is told', () => {
	it('tells members with read:reservation:any or update:reservation_settings:any, in the app and by email, and nobody else', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const reader = await memberWith(organization.id, [READ_RESERVATION])
		const editor = await memberWith(organization.id, [UPDATE_RESERVATION])
		const settingsOnly = await memberWith(organization.id, [UPDATE_SETTINGS])
		const outsider = await memberWith(organization.id, [READ_GUEST])
		const event = eventFor(organization.id, location)

		const response = await call(event)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ inApp: 4, emailed: 4 })

		for (const member of [admin, reader, editor, settingsOnly]) {
			const rows = await notificationsFor(member.id)
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				type: 'reservations-large-party-request',
				entityId: event.eventId,
				organizationId: organization.id,
				isRead: false,
			})
		}
		expect(await notificationsFor(outsider.id)).toHaveLength(0)
		const sentTo = sendEmailMock.mock.calls.map(([arg]) => arg.to).sort()
		expect(sentTo).toEqual(
			[admin.email, reader.email, editor.email, settingsOnly.email].sort(),
		)
	})

	it('names a multi-language location by its resolved name, never the raw map', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		await createLocation(organization.id, 'Uptown')
		const location = await createLocation(
			organization.id,
			JSON.stringify({ en: 'Downtown Flagship', ar: 'وسط المدينة' }),
		)

		const response = await call(eventFor(organization.id, location))
		expect(response.status).toBe(200)

		const [row] = await notificationsFor(admin.id)
		expect(JSON.stringify(row)).toContain('Downtown Flagship')
		expect(JSON.stringify(row)).not.toContain('"ar"')
		const subject = JSON.stringify(sendEmailMock.mock.calls[0]?.[0])
		expect(subject).not.toContain('\\"en\\"')
	})

	it('does not tell a deactivated member or one of another organization', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const gone = await memberWith(organization.id, [READ_RESERVATION])
		await db
			.update(UserOrganization)
			.set({ active: false })
			.where(eq(UserOrganization.userId, gone.id))
		const { organization: other, user: otherAdmin } =
			await setupTestOrgWithUser('admin')
		await turnOn(other.id)
		await call(eventFor(organization.id, location))
		expect(await notificationsFor(gone.id)).toHaveLength(0)
		expect(await notificationsFor(otherAdmin.id)).toHaveLength(0)
	})

	it('answers a skipped reason for a location the organization does not have', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const { organization: other } = await setupTestOrgWithUser('admin')
		const foreign = await createLocation(other.id)
		const response = await call(eventFor(organization.id, foreign))
		expect(await response.json()).toEqual({
			inApp: 0,
			emailed: 0,
			skipped: 'unknown_location',
		})
		expect(await notificationsFor(user.id)).toHaveLength(0)
	})

	it('answers a skipped reason when nobody is entitled to hear it', async () => {
		const { organization, user } = await setupTestOrgWithUser('viewer')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const response = await call(eventFor(organization.id, location))
		expect(await response.json()).toEqual({
			inApp: 0,
			emailed: 0,
			skipped: 'no_recipients',
		})
		expect(await notificationsFor(user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('writes an in-app notification with only a kind, a location id and a count', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await call(eventFor(organization.id, location, { count: 4 }))
		const [row] = await notificationsFor(user.id)
		const payload = JSON.parse(row!.payload) as Record<string, unknown>
		expect(payload).toMatchObject({
			kind: 'large_party_request',
			locationId: location,
			count: 4,
			orgSlug: organization.slug,
		})
		expect(Object.keys(payload).sort()).toEqual(
			['count', 'kind', 'locationId', 'orgSlug'].sort(),
		)
	})

	it('adds the location name to the notification when the organization has several', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const downtown = await createLocation(organization.id, 'Downtown')
		await createLocation(organization.id, 'Uptown')
		await call(eventFor(organization.id, downtown))
		const [row] = await notificationsFor(user.id)
		expect(JSON.parse(row!.payload)).toEqual({
			kind: 'large_party_request',
			locationId: downtown,
			locationName: 'Downtown',
			count: 3,
			orgSlug: organization.slug,
		})
	})

	it('sends an email that names the count but no guest', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await call(eventFor(organization.id, location, { count: 3 }))
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		const [arg] = sendEmailMock.mock.calls[0]!
		expect(arg.to).toBe(user.email)
		expect(arg.subject).toBe('3 large-party requests are waiting')
		expect(JSON.stringify(arg.react.props)).not.toMatch(
			/phone|guest name|@example/i,
		)
	})

	it('names the location in the email only when the organization has several', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const downtown = await createLocation(organization.id, 'Downtown')
		await call(eventFor(organization.id, downtown, { count: 1 }))
		expect(sendEmailMock.mock.calls[0]![0].subject).toBe(
			'A large-party request is waiting',
		)
		await createLocation(organization.id, 'Uptown')
		await call(eventFor(organization.id, downtown, { count: 1 }))
		expect(sendEmailMock.mock.calls[1]![0].subject).toBe(
			'A large-party request is waiting at Downtown',
		)
	})
})

describe('location scope', () => {
	it('never tells a member whose location scope excludes the location', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const a = await createLocation(organization.id, 'A')
		const b = await createLocation(organization.id, 'B')
		const scoped = await memberWith(organization.id, [READ_RESERVATION])
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
})

describe('notification preferences', () => {
	it('defaults to in-app and email both on', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await call(eventFor(organization.id, location))
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
	})

	it('honours an email-off and an in-app-off choice independently', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const quiet = await memberWith(organization.id, [READ_RESERVATION])
		const mailOnly = await memberWith(organization.id, [READ_RESERVATION])
		await prefer(quiet.id, organization.id, 'large_party_request', {
			inApp: false,
			email: false,
		})
		await prefer(mailOnly.id, organization.id, 'large_party_request', {
			inApp: false,
			email: true,
		})
		await prefer(user.id, organization.id, 'large_party_request', {
			inApp: true,
			email: false,
		})
		const response = await call(eventFor(organization.id, location))
		expect(await response.json()).toEqual({ inApp: 1, emailed: 1 })
		expect(await notificationsFor(quiet.id)).toHaveLength(0)
		expect(await notificationsFor(mailOnly.id)).toHaveLength(0)
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(sendEmailMock.mock.calls.map(([a]) => a.to)).toEqual([
			mailOnly.email,
		])
	})

	it('keeps the preference of each kind separate', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await prefer(user.id, organization.id, 'payment_failed', {
			inApp: false,
			email: false,
		})
		await call(eventFor(organization.id, location, { kind: 'payment_failed' }))
		expect(await notificationsFor(user.id)).toHaveLength(0)
		await call(eventFor(organization.id, location))
		expect(await notificationsFor(user.id)).toHaveLength(1)
	})

	it("does not use another organization's preference", async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const { organization: other } = await setupTestOrgWithUser('admin')
		await db.insert(UserOrganization).values({
			userId: user.id,
			organizationId: other.id,
			organizationRoleId: 'org_role_admin',
		})
		await prefer(user.id, other.id, 'large_party_request', {
			inApp: false,
			email: false,
		})
		await call(eventFor(organization.id, location))
		expect(await notificationsFor(user.id)).toHaveLength(1)
	})
})

describe('email kill switch', () => {
	it('drops the email and keeps the in-app notification', async () => {
		emailSwitch.on = false
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const response = await call(eventFor(organization.id, location))
		expect(await response.json()).toEqual({ inApp: 1, emailed: 0 })
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('survives a mail provider that fails or throws', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const second = await memberWith(organization.id, [READ_RESERVATION])
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		sendEmailMock
			.mockResolvedValueOnce({ status: 'error', error: {} })
			.mockRejectedValueOnce(new Error('boom'))
		const response = await call(eventFor(organization.id, location))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ inApp: 2, emailed: 0 })
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(await notificationsFor(second.id)).toHaveLength(1)
		expect(JSON.stringify(consoleError.mock.calls)).not.toContain('@')
		consoleError.mockRestore()
	})
})

describe('idempotency', () => {
	it('repeats neither the notification nor the email when an event is delivered twice', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const event = eventFor(organization.id, location)
		await call(event)
		const second = await call(event)
		expect(await second.json()).toEqual({ inApp: 0, emailed: 0 })
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
	})

	it('does not email an email-only member twice', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await prefer(user.id, organization.id, 'large_party_request', {
			inApp: false,
			email: true,
		})
		const event = eventFor(organization.id, location)
		await call(event)
		await call(event)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		expect(await notificationsFor(user.id)).toHaveLength(0)
		const markers = await markersFor(user.id)
		expect(markers).toHaveLength(1)
		expect(markers[0]).toMatchObject({ isRead: true, isSeen: true })
	})

	it('completes the members a half-finished delivery missed', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const event = eventFor(organization.id, location)
		await call(event)
		const late = await memberWith(organization.id, [READ_RESERVATION])
		const response = await call(event)
		expect(await response.json()).toEqual({ inApp: 1, emailed: 1 })
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(await notificationsFor(late.id)).toHaveLength(1)
	})

	it('treats different events as different notifications', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await call(eventFor(organization.id, location))
		await call(eventFor(organization.id, location))
		expect(await notificationsFor(user.id)).toHaveLength(2)
	})
})

describe('every alert kind', () => {
	it.each(RESERVATION_ALERT_KINDS)(
		'delivers %s with a count and no personal data',
		async (kind) => {
			const { organization, user } = await setupTestOrgWithUser('admin')
			await turnOn(organization.id)
			const location = await createLocation(organization.id)
			const response = await call(
				eventFor(organization.id, location, { kind, count: 2 }),
			)
			expect(await response.json()).toEqual({ inApp: 1, emailed: 1 })
			const [row] = await notificationsFor(user.id)
			expect(row!.type).toBe(`reservations-${kind.replaceAll('_', '-')}`)
			expect(row!.payload).not.toMatch(/@|\+\d{6,}/)
			const [arg] = sendEmailMock.mock.calls[0]!
			expect(arg.subject).toMatch(/2/)
			expect(arg.subject).not.toMatch(/@|\+\d{6,}/)
		},
	)
})
