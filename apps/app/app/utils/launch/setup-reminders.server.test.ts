import {
	ConfigFlag,
	db,
	eq,
	NotificationPreference,
	OnboardingStepProgress,
	Organization,
	OrganizationLocation,
	SetupReminder,
	SetupReminderState,
	User,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	addOrganizationMember,
	createTestOrganization,
	createTestUser,
} from '#tests/test-utils.ts'

vi.mock('#app/utils/menu/menu-health.server.ts', () => ({
	loadMenuHealth: vi.fn(async () => ({
		score: 75,
		grade: 'C',
		fixCount: 0,
		checks: [],
		itemCount: 5,
		staleDismissals: [],
	})),
}))

const { previewSetupReminder, runSetupReminders, sendManualSetupReminder } =
	await import('./setup-reminders.server.ts')
const { SETUP_REMINDER_WORKFLOW, SETUP_REMINDERS_FLAG, TEST_ACCOUNT_FLAG } =
	await import('@repo/common/setup-reminders')

const DAY = 86_400_000
const T0 = new Date('2027-02-01T03:00:00Z')
const sendEmail = vi.hoisted(() => vi.fn())

const at = (days: number) => new Date(T0.getTime() + days * DAY)

function deps(now: Date, fail = false) {
	return {
		now: () => now,
		sendEmail: (async (input: unknown) => {
			sendEmail(input)
			return fail
				? {
						status: 'error',
						error: { name: 'x', message: 'y', statusCode: 500 },
					}
				: { status: 'success', data: { id: 'e1' } }
		}) as never,
	}
}

async function setFlag(organizationId: string, key: string, value: unknown) {
	await db.insert(ConfigFlag).values({
		key,
		value,
		level: 'organization',
		organizationId,
	})
}

async function setup(
	options: {
		remindersOn?: boolean
		checklistOn?: boolean
		locale?: string
	} = {},
) {
	const owner = await createTestUser()
	const organization = await createTestOrganization(owner.id, 'admin')
	await db
		.update(Organization)
		.set({
			createdAt: T0,
			siteDefaultLocale: options.locale ?? 'en',
		})
		.where(eq(Organization.id, organization.id))
	if (options.checklistOn !== false) {
		await setFlag(organization.id, 'launch.checklist', true)
	}
	if (options.remindersOn !== false) {
		await setFlag(organization.id, SETUP_REMINDERS_FLAG, true)
	}
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Olaya',
			slug: `loc-${crypto.randomUUID().slice(0, 8)}`,
			address: '1 King Fahd Rd',
			isDefault: true,
		})
		.returning({ id: OrganizationLocation.id })
	const [ownerRow] = await db
		.select({ email: User.email })
		.from(User)
		.where(eq(User.id, owner.id))
	return {
		owner,
		ownerEmail: ownerRow!.email,
		organization,
		locationId: location!.id,
	}
}

const WEEK = JSON.stringify(
	[
		'monday',
		'tuesday',
		'wednesday',
		'thursday',
		'friday',
		'saturday',
		'sunday',
	].map((day) => ({
		day,
		isOpen: true,
		slots: [{ start: '10:00', end: '22:00' }],
	})),
)

function emailsTo(address: string) {
	return sendEmail.mock.calls
		.map(([input]) => input)
		.filter((input) => input.to === address)
}

beforeEach(() => {
	sendEmail.mockReset()
})

describe('setup reminders (#271)', () => {
	it('emails the owner at 1, 3 and 7 days after the last progress, naming the next step, then stops', async () => {
		const { ownerEmail } = await setup()

		await runSetupReminders(deps(at(0)))
		expect(emailsTo(ownerEmail)).toHaveLength(0)

		const day1 = await runSetupReminders(deps(at(1)))
		expect(day1.sent).toBe(1)
		const [first] = emailsTo(ownerEmail)
		expect(first.subject).toContain('Add your address and opening hours')
		expect(first.react.props.heading).toBe(
			'Add your address and opening hours, about 3 minutes',
		)
		expect(first.react.props.progress).toMatch(/^\d of \d done$/)
		expect(first.react.props.actionUrl).toMatch(
			/\/settings\/locations\/[\w-]+$/,
		)
		expect(first.react.props.unsubscribeUrl).toContain(
			'/resources/report-unsubscribe?token=',
		)

		// The same day again sends nothing: the day is claimed once.
		expect((await runSetupReminders(deps(at(1)))).sent).toBe(0)
		expect(emailsTo(ownerEmail)).toHaveLength(1)

		expect((await runSetupReminders(deps(at(2)))).sent).toBe(0)
		expect((await runSetupReminders(deps(at(3)))).sent).toBe(1)
		expect((await runSetupReminders(deps(at(5)))).sent).toBe(0)
		expect((await runSetupReminders(deps(at(7)))).sent).toBe(1)
		expect(emailsTo(ownerEmail)).toHaveLength(3)

		// Then it stops, however long it waits.
		for (const day of [8, 10, 20, 40]) {
			expect((await runSetupReminders(deps(at(day)))).sent).toBe(0)
		}
		expect(emailsTo(ownerEmail)).toHaveLength(3)
	})

	it('records every reminder in the history without an address', async () => {
		const { organization, ownerEmail } = await setup()
		await runSetupReminders(deps(at(0)))
		await runSetupReminders(deps(at(1)))
		await runSetupReminders(deps(at(3)))
		const rows = await db
			.select()
			.from(SetupReminder)
			.where(eq(SetupReminder.organizationId, organization.id))
		expect(rows.map((row) => [row.kind, row.day, row.stepKey])).toEqual([
			['auto', 1, 'launch_location_details'],
			['auto', 3, 'launch_location_details'],
		])
		expect(rows[0]).toMatchObject({ recipientCount: 1, sentById: null })
		expect(JSON.stringify(rows)).not.toContain(ownerEmail)
	})

	it('stops that sequence when the step is completed, and the next one starts from there', async () => {
		const { organization, locationId, ownerEmail } = await setup()
		await runSetupReminders(deps(at(0)))
		await runSetupReminders(deps(at(1)))
		expect(emailsTo(ownerEmail)).toHaveLength(1)

		// Day 2: the owner adds the opening hours.
		await db
			.update(OrganizationLocation)
			.set({ storeHours: WEEK })
			.where(eq(OrganizationLocation.id, locationId))

		// The day-3 reminder is not sent: progress was made, the sequence restarts.
		const day3 = await runSetupReminders(deps(at(3)))
		expect(day3).toMatchObject({ sent: 0, reset: 1 })
		expect(emailsTo(ownerEmail)).toHaveLength(1)
		const [state] = await db
			.select()
			.from(SetupReminderState)
			.where(eq(SetupReminderState.organizationId, organization.id))
		expect(state?.progressAt.getTime()).toBe(at(3).getTime())
		expect(state?.lastAutoDay).toBe(0)

		// One day after that progress the reminder names the NEXT step.
		expect((await runSetupReminders(deps(at(4)))).sent).toBe(1)
		const second = emailsTo(ownerEmail)[1]
		expect(second.react.props.heading).toBe(
			'Add your menu with at least five priced dishes, about 15 minutes',
		)
	})

	it('does not email an organization that is live, a test or demo account, or a cancelled one', async () => {
		const live = await setup()
		await db
			.update(OrganizationLocation)
			.set({ liveAt: T0 })
			.where(eq(OrganizationLocation.id, live.locationId))
		const test = await setup()
		await setFlag(test.organization.id, TEST_ACCOUNT_FLAG, true)
		const cancelled = await setup()
		await db
			.update(Organization)
			.set({ subscriptionStatus: 'canceled' })
			.where(eq(Organization.id, cancelled.organization.id))
		const inactive = await setup()
		await db
			.update(Organization)
			.set({ active: false })
			.where(eq(Organization.id, inactive.organization.id))

		await runSetupReminders(deps(at(0)))
		await runSetupReminders(deps(at(1)))
		for (const excluded of [live, test, cancelled, inactive]) {
			expect(emailsTo(excluded.ownerEmail)).toHaveLength(0)
		}
	})

	it('sends nothing while the reminders flag or the launch checklist is off', async () => {
		const noFlag = await setup({ remindersOn: false })
		const noChecklist = await setup({ checklistOn: false })
		await runSetupReminders(deps(at(0)))
		await runSetupReminders(deps(at(1)))
		expect(emailsTo(noFlag.ownerEmail)).toHaveLength(0)
		expect(emailsTo(noChecklist.ownerEmail)).toHaveLength(0)
	})

	it('respects an owner who turned the reminders off, and only emails owners', async () => {
		const { owner, ownerEmail, organization } = await setup()
		const member = await createTestUser()
		await addOrganizationMember(member.id, organization.id, 'org_role_member')
		const [memberRow] = await db
			.select({ email: User.email })
			.from(User)
			.where(eq(User.id, member.id))
		await runSetupReminders(deps(at(0)))
		await runSetupReminders(deps(at(1)))
		expect(emailsTo(ownerEmail)).toHaveLength(1)
		expect(emailsTo(memberRow!.email)).toHaveLength(0)

		await db.insert(NotificationPreference).values({
			userId: owner.id,
			organizationId: organization.id,
			workflow: SETUP_REMINDER_WORKFLOW,
			email: false,
		})
		await runSetupReminders(deps(at(3)))
		expect(emailsTo(ownerEmail)).toHaveLength(1)
	})

	it("writes in the owner's language, right to left in Arabic", async () => {
		const { ownerEmail } = await setup({ locale: 'ar' })
		await runSetupReminders(deps(at(0)))
		await runSetupReminders(deps(at(1)))
		const [email] = emailsTo(ownerEmail)
		expect(email.react.props).toMatchObject({ lang: 'ar', dir: 'rtl' })
		expect(email.react.props.heading).toContain('أضف عنوانك وساعات عملك')
	})

	it('skips a reminder that is long overdue instead of waking an old stall', async () => {
		const { organization, ownerEmail } = await setup()
		// The job only saw this organization on day 20.
		const result = await runSetupReminders(deps(at(20)))
		expect(result.sent).toBe(0)
		expect(emailsTo(ownerEmail)).toHaveLength(0)
		const [state] = await db
			.select()
			.from(SetupReminderState)
			.where(eq(SetupReminderState.organizationId, organization.id))
		expect(state?.lastAutoDay).toBe(7)
	})

	it('counts progress made before the job first saw the organization', async () => {
		const { organization, ownerEmail } = await setup()
		const [step] = await db.query.OnboardingStep.findMany({ limit: 1 })
		const owner = await db.query.UserOrganization.findFirst({
			where: eq(
				(await import('@repo/database')).UserOrganization.organizationId,
				organization.id,
			),
		})
		await db.insert(OnboardingStepProgress).values({
			userId: owner!.userId,
			organizationId: organization.id,
			stepId: step!.id,
			isCompleted: true,
			completedAt: at(5),
		})
		// Progress on day 5: no reminder on day 6, one on day 6 + 0? One day later it is due.
		await runSetupReminders(deps(at(5.5)))
		expect(emailsTo(ownerEmail)).toHaveLength(0)
		await runSetupReminders(deps(at(6.6)))
		expect(emailsTo(ownerEmail)).toHaveLength(1)
	})

	it('gives the day back when no email could be sent, so the next run tries again', async () => {
		const { ownerEmail } = await setup()
		await runSetupReminders(deps(at(0)))
		const failed = await runSetupReminders(deps(at(1), true))
		expect(failed.sent).toBe(0)
		const retried = await runSetupReminders(deps(at(2)))
		expect(retried.sent).toBe(1)
		expect(emailsTo(ownerEmail)).toHaveLength(2)
	})
})

describe("Admin's manual reminder (#271)", () => {
	it('previews what would be sent and to how many people', async () => {
		const { organization } = await setup({ remindersOn: false })
		const preview = await previewSetupReminder(organization.id, deps(at(2)))
		expect(preview).toMatchObject({
			status: 'ok',
			subject: expect.stringContaining('Add your address and opening hours'),
			heading: 'Add your address and opening hours, about 3 minutes',
			recipients: 1,
			locale: 'en',
			nextManualAt: null,
		})
		expect(sendEmail).not.toHaveBeenCalled()
	})

	it('sends one, records it in the history and the audit log, and refuses a second the same day', async () => {
		const { organization, ownerEmail } = await setup({ remindersOn: false })
		const admin = await createTestUser()
		const first = await sendManualSetupReminder(
			{ organizationId: organization.id, adminUserId: admin.id },
			deps(at(2)),
		)
		expect(first).toEqual({ status: 'sent', recipients: 1 })
		expect(emailsTo(ownerEmail)).toHaveLength(1)
		const [row] = await db
			.select()
			.from(SetupReminder)
			.where(eq(SetupReminder.organizationId, organization.id))
		expect(row).toMatchObject({
			kind: 'manual',
			day: null,
			sentById: admin.id,
			stepKey: 'launch_location_details',
		})

		const again = await sendManualSetupReminder(
			{ organizationId: organization.id, adminUserId: admin.id },
			deps(at(2.5)),
		)
		expect(again).toMatchObject({ status: 'limit' })
		expect(emailsTo(ownerEmail)).toHaveLength(1)
		expect(
			(await previewSetupReminder(organization.id, deps(at(2.5)))) as {
				nextManualAt: string
			},
		).toMatchObject({ nextManualAt: at(3).toISOString() })

		// A day later it may go again.
		const later = await sendManualSetupReminder(
			{ organizationId: organization.id, adminUserId: admin.id },
			deps(at(3.1)),
		)
		expect(later).toEqual({ status: 'sent', recipients: 1 })
	})

	it('says nobody can be notified when no owner can receive it', async () => {
		const { organization, owner } = await setup({ remindersOn: false })
		await db.insert(NotificationPreference).values({
			userId: owner.id,
			organizationId: organization.id,
			workflow: SETUP_REMINDER_WORKFLOW,
			email: false,
		})
		const admin = await createTestUser()
		expect(await previewSetupReminder(organization.id, deps(at(2)))).toEqual({
			status: 'nobody_to_notify',
		})
		expect(
			await sendManualSetupReminder(
				{ organizationId: organization.id, adminUserId: admin.id },
				deps(at(2)),
			),
		).toEqual({ status: 'nobody_to_notify' })
		expect(sendEmail).not.toHaveBeenCalled()
		expect(
			await db
				.select()
				.from(SetupReminder)
				.where(eq(SetupReminder.organizationId, organization.id)),
		).toEqual([])
	})

	it('has the same exclusions: test accounts, live organizations and cancelled accounts', async () => {
		const admin = await createTestUser()
		const test = await setup({ remindersOn: false })
		await setFlag(test.organization.id, TEST_ACCOUNT_FLAG, true)
		expect(
			await sendManualSetupReminder(
				{ organizationId: test.organization.id, adminUserId: admin.id },
				deps(at(2)),
			),
		).toEqual({ status: 'excluded', reason: 'test' })

		const cancelled = await setup({ remindersOn: false })
		await db
			.update(Organization)
			.set({ subscriptionStatus: 'canceled' })
			.where(eq(Organization.id, cancelled.organization.id))
		expect(
			await sendManualSetupReminder(
				{ organizationId: cancelled.organization.id, adminUserId: admin.id },
				deps(at(2)),
			),
		).toEqual({ status: 'excluded', reason: 'cancelled' })

		const live = await setup({ remindersOn: false })
		await db
			.update(OrganizationLocation)
			.set({ liveAt: T0 })
			.where(eq(OrganizationLocation.id, live.locationId))
		expect(
			await sendManualSetupReminder(
				{ organizationId: live.organization.id, adminUserId: admin.id },
				deps(at(2)),
			),
		).toEqual({ status: 'live' })
		expect(sendEmail).not.toHaveBeenCalledWith(
			expect.objectContaining({ to: test.ownerEmail }),
		)
		expect(sendEmail).not.toHaveBeenCalledWith(
			expect.objectContaining({ to: cancelled.ownerEmail }),
		)
		expect(sendEmail).not.toHaveBeenCalledWith(
			expect.objectContaining({ to: live.ownerEmail }),
		)
	})
})
