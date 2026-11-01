import { AuditAction, auditService } from '@repo/audit'
import { and, AuditLog, db, desc, eq, inArray, User } from '@repo/database'

/**
 * A discount's change log, kept in the shared audit log. Only field names and
 * counts go in: never code strings (a code is a secret until published) and
 * never customer data.
 */

export const DISCOUNT_HISTORY_ACTIONS = [
	AuditAction.DISCOUNT_CREATED,
	AuditAction.DISCOUNT_UPDATED,
	AuditAction.DISCOUNT_STATUS_CHANGED,
] as const

export const DISCOUNT_RESOURCE_TYPE = 'discount'

export type DiscountHistoryKind = 'created' | 'updated' | 'status'

const KIND_BY_ACTION: Record<string, DiscountHistoryKind> = {
	[AuditAction.DISCOUNT_CREATED]: 'created',
	[AuditAction.DISCOUNT_UPDATED]: 'updated',
	[AuditAction.DISCOUNT_STATUS_CHANGED]: 'status',
}

/** Top-level keys whose values differ, in the order of `after`. */
export function changedDiscountKeys(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): string[] {
	const keys = new Set([...Object.keys(after), ...Object.keys(before)])
	return [...keys].filter(
		(key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
	)
}

type RecordInput = {
	organizationId: string
	userId: string
	discountId: string
	request?: Request
}

export async function recordDiscountCreated(input: RecordInput) {
	await auditService.log({
		action: AuditAction.DISCOUNT_CREATED,
		userId: input.userId,
		organizationId: input.organizationId,
		details: 'Discount created',
		request: input.request,
		resourceType: DISCOUNT_RESOURCE_TYPE,
		resourceId: input.discountId,
	})
}

export async function recordDiscountUpdated(
	input: RecordInput & { keys: string[]; codesChanged: boolean },
) {
	if (input.keys.length === 0 && !input.codesChanged) return
	await auditService.log({
		action: AuditAction.DISCOUNT_UPDATED,
		userId: input.userId,
		organizationId: input.organizationId,
		details: `Discount changed: ${input.keys.join(', ')}`,
		metadata: { keys: input.keys, codesChanged: input.codesChanged },
		request: input.request,
		resourceType: DISCOUNT_RESOURCE_TYPE,
		resourceId: input.discountId,
	})
}

export async function recordDiscountStatus(
	input: RecordInput & { status: 'active' | 'paused' | 'archived' },
) {
	await auditService.log({
		action: AuditAction.DISCOUNT_STATUS_CHANGED,
		userId: input.userId,
		organizationId: input.organizationId,
		details: `Discount ${input.status}`,
		metadata: { status: input.status },
		request: input.request,
		resourceType: DISCOUNT_RESOURCE_TYPE,
		resourceId: input.discountId,
	})
}

export type DiscountHistoryEntry = {
	id: string
	kind: DiscountHistoryKind
	createdAt: string
	userName: string | null
	keys: string[]
	codesChanged: boolean
	status: 'active' | 'paused' | 'archived' | null
}

function parseMetadata(raw: string | null): Record<string, unknown> {
	if (!raw) return {}
	try {
		const value: unknown = JSON.parse(raw)
		return value && typeof value === 'object'
			? (value as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

export async function listDiscountHistory(
	organizationId: string,
	discountId: string,
	limit = 30,
): Promise<DiscountHistoryEntry[]> {
	const rows = await db
		.select({
			id: AuditLog.id,
			action: AuditLog.action,
			metadata: AuditLog.metadata,
			createdAt: AuditLog.createdAt,
			userName: User.name,
			userEmail: User.email,
		})
		.from(AuditLog)
		.leftJoin(User, eq(User.id, AuditLog.userId))
		.where(
			and(
				eq(AuditLog.organizationId, organizationId),
				eq(AuditLog.resourceType, DISCOUNT_RESOURCE_TYPE),
				eq(AuditLog.resourceId, discountId),
				inArray(AuditLog.action, [...DISCOUNT_HISTORY_ACTIONS]),
			),
		)
		.orderBy(desc(AuditLog.createdAt))
		.limit(Math.min(Math.max(limit, 1), 100))
	return rows.map((row) => {
		const metadata = parseMetadata(row.metadata)
		const status = metadata.status
		return {
			id: row.id,
			kind: KIND_BY_ACTION[row.action] ?? 'updated',
			createdAt: row.createdAt.toISOString(),
			userName: row.userName ?? row.userEmail ?? null,
			keys: Array.isArray(metadata.keys)
				? metadata.keys.filter((key): key is string => typeof key === 'string')
				: [],
			codesChanged: metadata.codesChanged === true,
			status:
				status === 'active' || status === 'paused' || status === 'archived'
					? status
					: null,
		}
	})
}
