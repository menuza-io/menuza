import { parseWithZod } from '@conform-to/zod/v4'
import { AuditAction, auditService } from '@repo/audit'
import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import { db, eq, SSOConfiguration } from '@repo/database'
import { STAFFING_PERMISSIONS } from '@repo/staffing'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import {
	data,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { AlertSettingsCard } from '#app/components/settings/cards/alert-settings-card.tsx'
import { GuestMessagesCard } from '#app/components/settings/cards/guest-messages-card.tsx'
import { NotificationPreferencesCard } from '#app/components/settings/cards/notification-preferences-card.tsx'
import { ReportEmailsCard } from '#app/components/settings/cards/report-emails-card.tsx'
import { SetupRemindersCard } from '#app/components/settings/cards/setup-reminders-card.tsx'
import { availablePushCategories } from '#app/utils/alerts/settings.server.ts'
import {
	isGuestMessagesEnabled,
	readGuestMessageSwitches,
	saveGuestMessageSwitches,
} from '#app/utils/guest-messages/settings.server.ts'
import { inventoryAlertSettingsVisible } from '#app/utils/inventory/notification-visibility.server.ts'
import { isOrganizationOwner } from '#app/utils/legal/agreements.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	monthlyResultsEmailEnabled,
	setSetupReminderEmail,
	setupReminderEmailEnabled,
} from '#app/utils/reports/report-unsubscribe.server.ts'
import { listMemberReportEmails } from '#app/utils/reports/schedules.server.ts'
import { reservationAlertVisibleOrgIds } from '#app/utils/reservations/notification-visibility.server.ts'
import {
	isStaffingFeatureEnabled,
	userHasStaffingPermission,
} from '#app/utils/staffing/access.server.ts'

const guestMessagesSchema = z.object({
	receipt: z.enum(['true', 'false']).transform((value) => value === 'true'),
	ready: z.enum(['true', 'false']).transform((value) => value === 'true'),
	cancelled: z.enum(['true', 'false']).transform((value) => value === 'true'),
})

/**
 * Saves the Guest order messages switches. Behind the org's
 * `ordering.guest_messages` flag (404 while off, before anything is written)
 * and `update:settings:any`. Policy only, no guest data.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const org = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	const form = await request.formData()
	// Setup reminders (#271): each owner switches their own email on or off.
	if (form.get('intent') === 'setup-reminders') {
		if (!(await isOrganizationOwner(userId, org.id))) {
			throw new Response('Forbidden', { status: 403 })
		}
		await setSetupReminderEmail({
			userId,
			organizationId: org.id,
			email: form.get('enabled') === 'true',
		})
		return data({ ok: true, error: null })
	}
	if (!(await isGuestMessagesEnabled(org.id)))
		throw new Response('Not found', { status: 404 })
	const actorId = await requireUserWithOrganizationPermission(
		request,
		org.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	const submission = parseWithZod(form, {
		schema: guestMessagesSchema,
	})
	if (submission.status !== 'success')
		return data({ ok: false, error: 'invalid_request' }, { status: 400 })
	await saveGuestMessageSwitches(org.id, submission.value)
	await auditService.log({
		action: AuditAction.ORG_SETTINGS_UPDATED,
		userId: actorId,
		organizationId: org.id,
		resourceType: 'organization',
		resourceId: org.id,
		details: 'Guest order messages updated',
		metadata: { ...submission.value },
		request,
	})
	return data({ ok: true, error: null })
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const org = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	// Report emails (#121, #221): the member's own scheduled reports, and the
	// monthly results email for the people it goes to (those who run settings).
	const reportSchedules = await listMemberReportEmails({
		userId,
		organizationId: org.id,
	})
	const receivesMonthly = await userHasOrganizationPermission(
		userId,
		org.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	const reportEmails = {
		orgSlug: org.slug,
		schedules: reportSchedules,
		monthly: receivesMonthly
			? { on: await monthlyResultsEmailEnabled(userId, org.id) }
			: null,
	}
	// Time clock alerts are offered only where they can arrive: the time clock
	// flag is on and this member can read timesheets (what the alerts open).
	const showStaffingAlerts =
		(await isStaffingFeatureEnabled(org.id, 'timeclock')) &&
		(await userHasStaffingPermission(
			userId,
			org.id,
			STAFFING_PERMISSIONS.READ_TIMESHEET,
		))
	// A published schedule is offered where scheduling is on and the member can
	// read the schedule it opens.
	const showScheduleAlerts =
		(await isStaffingFeatureEnabled(org.id, 'scheduling')) &&
		(await userHasStaffingPermission(
			userId,
			org.id,
			STAFFING_PERMISSIONS.READ_SCHEDULE,
		))
	// New applicants are offered where hiring is on and the member can read the
	// applicants they open.
	const showHiringAlerts =
		(await isStaffingFeatureEnabled(org.id, 'hiring')) &&
		(await userHasStaffingPermission(
			userId,
			org.id,
			STAFFING_PERMISSIONS.READ_HIRING,
		))
	// Form response alerts go to members who can read website forms (#142).
	const showFormAlerts = await userHasOrganizationPermission(
		userId,
		org.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	// Single sign-on failure notices (#347) are offered to the people who run
	// settings, where single sign-on is set up.
	const showSsoAlerts =
		receivesMonthly &&
		(await db
			.select({ id: SSOConfiguration.id })
			.from(SSOConfiguration)
			.where(eq(SSOConfiguration.organizationId, org.id))
			.limit(1)
			.then((rows) => rows.length > 0))
	// Reservations alerts are offered where the module is on and the member is
	// one of the people the alerts are sent to.
	const showReservationsAlerts = (
		await reservationAlertVisibleOrgIds(userId, [org.id])
	).has(org.id)
	// Inventory alerts are offered where the module is on and the member holds
	// an inventory grant; price rises also need the cost grant.
	const inventoryAlerts = await inventoryAlertSettingsVisible(userId, org.id)
	// Order and tablet alerts: offered where the organization has them on and the
	// member can act on them (orders: the menu read grant; tablets: settings).
	const alertCategories = await availablePushCategories(userId, org.id)
	// Guest order messages: offered only while the org flag is on; read-only
	// without `update:settings:any`.
	const guestMessagesOn = await isGuestMessagesEnabled(org.id)
	const guestMessages = guestMessagesOn
		? {
				switches: await readGuestMessageSwitches(org.id),
				canEdit: await userHasOrganizationPermission(
					userId,
					org.id,
					ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
				),
			}
		: null
	// Setup reminders (#271) go to owners: each owner has their own switch.
	const setupReminders = (await isOrganizationOwner(userId, org.id))
		? { on: await setupReminderEmailEnabled(userId, org.id) }
		: null
	return {
		organizationId: org.id,
		setupReminders,
		reportEmails,
		guestMessages,
		showStaffingAlerts,
		showScheduleAlerts,
		showHiringAlerts,
		showFormAlerts,
		showSsoAlerts,
		showReservationsAlerts,
		showInventoryAlerts: inventoryAlerts.any,
		showInventoryPriceAlerts: inventoryAlerts.priceRise,
		showOrderAlerts: alertCategories.new_orders,
		showStationAlerts: alertCategories.station_offline,
	}
}

export default function NotificationSettings() {
	const {
		organizationId,
		setupReminders,
		reportEmails,
		guestMessages,
		showStaffingAlerts,
		showScheduleAlerts,
		showHiringAlerts,
		showFormAlerts,
		showSsoAlerts,
		showReservationsAlerts,
		showInventoryAlerts,
		showInventoryPriceAlerts,
		showOrderAlerts,
		showStationAlerts,
	} = useLoaderData<typeof loader>()
	return (
		<AnnotatedLayout>
			<AnnotatedSection>
				<NotificationPreferencesCard
					organizationId={organizationId}
					showStaffingAlerts={showStaffingAlerts}
					showScheduleAlerts={showScheduleAlerts}
					showHiringAlerts={showHiringAlerts}
					showFormAlerts={showFormAlerts}
					showSsoAlerts={showSsoAlerts}
					showReservationsAlerts={showReservationsAlerts}
					showInventoryAlerts={showInventoryAlerts}
					showInventoryPriceAlerts={showInventoryPriceAlerts}
					showOrderAlerts={showOrderAlerts}
					showStationAlerts={showStationAlerts}
				/>
			</AnnotatedSection>
			<AnnotatedSection>
				<AlertSettingsCard organizationId={organizationId} />
			</AnnotatedSection>
			{setupReminders ? (
				<AnnotatedSection>
					<SetupRemindersCard on={setupReminders.on} />
				</AnnotatedSection>
			) : null}
			{reportEmails.schedules.length > 0 || reportEmails.monthly ? (
				<AnnotatedSection>
					<ReportEmailsCard
						orgSlug={reportEmails.orgSlug}
						schedules={reportEmails.schedules}
						monthly={reportEmails.monthly}
					/>
				</AnnotatedSection>
			) : null}
			{guestMessages ? (
				<AnnotatedSection>
					<GuestMessagesCard
						switches={guestMessages.switches}
						canEdit={guestMessages.canEdit}
					/>
				</AnnotatedSection>
			) : null}
		</AnnotatedLayout>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
