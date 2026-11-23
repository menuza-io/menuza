import { AuditAction } from '@repo/audit'
import { Feedback, Organization, db, desc, eq } from '@repo/database'
import {
	searchLogsByTraceId,
	type LogSearchConfig,
	type LogSearchResult,
} from '@repo/observability'
import { auditSupportAction } from './support.server.ts'

export type RequestLookupResult = {
	logs: LogSearchResult
	/** Support requests that carry this reference (#233). */
	requests: Array<{
		id: string
		subject: string | null
		organization: { id: string; name: string }
	}>
}

/**
 * Finds one request by the reference id an owner reads from the error page
 * (#385): the server log lines through the log provider's client, and any
 * support request that came with the same id. Each lookup is audited with the
 * support member's name.
 */
export async function lookupRequest(input: {
	agentId: string
	traceId: string
	config: Partial<LogSearchConfig>
	request?: Request
	fetchImpl?: typeof fetch
}): Promise<RequestLookupResult> {
	const logs = await searchLogsByTraceId(input.traceId, input.config, {
		fetchImpl: input.fetchImpl,
	})
	const requests =
		logs.status === 'invalid_id'
			? []
			: await db
					.select({
						id: Feedback.id,
						subject: Feedback.subject,
						organizationId: Organization.id,
						organizationName: Organization.name,
					})
					.from(Feedback)
					.innerJoin(Organization, eq(Organization.id, Feedback.organizationId))
					.where(eq(Feedback.errorId, input.traceId.trim().toLowerCase()))
					.orderBy(desc(Feedback.createdAt))
					.limit(20)
					.then((rows) =>
						rows.map((row) => ({
							id: row.id,
							subject: row.subject,
							organization: {
								id: row.organizationId,
								name: row.organizationName,
							},
						})),
					)
	await auditSupportAction({
		action: AuditAction.ADMIN_REQUEST_LOOKUP,
		agentId: input.agentId,
		details: 'Looked up a request by its reference id',
		// The id is random and holds nothing personal, so it can be recorded.
		metadata: {
			traceId:
				logs.status === 'invalid_id'
					? null
					: input.traceId.trim().toLowerCase(),
			result: logs.status,
		},
		request: input.request,
	})
	return { logs, requests }
}
