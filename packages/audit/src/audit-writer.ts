import crypto from 'node:crypto'
import { AuditLog, db } from '@repo/database'
import { logger } from '@repo/observability'
import { getClientIp } from '@repo/security'
import { AuditAction } from './actions.ts'
import { securityAlertService } from './alerting.ts'
import { computeIntegrityHash } from './integrity.ts'
import { auditRetentionManager } from './retention.ts'
import { ENV } from './package-env.js'

export interface AuditLogInput {
	action: AuditAction
	userId?: string | null
	organizationId?: string | null
	details: string
	metadata?: Record<string, any>
	request?: Request
	severity?: 'info' | 'warning' | 'error' | 'critical'
	targetUserId?: string
	resourceId?: string
	resourceType?: string
}

export class AuditLogWriter {
	private static readonly ALLOWED_UPDATE_FIELDS = ['archived', 'retainUntil']

	async log(input: AuditLogInput): Promise<void> {
		if (ENV.NODE_ENV === 'test') {
			return
		}

		try {
			const ipAddress = this.extractIPAddress(input.request)
			const userAgent = input.request?.headers.get('user-agent') || undefined

			const sanitizedMetadata = this.sanitizeMetadata({
				...input.metadata,
				ipAddress,
				userAgent,
				severity: input.severity || 'info',
				...(input.targetUserId && { targetUserId: input.targetUserId }),
				...(input.resourceId && { resourceId: input.resourceId }),
				...(input.resourceType && { resourceType: input.resourceType }),
			})

			const retainUntil = await auditRetentionManager.calculateRetentionDate(
				input.organizationId || undefined,
			)

			const logId = crypto.randomUUID()
			const createdAt = new Date()
			const sanitizedDetails = this.sanitizeLogMessage(input.details)
			const metadataStr = sanitizedMetadata
				? JSON.stringify(sanitizedMetadata)
				: null

			const integrityHash = computeIntegrityHash({
				id: logId,
				action: input.action,
				userId: input.userId || null,
				organizationId: input.organizationId || null,
				details: sanitizedDetails,
				metadata: metadataStr,
				ipAddress: ipAddress || null,
				userAgent: userAgent || null,
				resourceType: input.resourceType || null,
				resourceId: input.resourceId || null,
				targetUserId: input.targetUserId || null,
				severity: input.severity || 'info',
				createdAt,
			})

			await db.insert(AuditLog).values({
				id: logId,
				action: input.action,
				userId: input.userId || null,
				organizationId: input.organizationId || null,
				details: sanitizedDetails,
				metadata: metadataStr,
				ipAddress,
				userAgent,
				resourceType: input.resourceType || null,
				resourceId: input.resourceId || null,
				targetUserId: input.targetUserId || null,
				severity: input.severity || 'info',
				retainUntil,
				integrityHash,
				createdAt,
			})

			void securityAlertService
				.processEvent({
					action: input.action,
					userId: input.userId || undefined,
					organizationId: input.organizationId || undefined,
					ipAddress,
					details: sanitizedDetails,
					metadata: sanitizedMetadata,
					severity: input.severity,
				})
				.catch((err) =>
					logger.error({ err }, 'Failed to process security alert'),
				)

			this.logToStructuredLogger({
				...input,
				ipAddress,
				userAgent,
				sanitizedMetadata,
			})
		} catch (error) {
			logger.error(
				{ err: error, action: input.action },
				'Failed to create audit log entry',
			)
		}
	}

	async logAuth(
		action: AuditAction,
		userId: string | undefined,
		details: string,
		metadata?: Record<string, any>,
		request?: Request,
		success: boolean = true,
	): Promise<void> {
		await this.log({
			action,
			userId,
			details,
			metadata: {
				...metadata,
				success,
			},
			request,
			severity: success ? 'info' : 'warning',
		})
	}

	async logUserManagement(
		action: AuditAction,
		adminUserId: string,
		targetUserId: string,
		organizationId: string | undefined,
		details: string,
		metadata?: Record<string, any>,
		request?: Request,
	): Promise<void> {
		await this.log({
			action,
			userId: adminUserId,
			targetUserId,
			organizationId,
			details,
			metadata,
			request,
			resourceType: 'user',
			resourceId: targetUserId,
		})
	}

	async logDataOperation(
		action: AuditAction,
		userId: string,
		organizationId: string | undefined,
		resourceType: string,
		resourceId: string,
		details: string,
		metadata?: Record<string, any>,
		request?: Request,
	): Promise<void> {
		await this.log({
			action,
			userId,
			organizationId,
			resourceType,
			resourceId,
			details,
			metadata,
			request,
		})
	}

	async logSecurityEvent(
		action: AuditAction,
		details: string,
		metadata?: Record<string, any>,
		request?: Request,
		severity: 'warning' | 'error' | 'critical' = 'warning',
	): Promise<void> {
		await this.log({
			action,
			details,
			metadata,
			request,
			severity,
		})
	}

	async logAdminOperation(
		action: AuditAction,
		adminUserId: string,
		details: string,
		metadata?: Record<string, any>,
		request?: Request,
	): Promise<void> {
		await this.log({
			action,
			userId: adminUserId,
			details,
			metadata,
			request,
			severity: 'info',
		})
	}

	validateUpdateFields(
		updateData: Record<string, any>,
		context?: { userId?: string; request?: Request },
	): { valid: boolean; violatingFields: string[] } {
		const violatingFields = Object.keys(updateData).filter(
			(field) => !AuditLogWriter.ALLOWED_UPDATE_FIELDS.includes(field),
		)

		if (violatingFields.length > 0) {
			logger.error(
				{
					violatingFields,
					attemptedUpdate: updateData,
					userId: context?.userId,
				},
				'SECURITY ALERT: Attempted modification of immutable audit log fields',
			)

			void this.log({
				action: AuditAction.SECURITY_VIOLATION,
				userId: context?.userId,
				details: `Attempted unauthorized modification of audit log fields: ${violatingFields.join(', ')}`,
				metadata: { violatingFields, attemptedFields: Object.keys(updateData) },
				request: context?.request,
				severity: 'critical',
			})
		}

		return { valid: violatingFields.length === 0, violatingFields }
	}

	private extractIPAddress(request?: Request): string | undefined {
		if (!request) return undefined
		return getClientIp(request, { returnUndefined: true })
	}

	private sanitizeMetadata(
		metadata?: Record<string, any>,
	): Record<string, any> | undefined {
		if (!metadata) return undefined

		const sensitiveKeys = [
			'password',
			'token',
			'secret',
			'key',
			'apiKey',
			'api_key',
			'accessToken',
			'access_token',
			'refreshToken',
			'refresh_token',
			'clientSecret',
			'client_secret',
			'privateKey',
			'private_key',
		]

		const sanitized: Record<string, any> = {}

		for (const [key, value] of Object.entries(metadata)) {
			const keyLower = key.toLowerCase()
			if (sensitiveKeys.some((sensitive) => keyLower.includes(sensitive))) {
				sanitized[key] = '[REDACTED]'
			} else if (typeof value === 'string' && value.length > 2000) {
				sanitized[key] = value.substring(0, 2000) + '...[TRUNCATED]'
			} else if (typeof value === 'object' && value !== null) {
				sanitized[key] = this.sanitizeMetadata(value)
			} else {
				sanitized[key] = value
			}
		}

		return sanitized
	}

	private sanitizeLogMessage(message: string): string {
		if (!message) return message
		// oxlint-disable-next-line no-control-regex – intentional removal of control characters
		return (
			message
				.replace(/[\u0000-\u001f\u007f-\u009f]/g, '') // oxlint-disable-line no-control-regex
				// oxlint-disable-next-line no-control-regex – intentional removal of ANSI escape codes
				.replace(/\x1b\[[0-9;]*m/g, '') // oxlint-disable-line no-control-regex
				.substring(0, 2000)
		)
	}

	private logToStructuredLogger(data: any): void {
		const { action, details, request: _request, ...meta } = data
		logger.info(meta, `[Audit] ${action}: ${details}`)
	}
}

export const auditWriter = new AuditLogWriter()
