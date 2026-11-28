import { AuditAction, auditService } from '@repo/audit'
import {
	RETENTION_OFFER_FLAG,
	cancelRequestInputSchema,
	cleanRetentionOffer,
	type CancelRequestInput,
} from '@repo/common/cancel-request'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	and,
	db,
	desc,
	eq,
	inArray,
	OrganizationLocation,
	SubscriptionChangeRequest,
} from '@repo/database'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import { recordOrganizationEvent } from '#app/utils/organization-events.server.ts'
import {
	getPlansAndPrices,
	getSubscriptionPeriodEnd,
	hasLiveSubscription,
} from '#app/utils/payments.server.ts'
import {
	type CancelRequestContext,
	type OpenChangeRequest,
} from './cancel-request.ts'

/**
 * Cancel or downgrade requests (#379). A request is only a record: it never
 * cancels, charges, refunds or deletes anything, and it takes effect at the end
 * of the billing period the owner saw before confirming. Menuza support reads
 * it in Admin and acts on it by hand.
 */

function parseIds(raw: string | null): string[] {
	if (!raw) return []
	try {
		const value: unknown = JSON.parse(raw)
		return Array.isArray(value)
			? value.filter((id): id is string => typeof id === 'string')
			: []
	} catch {
		return []
	}
}

export async function loadOpenChangeRequest(
	organizationId: string,
): Promise<OpenChangeRequest | null> {
	const [row] = await db
		.select()
		.from(SubscriptionChangeRequest)
		.where(
			and(
				eq(SubscriptionChangeRequest.organizationId, organizationId),
				eq(SubscriptionChangeRequest.status, 'requested'),
			),
		)
		.orderBy(desc(SubscriptionChangeRequest.createdAt))
		.limit(1)
	if (!row) return null
	return {
		id: row.id,
		kind: row.kind,
		reason: row.reason,
		subReason: row.subReason,
		locationIds: parseIds(row.locationIds),
		targetPlan: row.targetPlan,
		effectiveAt: row.effectiveAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
	}
}

export async function retentionOfferFor(
	organizationId: string,
): Promise<string | null> {
	return cleanRetentionOffer(
		await getFeatureFlag(RETENTION_OFFER_FLAG, { organizationId }),
	)
}

type BillingOrganization = {
	id: string
	stripeSubscriptionId: string | null
	subscriptionStatus: string | null
	stripeProductId: string | null
}

async function downgradeTarget(
	organization: Pick<BillingOrganization, 'stripeProductId'>,
): Promise<string | null> {
	try {
		const plans = await getPlansAndPrices()
		const { base, plus } = plans.plans
		// Only the larger plan has a smaller one to move to.
		return plus && base && organization.stripeProductId === plus.id
			? base.name
			: null
	} catch {
		return null
	}
}

/** What the request page needs, read now. The cutoff comes from the provider. */
export async function loadCancelRequestContext(
	organization: BillingOrganization,
): Promise<CancelRequestContext> {
	const [cutoff, retentionOffer, locationRows, locale, downgradeTo, open] =
		await Promise.all([
			organization.stripeSubscriptionId
				? getSubscriptionPeriodEnd(organization.stripeSubscriptionId)
				: Promise.resolve(null),
			retentionOfferFor(organization.id),
			db
				.select({
					id: OrganizationLocation.id,
					name: OrganizationLocation.name,
				})
				.from(OrganizationLocation)
				.where(eq(OrganizationLocation.organizationId, organization.id)),
			orgDefaultLocale(organization.id),
			downgradeTarget(organization),
			loadOpenChangeRequest(organization.id),
		])
	return {
		cutoff: cutoff?.toISOString() ?? null,
		retentionOffer,
		locations: locationRows.map((row) => ({
			id: row.id,
			name: displayLocationName(row.name, locale, locale),
		})),
		downgradeTo,
		open,
	}
}

export type CreateCancelRequestResult =
	| { ok: true; id: string; effectiveAt: string }
	| {
			ok: false
			error:
				| 'invalid'
				| 'no_subscription'
				| 'cutoff_unknown'
				| 'already_requested'
				| 'invalid_locations'
				| 'no_smaller_plan'
	  }

/**
 * Records the request. Refuses when there is no live subscription, when the
 * billing cutoff cannot be read (the owner must have seen it), when a request is
 * already open, or when the locations or plan are not the organization's.
 * Writes one row, one audit entry and one Timeline event; touches nothing else.
 */
export async function createCancelRequest(input: {
	organization: BillingOrganization
	userId: string
	body: unknown
	request?: Request
}): Promise<CreateCancelRequestResult> {
	const parsed = cancelRequestInputSchema.safeParse(input.body)
	if (!parsed.success) return { ok: false, error: 'invalid' }
	const value: CancelRequestInput = parsed.data
	const { organization } = input
	if (
		!hasLiveSubscription({
			stripeSubscriptionId: organization.stripeSubscriptionId,
			subscriptionStatus: organization.subscriptionStatus,
		}) ||
		!organization.stripeSubscriptionId
	) {
		return { ok: false, error: 'no_subscription' }
	}
	const cutoff = await getSubscriptionPeriodEnd(
		organization.stripeSubscriptionId,
	)
	if (!cutoff) return { ok: false, error: 'cutoff_unknown' }
	if (await loadOpenChangeRequest(organization.id)) {
		return { ok: false, error: 'already_requested' }
	}

	let locationIds: string[] = []
	if (value.kind === 'cancel_locations') {
		const owned = await db
			.select({ id: OrganizationLocation.id })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, organization.id),
					inArray(OrganizationLocation.id, value.locationIds),
				),
			)
		locationIds = owned.map((row) => row.id)
		if (locationIds.length !== new Set(value.locationIds).size) {
			return { ok: false, error: 'invalid_locations' }
		}
	}
	let targetPlan: string | null = null
	if (value.kind === 'downgrade') {
		targetPlan = await downgradeTarget(organization)
		if (!targetPlan || targetPlan !== value.targetPlan) {
			return { ok: false, error: 'no_smaller_plan' }
		}
	}

	const retentionOffer = await retentionOfferFor(organization.id)
	const [row] = await db
		.insert(SubscriptionChangeRequest)
		.values({
			organizationId: organization.id,
			requestedById: input.userId,
			kind: value.kind,
			locationIds: locationIds.length ? JSON.stringify(locationIds) : null,
			targetPlan,
			reason: value.reason,
			subReason: value.subReason || null,
			note: value.note || null,
			effectiveAt: cutoff,
			retentionOffer,
			status: 'requested',
		})
		.returning({ id: SubscriptionChangeRequest.id })
	if (!row) return { ok: false, error: 'invalid' }

	await auditService.log({
		action: AuditAction.ORG_SETTINGS_UPDATED,
		userId: input.userId,
		organizationId: organization.id,
		resourceType: 'organization',
		resourceId: organization.id,
		details: 'Subscription change requested',
		// Kind and reason only: never the owner's free-text note.
		metadata: { requestId: row.id, kind: value.kind, reason: value.reason },
		request: input.request,
	})
	await recordOrganizationEvent({
		organizationId: organization.id,
		kind: 'subscription_change_requested',
		payload: { requestKind: value.kind, reason: value.reason },
		dedupeKey: `subscription-change:${row.id}`,
	})
	return { ok: true, id: row.id, effectiveAt: cutoff.toISOString() }
}

/** The owner takes their request back. Nothing had been done, so nothing is undone. */
export async function withdrawCancelRequest(input: {
	organizationId: string
	requestId: string
	userId: string
	request?: Request
}): Promise<boolean> {
	const updated = await db
		.update(SubscriptionChangeRequest)
		.set({ status: 'withdrawn' })
		.where(
			and(
				eq(SubscriptionChangeRequest.id, input.requestId),
				eq(SubscriptionChangeRequest.organizationId, input.organizationId),
				eq(SubscriptionChangeRequest.status, 'requested'),
			),
		)
		.returning({ id: SubscriptionChangeRequest.id })
	if (updated.length === 0) return false
	await auditService.log({
		action: AuditAction.ORG_SETTINGS_UPDATED,
		userId: input.userId,
		organizationId: input.organizationId,
		resourceType: 'organization',
		resourceId: input.organizationId,
		details: 'Subscription change request withdrawn',
		metadata: { requestId: input.requestId },
		request: input.request,
	})
	return true
}
