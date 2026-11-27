import { db, eq, Notification, PaymentAccountStatus } from '@repo/database'
import { PaymentAccountAlertEmail } from '@repo/email'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	process.env.BASE_URL = 'https://app.menuza.test:2999'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

const sendEmailMock = vi.fn().mockResolvedValue({ status: 'success' })

vi.mock('@repo/email', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/email')>()
	return {
		...actual,
		sendEmail: (...args: unknown[]) => sendEmailMock(...args),
	}
})

import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import {
	runDailyPaymentAccountDeadlineChecks,
	syncPaymentAccountStatusAndNotify,
} from './account-alerts.server.ts'
import {
	describeRequirementCode,
	duePaymentAccountReminderBucket,
	evaluatePaymentAccountState,
	UNKNOWN_REQUIREMENT_MESSAGE,
} from './account-status.ts'

describe('payment account status & alerts (#269)', () => {
	beforeEach(() => {
		sendEmailMock.mockClear()
	})

	it('maps known requirement codes and falls back to generic sentence for unknown codes', () => {
		expect(describeRequirementCode('external_account')).toContain(
			'bank account',
		)
		expect(
			describeRequirementCode('person_abc123.verification.document'),
		).toContain('photo ID')
		expect(describeRequirementCode('some_new_provider_code_xyz')).toBe(
			UNKNOWN_REQUIREMENT_MESSAGE,
		)
	})

	it('evaluates Active, Action needed, Payouts paused, and Cannot take payments', () => {
		const deadline = new Date('2027-01-15T00:00:00Z')
		expect(
			evaluatePaymentAccountState({
				chargesEnabled: true,
				payoutsEnabled: true,
				requirementsDue: [],
				deadline: null,
			}).state,
		).toBe('active')

		expect(
			evaluatePaymentAccountState({
				chargesEnabled: true,
				payoutsEnabled: true,
				requirementsDue: ['company.tax_id'],
				deadline,
			}).state,
		).toBe('action_needed')

		expect(
			evaluatePaymentAccountState({
				chargesEnabled: true,
				payoutsEnabled: false,
				requirementsDue: ['external_account'],
				deadline: null,
			}).state,
		).toBe('payouts_paused')

		expect(
			evaluatePaymentAccountState({
				chargesEnabled: false,
				payoutsEnabled: false,
				requirementsDue: ['individual.verification.document'],
				deadline: null,
			}).state,
		).toBe('cannot_take_payments')
	})

	it('computes 7, 3, 1, and 0-day deadline buckets', () => {
		const deadline = new Date('2027-01-15T12:00:00Z')
		const DAY = 86_400_000
		expect(
			duePaymentAccountReminderBucket(deadline, deadline.getTime() - 10 * DAY),
		).toBeNull()
		expect(
			duePaymentAccountReminderBucket(deadline, deadline.getTime() - 6 * DAY),
		).toBe(7)
		expect(
			duePaymentAccountReminderBucket(deadline, deadline.getTime() - 2.5 * DAY),
		).toBe(3)
		expect(
			duePaymentAccountReminderBucket(deadline, deadline.getTime() - 0.5 * DAY),
		).toBe(1)
		expect(
			duePaymentAccountReminderBucket(deadline, deadline.getTime() + 1000),
		).toBe(0)
	})

	it('notifies once per state change, sends 7/3/1 reminders, and sends one recovery email then stops', async () => {
		const { organization } = await setupTestOrgWithUser()
		const DAY = 86_400_000
		const baseNow = new Date('2027-01-01T12:00:00Z')
		const deadline = new Date(baseNow.getTime() + 10 * DAY)

		// 1. Initial requirement due (10 days away) -> 1 email + 1 notification
		const first = await syncPaymentAccountStatusAndNotify({
			organizationId: organization.id,
			provider: 'connect',
			providerAccountId: 'acct_test_269',
			chargesEnabled: true,
			payoutsEnabled: true,
			requirementsDue: ['company.tax_id'],
			deadline,
			now: baseNow,
		})
		expect(first.state).toBe('action_needed')
		expect(first.notified).toBe(1)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)

		// 2. Duplicate webhook with identical state -> 0 new emails
		const dup = await syncPaymentAccountStatusAndNotify({
			organizationId: organization.id,
			provider: 'connect',
			providerAccountId: 'acct_test_269',
			chargesEnabled: true,
			payoutsEnabled: true,
			requirementsDue: ['company.tax_id'],
			deadline,
			now: new Date(baseNow.getTime() + 60_000),
		})
		expect(dup.notified).toBe(0)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)

		// 3. Daily check at 6 days before deadline -> 7-day reminder fires once
		const rem7 = await runDailyPaymentAccountDeadlineChecks(
			deadline.getTime() - 6 * DAY,
		)
		expect(rem7.reminded).toBeGreaterThanOrEqual(1)
		const afterRem7 = sendEmailMock.mock.calls.length
		// Repeat at 5 days -> does not re-fire 7-day bucket
		await runDailyPaymentAccountDeadlineChecks(deadline.getTime() - 5 * DAY)
		expect(sendEmailMock).toHaveBeenCalledTimes(afterRem7)

		// 4. Daily check at 2.5 days -> 3-day reminder fires
		await runDailyPaymentAccountDeadlineChecks(deadline.getTime() - 2.5 * DAY)
		expect(sendEmailMock.mock.calls.length).toBeGreaterThan(afterRem7)
		const afterRem3 = sendEmailMock.mock.calls.length

		// 5. Daily check at 12 hours -> 1-day reminder fires
		await runDailyPaymentAccountDeadlineChecks(deadline.getTime() - 0.5 * DAY)
		expect(sendEmailMock.mock.calls.length).toBeGreaterThan(afterRem3)
		const afterRem1 = sendEmailMock.mock.calls.length

		// 6. Account recovers -> 1 "All set" email
		const recovered = await syncPaymentAccountStatusAndNotify({
			organizationId: organization.id,
			provider: 'connect',
			providerAccountId: 'acct_test_269',
			chargesEnabled: true,
			payoutsEnabled: true,
			requirementsDue: [],
			deadline: null,
			now: new Date(deadline.getTime() - 0.2 * DAY),
		})
		expect(recovered.state).toBe('active')
		expect(recovered.recovered).toBe(true)
		expect(sendEmailMock).toHaveBeenCalledTimes(afterRem1 + 1)

		// 7. After recovery, daily checks send NO further reminders
		await runDailyPaymentAccountDeadlineChecks(deadline.getTime() + DAY)
		expect(sendEmailMock).toHaveBeenCalledTimes(afterRem1 + 1)

		// Verify in-app notifications were created
		const notifs = await db
			.select()
			.from(Notification)
			.where(eq(Notification.organizationId, organization.id))
		expect(notifs.length).toBeGreaterThanOrEqual(5)

		// Clean up
		await db
			.delete(PaymentAccountStatus)
			.where(eq(PaymentAccountStatus.organizationId, organization.id))
	})

	it('renders email with org/location names and plain wording, never bank or document data', () => {
		const html = renderToStaticMarkup(
			PaymentAccountAlertEmail({
				organizationName: 'Cedar Grill',
				locationNames: ['Downtown', 'Midtown'],
				state: 'action_needed',
				requirements: ['Provide your business tax identification number'],
				deadlineLabel: 'Jan 15, 2027',
				actionUrl: 'https://app.menuza.test:2999/cedar-grill/settings/shop',
			}),
		)
		expect(html).toContain('Cedar Grill')
		expect(html).toContain('Downtown, Midtown')
		expect(html).toContain('Provide your business tax identification number')
		expect(html).toContain('Jan 15, 2027')
		expect(html).toContain('never includes bank account numbers')
	})
})
