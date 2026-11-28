import { AuditAction, auditService } from '@repo/audit'
import { requireUserWithRole } from '@repo/auth'
import {
	CANCEL_KIND_LABELS_EN,
	CANCEL_REASON_LABELS_EN,
	CANCEL_SUB_REASON_LABELS_EN,
	type CancelReason,
	type CancelRequestKind,
} from '@repo/common/cancel-request'
import {
	and,
	db,
	desc,
	eq,
	inArray,
	Organization,
	OrganizationLocation,
	SubscriptionChangeRequest,
	User,
} from '@repo/database'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'

/**
 * Admin, Cancel and downgrade requests (#379): every request an owner sent
 * from the App's billing page, with the reason they gave and the date it takes
 * effect. Support acts on it by hand and marks it handled. Reading or marking a
 * request changes nothing about the subscription itself.
 */

const LIMIT = 200

export type ChangeRequestRow = Awaited<
	ReturnType<typeof listChangeRequests>
>[number]

export async function listChangeRequests(input: {
	status?: 'requested' | 'withdrawn' | 'handled' | null
	organizationId?: string
	limit?: number
}) {
	const rows = await db
		.select({
			id: SubscriptionChangeRequest.id,
			organizationId: SubscriptionChangeRequest.organizationId,
			organizationName: Organization.name,
			organizationSlug: Organization.slug,
			requestedByName: User.name,
			requestedByUsername: User.username,
			kind: SubscriptionChangeRequest.kind,
			locationIds: SubscriptionChangeRequest.locationIds,
			targetPlan: SubscriptionChangeRequest.targetPlan,
			reason: SubscriptionChangeRequest.reason,
			subReason: SubscriptionChangeRequest.subReason,
			note: SubscriptionChangeRequest.note,
			effectiveAt: SubscriptionChangeRequest.effectiveAt,
			retentionOffer: SubscriptionChangeRequest.retentionOffer,
			status: SubscriptionChangeRequest.status,
			handledAt: SubscriptionChangeRequest.handledAt,
			createdAt: SubscriptionChangeRequest.createdAt,
		})
		.from(SubscriptionChangeRequest)
		.innerJoin(
			Organization,
			eq(Organization.id, SubscriptionChangeRequest.organizationId),
		)
		.leftJoin(User, eq(User.id, SubscriptionChangeRequest.requestedById))
		.where(
			and(
				input.status
					? eq(SubscriptionChangeRequest.status, input.status)
					: undefined,
				input.organizationId
					? eq(SubscriptionChangeRequest.organizationId, input.organizationId)
					: undefined,
			),
		)
		.orderBy(desc(SubscriptionChangeRequest.createdAt))
		.limit(Math.min(input.limit ?? LIMIT, LIMIT))

	const locationIds = [
		...new Set(
			rows.flatMap((row) => {
				try {
					const ids: unknown = row.locationIds
						? JSON.parse(row.locationIds)
						: []
					return Array.isArray(ids)
						? ids.filter((id): id is string => typeof id === 'string')
						: []
				} catch {
					return []
				}
			}),
		),
	]
	const names = new Map<string, string>()
	if (locationIds.length > 0) {
		const found = await db
			.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
			.from(OrganizationLocation)
			.where(inArray(OrganizationLocation.id, locationIds))
		for (const row of found) names.set(row.id, row.name)
	}

	return rows.map((row) => {
		let ids: string[] = []
		try {
			const parsed: unknown = row.locationIds ? JSON.parse(row.locationIds) : []
			if (Array.isArray(parsed)) {
				ids = parsed.filter((id): id is string => typeof id === 'string')
			}
		} catch {
			ids = []
		}
		return {
			id: row.id,
			organization: {
				id: row.organizationId,
				name: row.organizationName,
				slug: row.organizationSlug,
			},
			requestedBy: row.requestedByName || row.requestedByUsername || null,
			kind: row.kind,
			kindLabel:
				CANCEL_KIND_LABELS_EN[row.kind as CancelRequestKind] ?? row.kind,
			locations: ids.map((id) => names.get(id) ?? id),
			targetPlan: row.targetPlan,
			reason: row.reason,
			reasonLabel:
				CANCEL_REASON_LABELS_EN[row.reason as CancelReason] ?? row.reason,
			subReasonLabel: row.subReason
				? (CANCEL_SUB_REASON_LABELS_EN[row.subReason] ?? row.subReason)
				: null,
			note: row.note,
			effectiveAt: row.effectiveAt?.toISOString() ?? null,
			retentionOffer: row.retentionOffer,
			status: row.status,
			handledAt: row.handledAt?.toISOString() ?? null,
			createdAt: row.createdAt.toISOString(),
		}
	})
}

const HandledSchema = z.object({
	_action: z.literal('mark-handled'),
	requestId: z.string().min(1).max(64),
})

/** Marks a request handled (support acted on it). Only an open request changes. */
export async function markChangeRequestHandled(input: {
	adminUserId: string
	requestId: string
	request?: Request
}) {
	const [updated] = await db
		.update(SubscriptionChangeRequest)
		.set({
			status: 'handled',
			handledById: input.adminUserId,
			handledAt: new Date(),
		})
		.where(
			and(
				eq(SubscriptionChangeRequest.id, input.requestId),
				eq(SubscriptionChangeRequest.status, 'requested'),
			),
		)
		.returning({
			id: SubscriptionChangeRequest.id,
			organizationId: SubscriptionChangeRequest.organizationId,
		})
	if (!updated) return { ok: false as const }
	try {
		await auditService.log({
			action: AuditAction.ORG_SETTINGS_UPDATED,
			userId: input.adminUserId,
			organizationId: updated.organizationId,
			details: 'Subscription change request marked handled',
			resourceType: 'organization',
			resourceId: updated.organizationId,
			metadata: { requestId: updated.id },
			request: input.request,
		})
	} catch {
		// A log line never undoes the change.
	}
	return { ok: true as const }
}

export async function loader({ request }: LoaderFunctionArgs) {
	await requireUserWithRole(request, 'admin')
	const raw = new URL(request.url).searchParams.get('status')
	const status =
		raw === 'all'
			? null
			: raw === 'handled' || raw === 'withdrawn'
				? raw
				: ('requested' as const)
	return {
		requests: await listChangeRequests({ status }),
		status: raw === 'all' ? 'all' : (status ?? 'requested'),
	}
}

export async function action({ request }: ActionFunctionArgs) {
	const adminUserId = await requireUserWithRole(request, 'admin')
	const parsed = HandledSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) {
		return Response.json({ status: 'error', error: 'invalid' }, { status: 400 })
	}
	const result = await markChangeRequestHandled({
		adminUserId,
		requestId: parsed.data.requestId,
		request,
	})
	if (!result.ok) {
		return Response.json(
			{ status: 'error', error: 'not_open' },
			{ status: 409 },
		)
	}
	return Response.json({ status: 'success' })
}
