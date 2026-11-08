import {
	and,
	AuditLog,
	count,
	db,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	like,
	lte,
	or,
	User,
} from '@repo/database'
import { type AuditAction } from './actions.ts'

export interface AuditQueryFilter {
	organizationId?: string
	userId?: string
	targetUserId?: string
	action?: AuditAction | AuditAction[]
	severity?: 'info' | 'warning' | 'error' | 'critical'
	resourceType?: string
	resourceId?: string
	startDate?: Date
	endDate?: Date
	search?: string
	includeArchived?: boolean
	limit?: number
	offset?: number
	sortBy?: 'createdAt' | 'action' | 'severity'
	sortOrder?: 'asc' | 'desc'
}

export class AuditLogQuery {
	async query(filter: AuditQueryFilter) {
		const conditions = [
			filter.organizationId !== undefined
				? eq(AuditLog.organizationId, filter.organizationId)
				: undefined,
			filter.userId ? eq(AuditLog.userId, filter.userId) : undefined,
			filter.targetUserId
				? eq(AuditLog.targetUserId, filter.targetUserId)
				: undefined,
			filter.action
				? Array.isArray(filter.action)
					? inArray(AuditLog.action, filter.action)
					: eq(AuditLog.action, filter.action)
				: undefined,
			filter.severity ? eq(AuditLog.severity, filter.severity) : undefined,
			filter.resourceType
				? eq(AuditLog.resourceType, filter.resourceType)
				: undefined,
			filter.resourceId
				? eq(AuditLog.resourceId, filter.resourceId)
				: undefined,
			filter.startDate ? gte(AuditLog.createdAt, filter.startDate) : undefined,
			filter.endDate ? lte(AuditLog.createdAt, filter.endDate) : undefined,
			filter.search
				? or(
						like(AuditLog.details, `%${filter.search}%`),
						like(AuditLog.action, `%${filter.search}%`),
					)
				: undefined,
			!filter.includeArchived ? eq(AuditLog.archived, false) : undefined,
		].filter(Boolean)

		const take = Math.min(filter.limit || 50, 500)
		const skip = filter.offset || 0
		const sortColumn = {
			createdAt: AuditLog.createdAt,
			action: AuditLog.action,
			severity: AuditLog.severity,
		}[filter.sortBy || 'createdAt']
		const orderBy = filter.sortOrder === 'asc' ? sortColumn : desc(sortColumn)

		const [logs, totalCount] = await Promise.all([
			db
				.select({
					id: AuditLog.id,
					organizationId: AuditLog.organizationId,
					userId: AuditLog.userId,
					action: AuditLog.action,
					details: AuditLog.details,
					metadata: AuditLog.metadata,
					createdAt: AuditLog.createdAt,
					ipAddress: AuditLog.ipAddress,
					userAgent: AuditLog.userAgent,
					resourceType: AuditLog.resourceType,
					resourceId: AuditLog.resourceId,
					targetUserId: AuditLog.targetUserId,
					severity: AuditLog.severity,
					retainUntil: AuditLog.retainUntil,
					archived: AuditLog.archived,
					integrityHash: AuditLog.integrityHash,
					user: {
						id: User.id,
						name: User.name,
						email: User.email,
						username: User.username,
					},
				})
				.from(AuditLog)
				.leftJoin(User, eq(AuditLog.userId, User.id))
				.where(and(...conditions))
				.orderBy(orderBy)
				.limit(take)
				.offset(skip),
			db
				.select({ value: count() })
				.from(AuditLog)
				.where(and(...conditions))
				.then(([row]) => row?.value ?? 0),
		])

		return {
			logs: logs.map((log: any) => ({
				...log,
				metadata: log.metadata ? (JSON.parse(log.metadata) as any) : null,
			})),
			totalCount,
			hasMore: skip + logs.length < totalCount,
		}
	}

	async exportCSV(filter: AuditQueryFilter): Promise<string> {
		const { logs } = await this.query({ ...filter, limit: 10000 })

		const headers = [
			'Timestamp',
			'ID',
			'Action',
			'Severity',
			'User ID',
			'User Name',
			'User Email',
			'Target User ID',
			'Organization ID',
			'Resource Type',
			'Resource ID',
			'Details',
			'IP Address',
			'User Agent',
		]

		const rows = logs.map((log: any) =>
			[
				log.createdAt.toISOString(),
				log.id,
				log.action,
				log.severity,
				log.userId || '',
				log.user?.name || '',
				log.user?.email || '',
				log.targetUserId || '',
				log.organizationId || '',
				log.resourceType || '',
				log.resourceId || '',
				log.details ?? '',
				log.ipAddress || '',
				log.userAgent || '',
			].map((value) => this.escapeCsvValue(String(value ?? ''))),
		)

		return [headers.join(','), ...rows.map((r: any) => r.join(','))].join('\n')
	}

	async exportJSON(filter: AuditQueryFilter): Promise<string> {
		const { logs } = await this.query({ ...filter, limit: 10000 })
		return JSON.stringify(logs, null, 2)
	}

	async getStatistics(organizationId?: string, days: number = 30) {
		const startDate = new Date()
		startDate.setDate(startDate.getDate() - days)

		const conditions = [
			gte(AuditLog.createdAt, startDate),
			organizationId !== undefined
				? eq(AuditLog.organizationId, organizationId)
				: undefined,
		].filter(Boolean)
		const severityCount = count()
		const actionCount = count()
		const userCount = count()

		const [
			totalLogs,
			severityCounts,
			actionCounts,
			topUsers,
			unusualActivityCount,
		] = await Promise.all([
			db
				.select({ value: count() })
				.from(AuditLog)
				.where(and(...conditions))
				.then(([row]) => row?.value ?? 0),
			db
				.select({ severity: AuditLog.severity, count: severityCount })
				.from(AuditLog)
				.where(and(...conditions))
				.groupBy(AuditLog.severity),
			db
				.select({ action: AuditLog.action, count: actionCount })
				.from(AuditLog)
				.where(and(...conditions))
				.groupBy(AuditLog.action)
				.orderBy(desc(actionCount))
				.limit(10),
			db
				.select({ userId: AuditLog.userId, count: userCount })
				.from(AuditLog)
				.where(and(...conditions, isNotNull(AuditLog.userId)))
				.groupBy(AuditLog.userId)
				.orderBy(desc(userCount))
				.limit(5),
			db
				.select({ value: count() })
				.from(AuditLog)
				.where(
					and(
						...conditions,
						inArray(AuditLog.severity, ['warning', 'error', 'critical']),
					),
				)
				.then(([row]) => row?.value ?? 0),
		])

		return {
			periodDays: days,
			totalEvents: totalLogs,
			totalLogs,
			severityBreakdown: Object.fromEntries(
				severityCounts.map((s) => [s.severity, s.count]),
			),
			topActions: actionCounts.map((a) => ({
				action: a.action,
				count: a.count,
				_count: a.count,
			})),
			topUserIds: topUsers.map((u) => ({
				userId: u.userId,
				count: u.count,
				_count: u.count,
			})),
			unusualActivityCount,
			recentSecurityEvents: [],
		}
	}

	/**
	 * Quotes every field (names and emails may hold commas or line breaks) and
	 * neutralizes formulas: user agents and names come from untrusted requests.
	 */
	private escapeCsvValue(val: string): string {
		if (!val) return '""'
		return `"${neutralizeCsvFormula(val).replace(/"/g, '""')}"`
	}
}

// Leading whitespace, C0 controls and zero-width marks are skipped by
// spreadsheet apps before they look for a formula trigger.
// oxlint-disable-next-line no-control-regex
const FORMULA_TRIGGERS = /^[\s\u0000-\u001f\u200b-\u200f\ufeff]*[=+\-@\t\r]/

/**
 * Same rule as `neutralizeCsvCell` in `@repo/staffing`: a cell a spreadsheet
 * would read as a formula (after skipping spaces and invisible leaders) gets a
 * leading single quote so it shows as text.
 */
function neutralizeCsvFormula(value: string): string {
	return FORMULA_TRIGGERS.test(value) ? `'${value}` : value
}

export const auditQuery = new AuditLogQuery()
