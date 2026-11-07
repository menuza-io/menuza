import { AuditAction } from './actions.ts'
import { auditService } from './index.ts'

export interface AuditMiddlewareOptions {
	getUserId: (request: Request) => Promise<string | null>
	sensitiveRoutes?: Array<{
		pattern: RegExp
		details: string
	}>
}

const DEFAULT_SENSITIVE_ROUTES = [
	{
		pattern: /^\/[^/]+\/settings\/billing(\/|$)/,
		details: 'Accessed billing settings',
	},
	{
		pattern: /^\/[^/]+\/settings\/api-keys(\/|$)/,
		details: 'Accessed API keys settings',
	},
	{
		pattern: /^\/admin/,
		details: 'Accessed admin area',
	},
	{
		pattern: /^\/[^/]+\/settings(\/|$)/,
		details: 'Accessed organization settings',
	},
]

export function createAuditMiddleware(options: AuditMiddlewareOptions) {
	const { getUserId, sensitiveRoutes = DEFAULT_SENSITIVE_ROUTES } = options

	return async function auditSensitiveRoutes(
		request: Request,
		response?: Response,
	) {
		try {
			const url = new URL(request.url)
			const pathname = url.pathname

			const match = sensitiveRoutes.find((r) => r.pattern.test(pathname))
			if (!match) return

			// Get user (only log authenticated access)
			const userId = await getUserId(request)
			if (!userId) return

			// Await the write so a caller that hands this call to `waitUntil`
			// keeps it alive; failures are logged, never thrown.
			await auditService
				.log({
					action: AuditAction.SENSITIVE_ROUTE_ACCESSED,
					userId,
					details: match.details,
					request,
					metadata: {
						path: pathname,
						method: request.method,
						statusCode: response?.status,
						userAgent: request.headers.get('user-agent'),
					},
					severity: 'info',
				})
				.catch((error) => {
					console.error('Failed to log sensitive route access:', error)
				})
		} catch (error) {
			// Fail safe - don't crash the request if audit fails
			console.error('Error in audit middleware:', error)
		}
	}
}

export async function auditSensitiveRoutes(
	request: Request,
	response: Response | undefined,
	getUserId: (request: Request) => Promise<string | null>,
) {
	const middleware = createAuditMiddleware({ getUserId })
	return middleware(request, response)
}
