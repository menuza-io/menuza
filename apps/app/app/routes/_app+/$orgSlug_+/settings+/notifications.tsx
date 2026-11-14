import { parseWithZod } from '@conform-to/zod/v4'
import { AuditAction, auditService } from '@repo/audit'
import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
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
import { GuestMessagesCard } from '#app/components/settings/cards/guest-messages-card.tsx'
import { NotificationPreferencesCard } from '#app/components/settings/cards/notification-preferences-card.tsx'
import {
	isGuestMessagesEnabled,
	readGuestMessageSwitches,
	saveGuestMessageSwitches,
} from '#app/utils/guest-messages/settings.server.ts'
import { inventoryAlertSettingsVisible } from '#app/utils/inventory/notification-visibility.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
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
	const org = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	if (!(await isGuestMessagesEnabled(org.id)))
		throw new Response('Not found', { status: 404 })
	const actorId = await requireUserWithOrganizationPermission(
		request,
		org.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	const submission = parseWithZod(await request.formData(), {
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
	})
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
	// Reservations alerts are offered where the module is on and the member is
	// one of the people the alerts are sent to.
	const showReservationsAlerts = (
		await reservationAlertVisibleOrgIds(userId, [org.id])
	).has(org.id)
	// Inventory alerts are offered where the module is on and the member holds
	// an inventory grant; price rises also need the cost grant.
	const inventoryAlerts = await inventoryAlertSettingsVisible(userId, org.id)
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
	return {
		organizationId: org.id,
		guestMessages,
		showStaffingAlerts,
		showScheduleAlerts,
		showHiringAlerts,
		showReservationsAlerts,
		showInventoryAlerts: inventoryAlerts.any,
		showInventoryPriceAlerts: inventoryAlerts.priceRise,
	}
}

export default function NotificationSettings() {
	const {
		organizationId,
		guestMessages,
		showStaffingAlerts,
		showScheduleAlerts,
		showHiringAlerts,
		showReservationsAlerts,
		showInventoryAlerts,
		showInventoryPriceAlerts,
	} = useLoaderData<typeof loader>()
	return (
		<AnnotatedLayout>
			<AnnotatedSection>
				<NotificationPreferencesCard
					organizationId={organizationId}
					showStaffingAlerts={showStaffingAlerts}
					showScheduleAlerts={showScheduleAlerts}
					showHiringAlerts={showHiringAlerts}
					showReservationsAlerts={showReservationsAlerts}
					showInventoryAlerts={showInventoryAlerts}
					showInventoryPriceAlerts={showInventoryPriceAlerts}
				/>
			</AnnotatedSection>
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
