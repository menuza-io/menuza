import { AuditAction, auditService } from '@repo/audit'
import { requireUserWithRole } from '@repo/auth'
import {
	and,
	asc,
	db,
	eq,
	isNull,
	or,
	Organization,
	PhoneAgentNumber,
	PlatformPhoneNumber,
	sql,
} from '@repo/database'
import {
	data,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'

/**
 * How long a released number stays reserved for the organization that had
 * it. Organizations forward their public line to the agent number at their
 * carrier, and nothing tells us when they undo that.
 */
export const NUMBER_QUARANTINE_MS = 30 * 24 * 60 * 60 * 1000

// Mirrors E164Schema in @repo/phone-agent, which Admin doesn't depend on.
const E164 = z
	.string()
	.trim()
	.regex(
		/^\+[1-9]\d{7,14}$/,
		'Use international format, for example +15551234567',
	)

const NumberId = z.string().trim().min(1).max(64)

const ActionSchema = z.discriminatedUnion('_action', [
	z.object({
		_action: z.literal('add'),
		e164: E164,
		label: z.string().trim().max(80).optional(),
	}),
	z.object({
		_action: z.literal('assign'),
		id: NumberId,
		organization: z
			.string()
			.trim()
			.min(1, 'Enter an organization slug or ID')
			.max(120),
		confirmReassign: z
			.string()
			.optional()
			.transform((value) => value === 'on' || value === 'true'),
	}),
	z.object({ _action: z.literal('unassign'), id: NumberId }),
	z.object({ _action: z.literal('retire'), id: NumberId }),
])

export type ReassignmentHold = {
	/** Null when the previous organization was deleted while it held the number. */
	releasedAt: Date | null
	previousOrganizationId: string | null
	hadVerifiedForwarding: boolean
	/** Null when the release time is unknown, so the hold never lapses on its own. */
	until: Date | null
}

type HoldInput = {
	assignedOrganizationId: string | null
	assignedAt: Date | null
	releasedAt: Date | null
	releasedFromOrganizationId: string | null
	releasedWithVerifiedForwarding: boolean
}

/**
 * Whether handing this unassigned number to `organizationId` could send the
 * previous organization's forwarded callers to the wrong agent. Returning it to
 * the organization that released it is always safe.
 */
export function getReassignmentHold(
	number: HoldInput,
	organizationId: string | null,
	now: Date,
): ReassignmentHold | null {
	if (number.assignedOrganizationId) return null
	// Deleting an organization nulls the assignment through the foreign key
	// without going through unassign, which leaves `assignedAt` behind.
	if (!number.releasedAt && number.assignedAt) {
		return {
			releasedAt: null,
			previousOrganizationId: null,
			hadVerifiedForwarding: false,
			until: null,
		}
	}
	if (!number.releasedAt) return null
	const until = new Date(number.releasedAt.getTime() + NUMBER_QUARANTINE_MS)
	if (now >= until) return null
	if (
		organizationId !== null &&
		number.releasedFromOrganizationId === organizationId
	) {
		return null
	}
	return {
		releasedAt: number.releasedAt,
		previousOrganizationId: number.releasedFromOrganizationId,
		hadVerifiedForwarding: number.releasedWithVerifiedForwarding,
		until,
	}
}

export type QuarantineWarning = {
	releasedAt: string | null
	until: string | null
	hadVerifiedForwarding: boolean
	previousOrganization: { name: string; slug: string } | null
}

export type ActionResult =
	| { ok: true }
	| {
			ok: false
			error: string
			fieldErrors?: Record<string, string>
			quarantine?: QuarantineWarning
	  }

export async function loader({ request }: LoaderFunctionArgs) {
	await requireUserWithRole(request, 'admin')
	const rows = await db
		.select({
			id: PlatformPhoneNumber.id,
			e164: PlatformPhoneNumber.e164,
			label: PlatformPhoneNumber.label,
			provider: PlatformPhoneNumber.provider,
			assignedOrganizationId: PlatformPhoneNumber.assignedOrganizationId,
			assignedAt: PlatformPhoneNumber.assignedAt,
			retiredAt: PlatformPhoneNumber.retiredAt,
			releasedAt: PlatformPhoneNumber.releasedAt,
			releasedFromOrganizationId:
				PlatformPhoneNumber.releasedFromOrganizationId,
			releasedWithVerifiedForwarding:
				PlatformPhoneNumber.releasedWithVerifiedForwarding,
			organization: {
				id: Organization.id,
				name: Organization.name,
				slug: Organization.slug,
			},
			agentNumber: {
				id: PhoneAgentNumber.id,
				mode: PhoneAgentNumber.mode,
				isActive: PhoneAgentNumber.isActive,
			},
		})
		.from(PlatformPhoneNumber)
		.leftJoin(
			Organization,
			eq(Organization.id, PlatformPhoneNumber.assignedOrganizationId),
		)
		.leftJoin(
			PhoneAgentNumber,
			eq(PhoneAgentNumber.platformNumberId, PlatformPhoneNumber.id),
		)
		.orderBy(asc(PlatformPhoneNumber.e164))
	const now = new Date()
	const numbers = rows.map((row) => {
		const hold = row.retiredAt ? null : getReassignmentHold(row, null, now)
		return {
			id: row.id,
			e164: row.e164,
			label: row.label,
			provider: row.provider,
			assignedAt: row.assignedAt,
			retiredAt: row.retiredAt,
			organization: row.organization,
			agentNumber: row.agentNumber,
			hold: hold
				? {
						until: hold.until?.toISOString() ?? null,
						hadVerifiedForwarding: hold.hadVerifiedForwarding,
					}
				: null,
		}
	})
	return data(
		{ numbers },
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

/** Audit entries keep only the last digits so they don't hold phone numbers. */
function lastFour(e164: string) {
	return e164.replace(/\D/gu, '').slice(-4)
}

async function recordInventoryChange(input: {
	action: AuditAction
	adminUserId: string
	request: Request
	number: { id: string; e164: string }
	organizationId: string | null
	details: string
	metadata?: Record<string, unknown>
}) {
	await auditService.log({
		action: input.action,
		userId: input.adminUserId,
		organizationId: input.organizationId,
		details: input.details,
		metadata: {
			platformNumberId: input.number.id,
			numberLast4: lastFour(input.number.e164),
			...input.metadata,
		},
		request: input.request,
		resourceType: 'platform_phone_number',
		resourceId: input.number.id,
	})
}

async function describeHold(hold: ReassignmentHold) {
	const [previous] = hold.previousOrganizationId
		? await db
				.select({ name: Organization.name, slug: Organization.slug })
				.from(Organization)
				.where(eq(Organization.id, hold.previousOrganizationId))
				.limit(1)
		: []
	return {
		releasedAt: hold.releasedAt?.toISOString() ?? null,
		until: hold.until?.toISOString() ?? null,
		hadVerifiedForwarding: hold.hadVerifiedForwarding,
		previousOrganization: previous ?? null,
	} satisfies QuarantineWarning
}

export async function action({
	request,
}: ActionFunctionArgs): Promise<ActionResult> {
	const adminUserId = await requireUserWithRole(request, 'admin')
	const parsed = ActionSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) {
		const fieldErrors: Record<string, string> = {}
		for (const issue of parsed.error.issues) {
			const key = issue.path.join('.')
			if (key && !fieldErrors[key]) fieldErrors[key] = issue.message
		}
		return { ok: false, error: 'Check the highlighted fields.', fieldErrors }
	}
	const input = parsed.data

	if (input._action === 'add') {
		const [inserted] = await db
			.insert(PlatformPhoneNumber)
			.values({
				e164: input.e164,
				label: input.label || null,
				provider: 'twilio',
			})
			.onConflictDoNothing()
			.returning({ id: PlatformPhoneNumber.id })
		if (!inserted) {
			return { ok: false, error: 'That number is already in the inventory.' }
		}
		await recordInventoryChange({
			action: AuditAction.ADMIN_PHONE_NUMBER_ADDED,
			adminUserId,
			request,
			number: { id: inserted.id, e164: input.e164 },
			organizationId: null,
			details: `Platform phone number ending ${lastFour(input.e164)} added to the inventory`,
		})
		return { ok: true }
	}

	const [number] = await db
		.select({
			id: PlatformPhoneNumber.id,
			e164: PlatformPhoneNumber.e164,
			retiredAt: PlatformPhoneNumber.retiredAt,
			assignedOrganizationId: PlatformPhoneNumber.assignedOrganizationId,
			assignedAt: PlatformPhoneNumber.assignedAt,
			releasedAt: PlatformPhoneNumber.releasedAt,
			releasedFromOrganizationId:
				PlatformPhoneNumber.releasedFromOrganizationId,
			releasedWithVerifiedForwarding:
				PlatformPhoneNumber.releasedWithVerifiedForwarding,
		})
		.from(PlatformPhoneNumber)
		.where(eq(PlatformPhoneNumber.id, input.id))
		.limit(1)
	if (!number) return { ok: false, error: 'Number not found.' }

	if (input._action === 'assign') {
		if (number.retiredAt) {
			return { ok: false, error: 'Retired numbers cannot be assigned.' }
		}
		if (number.assignedOrganizationId) {
			return { ok: false, error: 'Unassign the number first.' }
		}
		const [organization] = await db
			.select({ id: Organization.id, dataRegion: Organization.dataRegion })
			.from(Organization)
			.where(
				or(
					eq(Organization.slug, input.organization),
					eq(Organization.id, input.organization),
				),
			)
			.limit(1)
		if (!organization) {
			return {
				ok: false,
				error: 'Organization not found.',
				fieldErrors: { organization: 'No organization with that slug or ID.' },
			}
		}
		// The agent runs on US infrastructure and won't answer for other regions.
		if (organization.dataRegion !== 'us') {
			return {
				ok: false,
				error: 'The phone agent only serves organizations with US data.',
				fieldErrors: {
					organization:
						'This organization stores customer data outside the US.',
				},
			}
		}
		const hold = getReassignmentHold(number, organization.id, new Date())
		if (hold && !input.confirmReassign) {
			return {
				ok: false,
				error:
					'This number was released recently. Confirm to reassign it anyway.',
				quarantine: await describeHold(hold),
			}
		}
		const [assigned] = await db
			.update(PlatformPhoneNumber)
			.set({
				assignedOrganizationId: organization.id,
				assignedAt: new Date(),
				releasedAt: null,
				releasedFromOrganizationId: null,
				releasedWithVerifiedForwarding: false,
			})
			.where(
				and(
					eq(PlatformPhoneNumber.id, number.id),
					isNull(PlatformPhoneNumber.assignedOrganizationId),
					isNull(PlatformPhoneNumber.retiredAt),
					// The hold was judged on this release; a newer one needs a new look.
					number.releasedAt
						? eq(PlatformPhoneNumber.releasedAt, number.releasedAt)
						: isNull(PlatformPhoneNumber.releasedAt),
				),
			)
			.returning({ id: PlatformPhoneNumber.id })
		if (!assigned) {
			return { ok: false, error: 'The number changed. Reload and try again.' }
		}
		if (hold) {
			await recordInventoryChange({
				action: AuditAction.ADMIN_PHONE_NUMBER_FORCE_REASSIGNED,
				adminUserId,
				request,
				number,
				organizationId: organization.id,
				details: `Platform phone number ending ${lastFour(number.e164)} reassigned to another organization during its release hold`,
				metadata: {
					previousOrganizationId: hold.previousOrganizationId,
					releasedAt: hold.releasedAt?.toISOString() ?? null,
					holdUntil: hold.until?.toISOString() ?? null,
					hadVerifiedForwarding: hold.hadVerifiedForwarding,
				},
			})
		} else {
			await recordInventoryChange({
				action: AuditAction.ADMIN_PHONE_NUMBER_ASSIGNED,
				adminUserId,
				request,
				number,
				organizationId: organization.id,
				details: `Platform phone number ending ${lastFour(number.e164)} assigned to an organization`,
			})
		}
		return { ok: true }
	}

	// Unassigning or retiring takes the number away from the organization, so its
	// agent connection goes too and the number stops answering immediately.
	const now = new Date()
	// An orphaned number (see getReassignmentHold) is released now, which is
	// later than it really was and so only lengthens the hold.
	const releasing = Boolean(number.assignedOrganizationId || number.assignedAt)
	// The update runs first so it can still see the connection it records.
	const [ignoredReleased, removedConnections] = await db.batch([
		db
			.update(PlatformPhoneNumber)
			.set({
				assignedOrganizationId: null,
				assignedAt: null,
				...(releasing
					? {
							releasedAt: now,
							releasedFromOrganizationId: number.assignedOrganizationId,
							releasedWithVerifiedForwarding: sql`exists (select 1 from ${PhoneAgentNumber} where ${PhoneAgentNumber.platformNumberId} = ${number.id} and ${PhoneAgentNumber.mode} = 'forwarding' and ${PhoneAgentNumber.verifiedAt} is not null)`,
						}
					: {}),
				...(input._action === 'retire' ? { retiredAt: now } : {}),
			})
			.where(eq(PlatformPhoneNumber.id, number.id)),
		db
			.delete(PhoneAgentNumber)
			.where(eq(PhoneAgentNumber.platformNumberId, number.id))
			.returning({
				id: PhoneAgentNumber.id,
				mode: PhoneAgentNumber.mode,
				verifiedAt: PhoneAgentNumber.verifiedAt,
			}),
	])
	const hadVerifiedForwarding = removedConnections.some(
		(row) => row.mode === 'forwarding' && row.verifiedAt !== null,
	)
	const retiring = input._action === 'retire'
	await recordInventoryChange({
		action: retiring
			? AuditAction.ADMIN_PHONE_NUMBER_RETIRED
			: AuditAction.ADMIN_PHONE_NUMBER_UNASSIGNED,
		adminUserId,
		request,
		number,
		organizationId: number.assignedOrganizationId,
		details: `Platform phone number ending ${lastFour(number.e164)} ${retiring ? 'retired' : 'unassigned'}`,
		metadata: {
			previousOrganizationId: number.assignedOrganizationId,
			disconnectedAgentNumberIds: removedConnections.map((row) => row.id),
			hadVerifiedForwarding,
		},
	})
	return { ok: true }
}
