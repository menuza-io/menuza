import { requireUserId } from '@repo/auth'
import {
	GBP_SYNC_FIELDS,
	type GbpSyncField,
	parseFieldsSynced,
	type VerificationOption,
} from '@repo/common/gbp-listing'
import {
	and,
	db,
	desc,
	eq,
	GbpListingIssue,
	GbpLocationSync,
	GbpSyncEvent,
	Integration,
	OrganizationMediaAsset,
} from '@repo/database'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { gbpFlags, loadGbpContext } from '#app/utils/gbp/context.server.ts'
import {
	addNewDishPhotos,
	getAutoPhotos,
	listPhotoRows,
	loadPublishResult,
	publishMenu,
	savePhotoSelection,
	setAutoPhotos,
	setMenuSync,
	syncPhotos,
} from '#app/utils/gbp/menu.server.ts'
import {
	lastPreferredChange,
	listOrderLinkSnapshot,
	makeMenuzaPreferred,
	refreshOrderLinks,
	syncSiteLinks,
	undoPreferredChange,
} from '#app/utils/gbp/order-links.server.ts'
import {
	draftDescription,
	loadProfileView,
	saveProfile,
	syncDerivedAttributes,
} from '#app/utils/gbp/profile.server.ts'
import {
	pullLocation,
	pushLocationToGoogle,
	resolveIssue,
	setSyncSettings,
} from '#app/utils/gbp/sync.server.ts'
import {
	refreshVerification,
	requestVerification,
	submitVerificationCode,
} from '#app/utils/gbp/verification.server.ts'
import { resolveMemberLocationIds } from '#app/utils/location/member-scope.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback
	try {
		return JSON.parse(raw) as T
	} catch {
		return fallback
	}
}

async function assertLocationScope(
	userId: string,
	organizationId: string,
	locationId: string,
) {
	const allowed = await resolveMemberLocationIds(userId, organizationId)
	if (allowed !== null && !allowed.includes(locationId)) {
		throw new Response('Forbidden', { status: 403 })
	}
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		name: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_SETTINGS_ANY,
	)

	const locationId = params.locationId
	if (!locationId) {
		return Response.json(
			{ error: 'Location ID is required' },
			{ status: 400, headers: NO_STORE },
		)
	}
	await assertLocationScope(userId, organization.id, locationId)

	const flags = await gbpFlags(organization.id)
	if (!flags.sync) {
		return Response.json(
			{ enabled: false, linked: false, flags },
			{ headers: NO_STORE },
		)
	}

	const ctx = await loadGbpContext(organization.id, locationId)
	if (!ctx) {
		return Response.json(
			{ enabled: true, linked: false, flags },
			{ headers: NO_STORE },
		)
	}

	const url = new URL(request.url)
	const includeProfile = url.searchParams.get('includeProfile') === '1'

	const [
		issues,
		events,
		orderLinks,
		preferredUndo,
		photoRows,
		autoPhotos,
		mediaAssets,
		profile,
	] = await Promise.all([
		db
			.select()
			.from(GbpListingIssue)
			.where(
				and(
					eq(GbpListingIssue.organizationId, organization.id),
					eq(GbpListingIssue.syncId, ctx.sync.id),
				),
			)
			.orderBy(desc(GbpListingIssue.createdAt)),
		db
			.select()
			.from(GbpSyncEvent)
			.where(
				and(
					eq(GbpSyncEvent.organizationId, organization.id),
					eq(GbpSyncEvent.syncId, ctx.sync.id),
				),
			)
			.orderBy(desc(GbpSyncEvent.createdAt))
			.limit(15),
		listOrderLinkSnapshot(locationId),
		lastPreferredChange(ctx),
		listPhotoRows(locationId),
		getAutoPhotos(locationId),
		db
			.select({
				id: OrganizationMediaAsset.id,
				objectKey: OrganizationMediaAsset.objectKey,
				altText: OrganizationMediaAsset.altText,
				width: OrganizationMediaAsset.width,
				height: OrganizationMediaAsset.height,
			})
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.organizationId, organization.id))
			.orderBy(desc(OrganizationMediaAsset.createdAt))
			.limit(40),
		includeProfile ? loadProfileView(ctx) : Promise.resolve(null),
	])

	const verificationOptions = parseJson<VerificationOption[]>(
		ctx.sync.verificationOptions,
		[],
	)
	const syncedFields = [...parseFieldsSynced(ctx.sync.fieldsSynced)]
	const publishResult = await loadPublishResult(ctx.sync)

	return Response.json(
		{
			enabled: true,
			linked: true,
			flags,
			sync: {
				id: ctx.sync.id,
				googleLocationName: ctx.sync.googleLocationName,
				state: ctx.sync.state,
				syncEnabled: ctx.sync.syncEnabled,
				fieldsSynced: syncedFields,
				verificationState: ctx.sync.verificationState,
				verificationMethod: ctx.sync.verificationMethod,
				verificationDestination: ctx.sync.verificationDestination,
				verificationRequestedAt: ctx.sync.verificationRequestedAt,
				verificationCheckedAt: ctx.sync.verificationCheckedAt,
				verificationOptions,
				lastPushedAt: ctx.sync.lastPushedAt,
				lastPulledAt: ctx.sync.lastPulledAt,
				lastError: ctx.sync.lastError,
				menuSyncEnabled: ctx.sync.menuSyncEnabled,
				menuPublishedAt: ctx.sync.menuPublishedAt,
				menuPublishResult: publishResult,
				metricsBackfilledAt: ctx.sync.metricsBackfilledAt,
				metricsDataUntil: ctx.sync.metricsDataUntil,
			},
			issues: issues.filter((issue) => issue.status === 'open'),
			events,
			orderLinks,
			canUndoPreferred: Boolean(preferredUndo),
			photoRows,
			autoPhotos,
			mediaAssets,
			profile,
		},
		{ headers: NO_STORE },
	)
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		name: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

	const locationId = params.locationId
	if (!locationId) {
		return Response.json(
			{ ok: false, error: 'Location ID is required' },
			{ status: 400, headers: NO_STORE },
		)
	}
	await assertLocationScope(userId, organization.id, locationId)

	const flags = await gbpFlags(organization.id)
	if (!flags.sync) {
		return Response.json(
			{ ok: false, error: 'flags_off' },
			{ status: 403, headers: NO_STORE },
		)
	}

	const formData = await request.formData()
	const intent = String(formData.get('intent') ?? '')

	const ctx = await loadGbpContext(organization.id, locationId)
	if (!ctx) {
		return Response.json(
			{ ok: false, error: 'not_linked' },
			{ status: 404, headers: NO_STORE },
		)
	}

	switch (intent) {
		case 'save-sync-settings': {
			const syncEnabledRaw = formData.get('syncEnabled')
			const syncEnabled =
				syncEnabledRaw === null
					? undefined
					: syncEnabledRaw === 'true' || syncEnabledRaw === 'on'
			const rawFields = formData.getAll('fieldsSynced').map(String)
			const fieldsJson = formData.get('fieldsSyncedJson')
			const parsedFields =
				typeof fieldsJson === 'string' && fieldsJson
					? parseJson<string[]>(fieldsJson, [])
					: rawFields
			const fieldsSynced = parsedFields.filter((f): f is GbpSyncField =>
				(GBP_SYNC_FIELDS as readonly string[]).includes(f),
			)
			await setSyncSettings({
				organizationId: organization.id,
				organizationLocationId: locationId,
				...(syncEnabled === undefined ? {} : { syncEnabled }),
				...(parsedFields.length > 0 || fieldsJson !== null
					? { fieldsSynced }
					: {}),
			})
			return Response.json({ ok: true, intent }, { headers: NO_STORE })
		}

		case 'push-now': {
			const result = await pushLocationToGoogle({
				organizationId: organization.id,
				organizationLocationId: locationId,
				actorId: userId,
				ctx,
			})
			return Response.json({ ok: true, intent, result }, { headers: NO_STORE })
		}

		case 'refresh-all': {
			const [pull, verification, orderLinks] = await Promise.all([
				pullLocation({
					organizationId: organization.id,
					organizationLocationId: locationId,
					ctx,
				}),
				refreshVerification(ctx),
				refreshOrderLinks(ctx),
			])
			return Response.json(
				{ ok: true, intent, pull, verification, orderLinks },
				{ headers: NO_STORE },
			)
		}

		case 'resolve-issue': {
			const issueId = String(formData.get('issueId') ?? '')
			const choice = String(formData.get('choice') ?? '')
			if (
				!issueId ||
				(choice !== 'menuza' && choice !== 'google' && choice !== 'ignore')
			) {
				return Response.json(
					{ ok: false, error: 'invalid_issue_resolution' },
					{ status: 400, headers: NO_STORE },
				)
			}
			const result = await resolveIssue({
				organizationId: organization.id,
				organizationLocationId: locationId,
				issueId,
				choice,
				actorId: userId,
			})
			return Response.json(
				{ ok: result.ok, intent, result },
				{ status: result.ok ? 200 : 400, headers: NO_STORE },
			)
		}

		case 'request-verification': {
			const method = String(formData.get('method') ?? '')
			if (!method) {
				return Response.json(
					{ ok: false, error: 'method_required' },
					{ status: 400, headers: NO_STORE },
				)
			}
			const result = await requestVerification({
				ctx,
				method,
				actorId: userId,
			})
			return Response.json(
				{ ...result, intent },
				{ status: result.ok ? 200 : 400, headers: NO_STORE },
			)
		}

		case 'submit-verification-code': {
			const pin = String(formData.get('pin') ?? '').trim()
			if (!pin) {
				return Response.json(
					{ ok: false, error: 'pin_required' },
					{ status: 400, headers: NO_STORE },
				)
			}
			const result = await submitVerificationCode({
				ctx,
				pin,
				actorId: userId,
			})
			return Response.json(
				{ ...result, intent },
				{ status: result.ok ? 200 : 400, headers: NO_STORE },
			)
		}

		case 'sync-site-links': {
			const result = await syncSiteLinks(ctx, {
				actorId: userId,
				now: new Date(),
			})
			return Response.json({ ok: true, intent, result }, { headers: NO_STORE })
		}

		case 'make-menuza-preferred': {
			const rawKinds = parseJson<string[]>(
				String(formData.get('kindsJson') ?? '["order"]'),
				['order'],
			)
			const kinds = rawKinds.filter(
				(k): k is 'order' | 'reservation' =>
					k === 'order' || k === 'reservation',
			)
			const result = await makeMenuzaPreferred({
				ctx,
				actorId: userId,
				kinds: kinds.length > 0 ? kinds : ['order'],
			})
			return Response.json(
				{ ...result, intent },
				{ status: result.ok ? 200 : 400, headers: NO_STORE },
			)
		}

		case 'undo-preferred': {
			const result = await undoPreferredChange({
				ctx,
				actorId: userId,
			})
			return Response.json(
				{ ...result, intent },
				{ status: result.ok ? 200 : 400, headers: NO_STORE },
			)
		}

		case 'load-profile': {
			const profile = await loadProfileView(ctx)
			return Response.json({ ok: true, intent, profile }, { headers: NO_STORE })
		}

		case 'save-profile': {
			const descriptionRaw = formData.get('description')
			const openingDateRaw = formData.get('openingDate')
			const attributesRaw = formData.get('attributesJson')
			const result = await saveProfile({
				ctx,
				actorId: userId,
				...(descriptionRaw !== null
					? { description: String(descriptionRaw) }
					: {}),
				...(openingDateRaw !== null
					? { openingDate: String(openingDateRaw).trim() }
					: {}),
				...(typeof attributesRaw === 'string' && attributesRaw
					? {
							attributes: parseJson<Record<string, boolean | null>>(
								attributesRaw,
								{},
							),
						}
					: {}),
			})
			return Response.json(
				{ ...result, intent },
				{ status: result.ok ? 200 : 400, headers: NO_STORE },
			)
		}

		case 'sync-derived-attributes': {
			const result = await syncDerivedAttributes(ctx, { actorId: userId })
			return Response.json({ ok: true, intent, result }, { headers: NO_STORE })
		}

		case 'draft-description': {
			const text = await draftDescription(ctx, async ({ system, prompt }) => {
				try {
					const { generateContent } = await import('@repo/ai/server')
					return await generateContent({ prompt: `${system}\n\n${prompt}` })
				} catch {
					// Clean deterministic fallback when AI keys are not configured.
					return `${ctx.organization.name} (${ctx.location.name}) welcomes guests for fresh food and friendly hospitality.`
				}
			})
			return Response.json(
				{ ok: true, intent, description: text },
				{ headers: NO_STORE },
			)
		}

		case 'set-menu-sync': {
			const enabled =
				formData.get('enabled') === 'true' || formData.get('enabled') === 'on'
			const result = await setMenuSync({
				ctx,
				enabled,
				actorId: userId,
			})
			return Response.json({ ok: true, intent, result }, { headers: NO_STORE })
		}

		case 'publish-menu-now': {
			const result = await publishMenu({
				ctx,
				actorId: userId,
				force: true,
			})
			return Response.json({ ok: true, intent, result }, { headers: NO_STORE })
		}

		case 'save-photos': {
			const dishMediaIds = parseJson<string[]>(
				String(formData.get('dishMediaIdsJson') ?? '[]'),
				[],
			)
			const coverMediaId = String(formData.get('coverMediaId') ?? '') || null
			const logoMediaId = String(formData.get('logoMediaId') ?? '') || null
			const result = await savePhotoSelection({
				ctx,
				selection: { dishMediaIds, coverMediaId, logoMediaId },
				actorId: userId,
			})
			return Response.json(
				{ ...result, intent },
				{ status: result.ok ? 200 : 400, headers: NO_STORE },
			)
		}

		case 'sync-photos-now': {
			const [synced, added] = await Promise.all([
				syncPhotos({ ctx, actorId: userId }),
				addNewDishPhotos({ ctx }),
			])
			return Response.json(
				{ ok: true, intent, synced, added },
				{ headers: NO_STORE },
			)
		}

		case 'set-auto-photos': {
			const enabled =
				formData.get('enabled') === 'true' || formData.get('enabled') === 'on'
			await setAutoPhotos(ctx, enabled, userId)
			return Response.json(
				{ ok: true, intent, autoPhotos: enabled },
				{ headers: NO_STORE },
			)
		}

		case 'unlink-google': {
			await db
				.delete(GbpLocationSync)
				.where(
					and(
						eq(GbpLocationSync.organizationId, organization.id),
						eq(GbpLocationSync.id, ctx.sync.id),
					),
				)
			if (ctx.integration) {
				const cfg = parseJson<Record<string, unknown>>(
					ctx.integration.config,
					{},
				)
				delete cfg.googleLocationName
				delete cfg.menuzaLocationId
				await db
					.update(Integration)
					.set({
						organizationLocationId: null,
						config: JSON.stringify(cfg),
					})
					.where(eq(Integration.id, ctx.integration.id))
			}
			await db
				.insert(GbpSyncEvent)
				.values({
					syncId: null,
					organizationId: organization.id,
					organizationLocationId: locationId,
					kind: 'unlink',
					actorId: userId,
					summary: 'Unlinked Google Business Profile from location',
					result: 'accepted',
				})
				.catch(() => {})
			return Response.json({ ok: true, intent }, { headers: NO_STORE })
		}

		default:
			return Response.json(
				{ ok: false, error: 'unknown_intent' },
				{ status: 400, headers: NO_STORE },
			)
	}
}
