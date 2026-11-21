import { parseWithZod } from '@conform-to/zod/v4'
import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import { invalidateUserOrganizationsCache } from '@repo/cache'
import {
	ACTION_KINDS,
	hasExternalTarget,
	parseActionTargets,
} from '@repo/common/action-targets'
import {
	parseSiteLocalesConfig,
	pickLocalized,
	serializeSiteLocales,
	type SiteContentLocale,
} from '@repo/common/site-locales'
import { redirectWithToast } from '@repo/common/toast'
import { namesLeftBlank } from '@repo/common/translation-status'
import {
	and,
	asc,
	db,
	desc,
	eq,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useLoaderData,
	useActionData,
} from 'react-router'

import {
	SiteCard,
	SitePublishSchema,
	SiteDataRegionSchema,
	sitePublishActionIntent,
	siteDataRegionActionIntent,
} from '#app/components/settings/cards/organization/site-card.tsx'
import {
	SiteLocalesCard,
	SiteLocalesSchema,
	LOCALE_NAMES_LEFT_BLANK,
	siteLocalesActionIntent,
} from '#app/components/settings/cards/organization/site-locales-card.tsx'
import {
	ActionTargetsCard,
	actionTargetsActionIntent,
} from '#app/components/website/action-targets-card.tsx'
import { useOutboundCounts } from '#app/components/website/use-outbound-counts.ts'
import { resetSenderDomainForRegionChange } from '#app/utils/email-sender/sender.server.ts'
import { loadTranslatableRecords } from '#app/utils/menu/translation-status.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import { notifyReservationsContextChanged } from '#app/utils/reservations/access.server.ts'
import { summaryHasUnsettledPayments } from '#app/utils/reservations/region-confirmation.ts'
import {
	evaluateReservationsRegionGuard,
	fetchReservationsSummary,
} from '#app/utils/reservations/region-guard.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	deprovisionTenantDatabase,
	provisionTenantDatabase,
} from '#app/utils/sites/tenant-api.server.ts'
import { cancelPendingStaffingOutbox } from '#app/utils/staffing/outbox.server.ts'
import {
	evaluateRegionGuard,
	fetchStaffSummary,
} from '#app/utils/staffing/region-guard.server.ts'
import {
	saveActionTargets,
	type ActionTargetsForm,
} from '#app/utils/website/action-targets.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)

	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
		sitePublished: true,
		customDomain: true,
		customDomainStatus: true,
		siteLocales: true,
		siteDefaultLocale: true,
		dataRegion: true,
		hasProvisionedDb: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)

	// Where the Order, Gift cards and Reservations buttons go (#318).
	const defaultLocale = organization.siteDefaultLocale || 'en'
	const locationRows = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			actionTargets: OrganizationLocation.actionTargets,
		})
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		)
	const [orgTargets] = await db
		.select({ actionTargets: Organization.actionTargets })
		.from(Organization)
		.where(eq(Organization.id, organization.id))
		.limit(1)
	const actionTargets = {
		organization: parseActionTargets(orgTargets?.actionTargets),
		locations: locationRows.map((row) => ({
			id: row.id,
			name: pickLocalized(row.name, defaultLocale, defaultLocale) || row.name,
			targets: parseActionTargets(row.actionTargets),
		})),
	}
	const canEditActionTargets = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)

	return {
		organization,
		localesConfig: parseSiteLocalesConfig(
			organization.siteLocales,
			organization.siteDefaultLocale,
		),
		actionTargets,
		canEditActionTargets,
		showOutboundCounts: hasExternalTarget({
			organization: actionTargets.organization,
			locations: Object.fromEntries(
				actionTargets.locations.map((location) => [
					location.id,
					location.targets,
				]),
			),
		}),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		customDomain: true,
		dataRegion: true,
		hasProvisionedDb: true,
		sitePublished: true,
		updatedAt: true,
	})

	const formData = await request.formData()
	const intent = formData.get('intent')

	const requirePermission = async (
		permission: Parameters<typeof requireUserWithOrganizationPermission>[2],
	) => {
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			permission,
		)
	}

	if (intent === sitePublishActionIntent) {
		await requirePermission(ORG_PERMISSIONS.UPDATE_WEBSITE_ANY)

		const submission = parseWithZod(formData, {
			schema: SitePublishSchema,
		})

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() })
		}

		const { sitePublished } = submission.value
		const published = sitePublished === 'true'

		try {
			// Compatibility repair for organizations created before eager provisioning.
			if (published && !organization.hasProvisionedDb) {
				await provisionTenantDatabase({
					orgId: organization.id,
					dataRegion: organization.dataRegion,
					slug: organization.slug,
					customDomain: organization.customDomain,
				})
			}

			await db
				.update(Organization)
				.set({
					sitePublished: published,
					...(published ? { hasProvisionedDb: true } : {}),
				})
				.where(eq(Organization.id, organization.id))
			await notifyReservationsContextChanged(organization.id, 'branding')

			await invalidateUserOrganizationsCache(userId)
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)

			return Response.json({
				status: 'success',
				sitePublished: published,
			})
		} catch (error) {
			console.error('Failed to update site publish settings:', error)
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: 'Failed to update site publish settings',
				},
				{ status: 500 },
			)
		}
	}

	if (intent === siteDataRegionActionIntent) {
		await requirePermission(ORG_PERMISSIONS.UPDATE_SETTINGS_ANY)

		const submission = parseWithZod(formData, {
			schema: SiteDataRegionSchema,
		})

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() })
		}

		const { dataRegion } = submission.value
		const currentRegion = organization.dataRegion === 'ksa' ? 'ksa' : 'us'

		if (dataRegion === currentRegion && organization.hasProvisionedDb) {
			return redirectWithToast(`/${organization.slug}/website`, {
				title: 'Data region unchanged',
				description: 'Customer data is already stored in this region.',
				type: 'message',
			})
		}

		if (
			organization.hasProvisionedDb &&
			submission.value.confirmWipe !== 'true'
		) {
			return Response.json(
				{
					error:
						'Changing region deletes existing customer data. Confirm the wipe and try again.',
				},
				{ status: 400 },
			)
		}

		if (organization.hasProvisionedDb) {
			// Staff and reservation records live in the old region's database and are
			// destroyed by the wipe. Ask that region what it holds (counts only), and
			// when there is anything to lose (or the answer is unknown) require the
			// admin to have typed the organization's slug.
			const [summary, reservationsSummary] = await Promise.all([
				fetchStaffSummary({
					organizationId: organization.id,
					dataRegion: currentRegion,
				}),
				fetchReservationsSummary({
					organizationId: organization.id,
					dataRegion: currentRegion,
				}),
			])

			if (summaryHasUnsettledPayments(reservationsSummary)) {
				return Response.json(
					{
						error:
							'This organization has unsettled reservation payments in the current region. Settle or refund them before switching regions.',
						code: 'payments_unsettled',
						reservationsSummary,
					},
					{ status: 409 },
				)
			}

			const guard = evaluateRegionGuard({
				summary,
				typedConfirmation: submission.value.confirmText,
				slug: organization.slug,
			})
			if (!guard.allowed) {
				return Response.json(
					{
						error:
							'This organization has staff records in the current region that would be deleted. Type the organization slug to confirm.',
						staffConfirmationRequired: true,
						summary: guard.summary,
					},
					{ status: 400 },
				)
			}

			const reservationsGuard = evaluateReservationsRegionGuard({
				summary: reservationsSummary,
				typedConfirmation: submission.value.confirmText,
				slug: organization.slug,
			})
			if (!reservationsGuard.allowed) {
				return Response.json(
					{
						error:
							reservationsGuard.summary === null
								? 'Could not reach the regional reservation service to check existing records. Type the organization slug to confirm.'
								: 'This organization has reservation records in the current region that would be deleted. Type the organization slug to confirm.',
						reservationsConfirmationRequired: true,
						reservationsSummary: reservationsGuard.summary,
						summary: reservationsGuard.summary,
					},
					{ status: 400 },
				)
			}
		}

		const regionChangedConcurrently = () =>
			Response.json(
				{
					error:
						'The data region was changed by someone else. Reload the page and try again.',
				},
				{ status: 409 },
			)

		// Every write below is conditional on the row this request last wrote
		// (or read), and moves `updatedAt` forward, so of two concurrent
		// switches or retries exactly one goes on: the other fails its next
		// write and stops. The first write is the claim, made before anything
		// is deleted.
		const nextStamp = (previous: Date) =>
			new Date(Math.max(Date.now(), previous.getTime() + 1))

		try {
			// Record the database as unavailable before any irreversible deletion.
			// Keep the old region until its wipe succeeds so retries target it.
			// When the flag is already false (a retry of an unfinished switch) the
			// claim only moves the stamp, but still lets one request through.
			const claimedAt = nextStamp(organization.updatedAt)
			const [claimed] = await db
				.update(Organization)
				.set({ hasProvisionedDb: false, updatedAt: claimedAt })
				.where(
					and(
						eq(Organization.id, organization.id),
						eq(Organization.dataRegion, currentRegion),
						eq(Organization.hasProvisionedDb, organization.hasProvisionedDb),
						eq(Organization.updatedAt, organization.updatedAt),
					),
				)
				.returning({ id: Organization.id })
			if (!claimed) return regionChangedConcurrently()

			// Always wipe the current region first. With the flag already false a
			// database may still exist there (an earlier wipe failed after the flag
			// was cleared), and re-provisioning the same region must not quietly
			// keep it: its staff erasures were skipped while it was unavailable.
			// Deleting a database that does not exist is a no-op on tenant-api.
			await deprovisionTenantDatabase({
				orgId: organization.id,
				dataRegion: currentRegion,
				slug: organization.slug,
				customDomain: organization.customDomain,
			})

			const movedAt = nextStamp(claimedAt)
			const [moved] = await db
				.update(Organization)
				.set({ dataRegion, hasProvisionedDb: false, updatedAt: movedAt })
				.where(
					and(
						eq(Organization.id, organization.id),
						eq(Organization.dataRegion, currentRegion),
						eq(Organization.hasProvisionedDb, false),
						eq(Organization.updatedAt, claimedAt),
					),
				)
				.returning({ id: Organization.id })
			if (!moved) return regionChangedConcurrently()

			await provisionTenantDatabase({
				orgId: organization.id,
				dataRegion,
				slug: organization.slug,
				customDomain: organization.customDomain,
			})
			const [provisioned] = await db
				.update(Organization)
				.set({ hasProvisionedDb: true })
				.where(
					and(
						eq(Organization.id, organization.id),
						eq(Organization.dataRegion, dataRegion),
						eq(Organization.hasProvisionedDb, false),
						eq(Organization.updatedAt, movedAt),
					),
				)
				.returning({ id: Organization.id })
			if (!provisioned) return regionChangedConcurrently()

			// Queued staffing events were addressed to the old region's database,
			// which no longer exists; the new region starts empty. This includes
			// events queued while an earlier switch had left the flag cleared.
			await cancelPendingStaffingOutbox(organization.id, 'region_changed')

			// A custom sending domain is verified per region (#103): it is set up
			// again in the new one and shows Pending until its records verify.
			await resetSenderDomainForRegionChange(organization.id, dataRegion).catch(
				(error) => {
					console.error(
						'Resetting the sending domain after a region change failed:',
						error instanceof Error ? error.message : error,
					)
				},
			)

			await invalidateUserOrganizationsCache(userId)
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)

			return redirectWithToast(`/${organization.slug}/website`, {
				title: 'Data region updated',
				description: organization.hasProvisionedDb
					? dataRegion === 'ksa'
						? 'Previous customer data was deleted. New sign-ins will stay in Saudi Arabia.'
						: 'Previous customer data was deleted. New sign-ins will be stored in the US.'
					: dataRegion === 'ksa'
						? 'The tenant database is ready in Saudi Arabia.'
						: 'The tenant database is ready in the US region.',
				type: 'success',
			})
		} catch (error) {
			console.error('Failed to update data region:', error)
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: 'Failed to update data region',
				},
				{ status: 500 },
			)
		}
	}

	if (intent === actionTargetsActionIntent) {
		await requirePermission(ORG_PERMISSIONS.UPDATE_WEBSITE_ANY)
		const form: ActionTargetsForm = {}
		for (const kind of ACTION_KINDS) {
			const mode = formData.get(`${kind}Mode`)
			if (mode === 'menuza' || mode === 'external' || mode === 'inherit') {
				const url = formData.get(`${kind}Url`)
				form[kind] = { mode, url: typeof url === 'string' ? url : undefined }
			}
		}
		const locationId = formData.get('locationId')
		const result = await saveActionTargets({
			organizationId: organization.id,
			locationId:
				typeof locationId === 'string' && locationId ? locationId : null,
			form,
		})
		if (!result.ok) {
			return Response.json(
				{ ok: false, error: result.error, kind: result.kind },
				{ status: result.error === 'not_found' ? 404 : 400 },
			)
		}
		// Every button, link, page and structured data reads this: one purge.
		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ ok: true })
	}

	if (intent === siteLocalesActionIntent) {
		await requirePermission(ORG_PERMISSIONS.UPDATE_WEBSITE_ANY)

		const submission = parseWithZod(formData, {
			schema: SiteLocalesSchema,
		})

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() })
		}

		const { locales, defaultLocale } = submission.value

		// #410: never remove a language that holds the only name of a dish,
		// option, option group or category.
		const blankNames = namesLeftBlank(
			await loadTranslatableRecords(organization.id),
			{ nextLocales: locales, defaultLocale },
		)
		if (blankNames.length > 0) {
			return Response.json({
				result: submission.reply({
					fieldErrors: { locales: [LOCALE_NAMES_LEFT_BLANK] },
				}),
				blankNames: {
					count: blankNames.length,
					examples: blankNames.slice(0, 5).map((record) => record.label),
				},
			})
		}

		try {
			await db
				.update(Organization)
				.set({
					siteLocales: serializeSiteLocales(locales as SiteContentLocale[]),
					siteDefaultLocale: defaultLocale,
				})
				.where(eq(Organization.id, organization.id))
			await notifyReservationsContextChanged(organization.id, 'branding')

			await invalidateUserOrganizationsCache(userId)
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)

			return redirectWithToast(`/${organization.slug}/website`, {
				title: 'Languages updated',
				description: 'Your website languages have been saved.',
				type: 'success',
			})
		} catch {
			return Response.json({
				result: submission.reply({
					formErrors: ['Failed to update languages. Please try again.'],
				}),
			})
		}
	}

	return Response.json({ error: `Invalid intent: ${intent}` }, { status: 400 })
}

export default function WebsiteGeneralSettings() {
	const {
		organization,
		localesConfig,
		actionTargets,
		canEditActionTargets,
		showOutboundCounts,
	} = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const outbound = useOutboundCounts(organization.slug, showOutboundCounts)

	return (
		<AnnotatedLayout className="max-w-4xl">
			<AnnotatedSection>
				<SiteCard organization={organization} />
			</AnnotatedSection>

			<AnnotatedSection>
				<SiteLocalesCard
					organization={organization}
					localesConfig={localesConfig}
					actionData={actionData}
				/>
			</AnnotatedSection>

			<AnnotatedSection>
				<ActionTargetsCard
					data={actionTargets}
					canEdit={canEditActionTargets}
					outbound={outbound}
				/>
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}
