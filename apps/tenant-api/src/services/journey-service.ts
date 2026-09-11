import { randomUUID } from 'node:crypto'
import { eq, and, desc, count } from 'drizzle-orm'
import { ENV } from 'varlock/env'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { z } from 'zod'
import {
	getTenantDb,
	customers,
	marketingJourneys,
	journeyRuns,
	journeyStepExecutions,
	marketingMessages,
	validateWorkflowDAG,
	actionEmailNodeDataSchema,
	interpolateMergeTags,
	interpolateMergeTagsHtml,
	createJourneySchema,
	updateJourneySchema,
	type ExecuteStepPayload,
	type CompleteRunPayload,
	type EvaluateConditionPayload,
} from '@repo/tenant-db'
import { sendSms } from '@repo/sms'
import { getNodeRegion } from '../lib/region.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'

export const JOURNEY_PROCESSING_LEASE_MS = 5 * 60 * 1000
export const JOURNEY_LIST_LIMIT = 100

function isSqliteUniqueConstraintError(error: unknown) {
	return (
		error instanceof Error &&
		(error.message.includes('UNIQUE constraint failed') ||
			error.message.includes('SQLITE_CONSTRAINT_UNIQUE'))
	)
}

function executionWasDispatched(execution: {
	executionDetails?: string | null | unknown
}) {
	if (execution.executionDetails == null) return false
	try {
		const details =
			typeof execution.executionDetails === 'string'
				? JSON.parse(execution.executionDetails)
				: execution.executionDetails
		if (!details || typeof details !== 'object') return false
		return (
			details.dispatched === true ||
			(typeof details.messageId === 'string' && details.messageId.length > 0) ||
			(typeof details.sid === 'string' && details.sid.length > 0)
		)
	} catch {
		return false
	}
}

function deliveredResultFromDispatchedExecution(execution: {
	id: string
	executionDetails?: string | null | unknown
}): StepExecutionResult {
	let messageId: string | undefined
	try {
		const details =
			typeof execution.executionDetails === 'string'
				? JSON.parse(execution.executionDetails)
				: execution.executionDetails
		if (details && typeof details === 'object') {
			if ('messageId' in details && typeof details.messageId === 'string') {
				messageId = details.messageId
			} else if ('sid' in details && typeof details.sid === 'string') {
				messageId = details.sid
			}
		}
	} catch {}

	return {
		success: true,
		executionId: execution.id,
		status: 'delivered',
		messageId,
	}
}

export type CreateJourneyInput = z.input<typeof createJourneySchema>
export type UpdateJourneyInput = z.input<typeof updateJourneySchema>

function getEnvVar(key: string, defaultValue = ''): string {
	syncEnvFromProcess()
	try {
		if (ENV && (ENV as any)[key]) return (ENV as any)[key]
	} catch {}
	return defaultValue
}

export { interpolateMergeTags }

export interface StepExecutionResult {
	success: boolean
	executionId?: string
	status: 'delivered' | 'failed' | 'skipped' | 'processing'
	messageId?: string
	error?: string
	statusCode?: number
}

/**
 * Executes a journey action step (Email or SMS) within the regional boundary.
 * Resolves customer PII in the local SQLite tenant DB, interpolates merge tags,
 * dispatches the message via OCI Email Delivery (@repo/email) or @repo/sms,
 * and returns a strictly ZERO-PII response.
 */
export async function executeJourneyStep(
	orgId: string,
	payload: ExecuteStepPayload,
): Promise<StepExecutionResult> {
	const db = await getTenantDb(orgId)

	// 1. Resolve customer PII locally
	const customer = await db
		.select()
		.from(customers)
		.where(eq(customers.id, payload.customerId))
		.get()

	if (!customer) {
		const errorMessage = `Customer "${payload.customerId}" not found in tenant database`
		return {
			success: false,
			status: 'failed',
			error: errorMessage,
			statusCode: 404,
		}
	}

	// 2. Resolve journey run
	const run = await db
		.select()
		.from(journeyRuns)
		.where(eq(journeyRuns.id, payload.runId))
		.get()

	if (!run) {
		const errorMessage = `Journey run "${payload.runId}" not found in tenant database`
		return {
			success: false,
			status: 'failed',
			error: errorMessage,
			statusCode: 404,
		}
	}

	const rawType = payload.nodeType
	const stepType =
		rawType === 'action_email' || rawType === 'email' ? 'email' : 'sms'

	const txResult = await retryOnSqliteBusy(() =>
		db.transaction(async (tx) => {
			// Idempotency: if this (runId, nodeId) action already delivered, return the
			// prior result instead of re-dispatching on a workflow retry.
			const existing = await tx
				.select()
				.from(journeyStepExecutions)
				.where(
					and(
						eq(journeyStepExecutions.runId, payload.runId),
						eq(journeyStepExecutions.nodeId, payload.nodeId),
					),
				)
				.all()

			const deliveredExecution = existing.find(
				(e) => e.status === 'delivered' || e.status === 'completed',
			)
			if (deliveredExecution) {
				let messageId: string | undefined
				try {
					const details =
						typeof deliveredExecution.executionDetails === 'string'
							? JSON.parse(deliveredExecution.executionDetails)
							: deliveredExecution.executionDetails
					if (
						details &&
						typeof details === 'object' &&
						'messageId' in details
					) {
						messageId = details.messageId as string
					}
				} catch {}
				return {
					success: true,
					executionId: deliveredExecution.id,
					status: 'delivered' as const,
					messageId,
				}
			}

			const processingExecution = existing.find(
				(e) =>
					e.status === 'processing' &&
					e.executedAt &&
					Date.now() - new Date(e.executedAt).getTime() <
						JOURNEY_PROCESSING_LEASE_MS,
			)
			if (processingExecution) {
				return {
					success: true,
					executionId: processingExecution.id,
					status: 'processing' as const,
				}
			}

			const dispatchedExecution = existing.find((e) =>
				executionWasDispatched(e),
			)
			if (dispatchedExecution) {
				return deliveredResultFromDispatchedExecution(dispatchedExecution)
			}

			const reclaimableExecution = existing.find(
				(e) =>
					!executionWasDispatched(e) &&
					(e.status === 'failed' ||
						(e.status === 'processing' &&
							e.executedAt &&
							Date.now() - new Date(e.executedAt).getTime() >=
								JOURNEY_PROCESSING_LEASE_MS)),
			)
			if (reclaimableExecution) {
				await tx
					.update(journeyStepExecutions)
					.set({
						status: 'processing',
						executedAt: new Date(),
						retryCount: (reclaimableExecution.retryCount ?? 0) + 1,
						errorMessage: null,
						completedAt: null,
					})
					.where(eq(journeyStepExecutions.id, reclaimableExecution.id))

				return {
					_continue: true,
					stepExecutionId: reclaimableExecution.id,
				}
			}

			const stepExecutionId = randomUUID()

			// 3. Record initial step execution in audit log
			try {
				await tx.insert(journeyStepExecutions).values({
					id: stepExecutionId,
					runId: payload.runId,
					journeyId: payload.journeyId,
					customerId: payload.customerId,
					nodeId: payload.nodeId,
					nodeType: rawType,
					stepType,
					status: 'processing',
					retryCount: 0,
					executedAt: new Date(),
				})
			} catch (error) {
				if (!isSqliteUniqueConstraintError(error)) {
					throw error
				}

				const raced = await tx
					.select()
					.from(journeyStepExecutions)
					.where(
						and(
							eq(journeyStepExecutions.runId, payload.runId),
							eq(journeyStepExecutions.nodeId, payload.nodeId),
						),
					)
					.get()

				if (!raced) throw error

				if (raced.status === 'delivered' || raced.status === 'completed') {
					return {
						success: true,
						executionId: raced.id,
						status: 'delivered' as const,
					}
				}

				if (executionWasDispatched(raced)) {
					return deliveredResultFromDispatchedExecution(raced)
				}

				if (
					raced.status === 'processing' &&
					raced.executedAt &&
					Date.now() - new Date(raced.executedAt).getTime() <
						JOURNEY_PROCESSING_LEASE_MS
				) {
					return {
						success: true,
						executionId: raced.id,
						status: 'processing' as const,
					}
				}

				throw error
			}

			return {
				_continue: true,
				stepExecutionId,
			}
		}),
	)

	if (!('_continue' in txResult)) {
		return txResult
	}

	const stepExecutionId = txResult.stepExecutionId
	if (!stepExecutionId) {
		return {
			success: false,
			status: 'failed',
			error: 'Failed to acquire journey step execution lease',
			statusCode: 500,
		}
	}

	let contextData: Record<string, unknown> = {}
	if (run.contextData) {
		try {
			contextData =
				typeof run.contextData === 'string'
					? JSON.parse(run.contextData)
					: (run.contextData as Record<string, unknown>)
		} catch {
			contextData = {}
		}
	}

	const config = payload.config || {}

	// 4. Execute channel-specific dispatch
	if (stepType === 'email') {
		if (!customer.email || customer.email.trim().length === 0) {
			const errorMessage = 'Customer has no email address'
			await db
				.update(journeyStepExecutions)
				.set({
					status: 'failed',
					errorMessage,
					completedAt: new Date(),
				})
				.where(eq(journeyStepExecutions.id, stepExecutionId))

			return {
				success: false,
				executionId: stepExecutionId,
				status: 'failed',
				error: errorMessage,
				statusCode: 422,
			}
		}
		const legacyConfig = config as { content?: unknown }
		const parsedConfig = actionEmailNodeDataSchema.safeParse({
			subject: 'Notification',
			...config,
			bodyHtml:
				typeof legacyConfig.content === 'string'
					? legacyConfig.content
					: (config as { bodyHtml?: unknown }).bodyHtml,
		})
		if (!parsedConfig.success) {
			return {
				success: false,
				status: 'failed',
				error: 'Invalid email journey configuration',
				statusCode: 422,
			}
		}
		const emailConfig = parsedConfig.data

		const isDesigned =
			emailConfig.emailFormat === 'designed' ||
			Array.isArray(emailConfig.blocks)
		const rawSubject = emailConfig.subject || 'Notification'
		const rawHtml = emailConfig.bodyHtml || ''
		const rawText = emailConfig.bodyText || rawHtml

		const subject = interpolateMergeTags(rawSubject, customer, contextData)
		const text = interpolateMergeTags(rawText, customer, contextData)
		const renderedHtml = isDesigned
			? interpolateMergeTagsHtml(rawHtml, customer, contextData)
			: interpolateMergeTags(rawHtml, customer, contextData)
		// Designed emails already hold a full HTML document; legacy nodes get the
		// historical <p> wrapper.
		const html = isDesigned
			? renderedHtml
			: renderedHtml
				? `<p>${renderedHtml}</p>`
				: `<p>${text}</p>`

		try {
			const outboundMessageId = randomUUID()
			const emailRes = await sendTenantEmail({
				to: customer.email,
				toName: customer.name,
				subject,
				html,
				text: text || subject,
				context: {
					orgId,
					journeyId: payload.journeyId,
					customerId: customer.id,
					messageId: outboundMessageId,
				},
			})

			if (emailRes.status === 'error') {
				const errorMessage =
					emailRes.error.message || 'Failed to dispatch email'
				await db
					.update(journeyStepExecutions)
					.set({
						status: 'failed',
						errorMessage,
						completedAt: new Date(),
					})
					.where(eq(journeyStepExecutions.id, stepExecutionId))

				return {
					success: false,
					executionId: stepExecutionId,
					status: 'failed',
					error: errorMessage,
					statusCode: 500,
				}
			}

			const messageId =
				emailRes.status === 'success'
					? emailRes.data.messageId
					: emailRes.data.messageId

			await db
				.update(journeyStepExecutions)
				.set({
					executionDetails: JSON.stringify({
						messageId,
						channel: 'email',
						dispatched: true,
						dispatchedAt: new Date().toISOString(),
					}),
				})
				.where(eq(journeyStepExecutions.id, stepExecutionId))

			// Record marketing message outbox entry
			await db.insert(marketingMessages).values({
				id: messageId,
				journeyStepExecutionId: stepExecutionId,
				customerId: customer.id,
				channel: 'email',
				status: 'Sent',
				sentAt: new Date(),
			})

			// Update step execution audit record
			await db
				.update(journeyStepExecutions)
				.set({
					status: 'delivered',
					executionDetails: JSON.stringify({
						messageId,
						channel: 'email',
						deliveredAt: new Date().toISOString(),
					}),
					completedAt: new Date(),
				})
				.where(eq(journeyStepExecutions.id, stepExecutionId))

			// Update journey run current node
			await db
				.update(journeyRuns)
				.set({
					currentNodeId: payload.nodeId,
					currentStepNodeId: payload.nodeId,
					updatedAt: new Date(),
				})
				.where(eq(journeyRuns.id, payload.runId))

			return {
				success: true,
				executionId: stepExecutionId,
				status: 'delivered',
				messageId,
			}
		} catch (dispatchErr) {
			const dispatched = await db
				.select({ executionDetails: journeyStepExecutions.executionDetails })
				.from(journeyStepExecutions)
				.where(eq(journeyStepExecutions.id, stepExecutionId))
				.get()

			if (dispatched && executionWasDispatched(dispatched)) {
				return deliveredResultFromDispatchedExecution({
					id: stepExecutionId,
					executionDetails: dispatched.executionDetails,
				})
			}

			const errorMessage =
				dispatchErr instanceof Error
					? dispatchErr.message
					: 'Email dispatch failed'
			await db
				.update(journeyStepExecutions)
				.set({
					status: 'failed',
					errorMessage,
					completedAt: new Date(),
				})
				.where(eq(journeyStepExecutions.id, stepExecutionId))

			return {
				success: false,
				executionId: stepExecutionId,
				status: 'failed',
				error: errorMessage,
				statusCode: 500,
			}
		}
	} else {
		// SMS Dispatch
		if (!customer.phone || customer.phone.trim().length === 0) {
			const errorMessage = 'Customer has no phone number'
			await db
				.update(journeyStepExecutions)
				.set({
					status: 'failed',
					errorMessage,
					completedAt: new Date(),
				})
				.where(eq(journeyStepExecutions.id, stepExecutionId))

			return {
				success: false,
				executionId: stepExecutionId,
				status: 'failed',
				error: errorMessage,
				statusCode: 422,
			}
		}

		const smsConfig = config as { messageText?: string; content?: string }
		const rawMessage = smsConfig.messageText || smsConfig.content || ''
		const message = interpolateMergeTags(rawMessage, customer, contextData)

		try {
			const smsRes = await sendSms({
				to: customer.phone,
				message,
			})

			const sid =
				smsRes.sid || (smsRes.mock ? 'mock-sms-' + randomUUID() : randomUUID())

			await db
				.update(journeyStepExecutions)
				.set({
					executionDetails: JSON.stringify({
						sid,
						channel: 'sms',
						dispatched: true,
						mock: smsRes.mock || false,
						dispatchedAt: new Date().toISOString(),
					}),
				})
				.where(eq(journeyStepExecutions.id, stepExecutionId))

			// Record marketing message outbox entry
			await db.insert(marketingMessages).values({
				id: randomUUID(),
				journeyStepExecutionId: stepExecutionId,
				customerId: customer.id,
				channel: 'sms',
				status: 'Sent',
				sentAt: new Date(),
			})

			// Update step execution audit record
			await db
				.update(journeyStepExecutions)
				.set({
					status: 'delivered',
					executionDetails: JSON.stringify({
						sid,
						channel: 'sms',
						mock: smsRes.mock || false,
						deliveredAt: new Date().toISOString(),
					}),
					completedAt: new Date(),
				})
				.where(eq(journeyStepExecutions.id, stepExecutionId))

			// Update journey run current node
			await db
				.update(journeyRuns)
				.set({
					currentNodeId: payload.nodeId,
					currentStepNodeId: payload.nodeId,
					updatedAt: new Date(),
				})
				.where(eq(journeyRuns.id, payload.runId))

			return {
				success: true,
				executionId: stepExecutionId,
				status: 'delivered',
				messageId: sid,
			}
		} catch (dispatchErr) {
			const dispatched = await db
				.select({ executionDetails: journeyStepExecutions.executionDetails })
				.from(journeyStepExecutions)
				.where(eq(journeyStepExecutions.id, stepExecutionId))
				.get()

			if (dispatched && executionWasDispatched(dispatched)) {
				return deliveredResultFromDispatchedExecution({
					id: stepExecutionId,
					executionDetails: dispatched.executionDetails,
				})
			}

			const errorMessage =
				dispatchErr instanceof Error
					? dispatchErr.message
					: 'SMS dispatch failed'
			await db
				.update(journeyStepExecutions)
				.set({
					status: 'failed',
					errorMessage,
					completedAt: new Date(),
				})
				.where(eq(journeyStepExecutions.id, stepExecutionId))

			return {
				success: false,
				executionId: stepExecutionId,
				status: 'failed',
				error: errorMessage,
				statusCode: 500,
			}
		}
	}
}

/**
 * Marks a journey run as completed, failed, or cancelled.
 */
export async function completeJourneyRun(
	orgId: string,
	payload: CompleteRunPayload,
) {
	const db = await getTenantDb(orgId)
	const run = await db
		.select()
		.from(journeyRuns)
		.where(eq(journeyRuns.id, payload.runId))
		.get()

	if (!run) {
		return {
			success: false,
			error: `Journey run "${payload.runId}" not found`,
			statusCode: 404,
		}
	}

	await db
		.update(journeyRuns)
		.set({
			status: payload.status,
			errorMessage: payload.errorMessage || null,
			completedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(journeyRuns.id, payload.runId))

	return {
		success: true,
		runId: payload.runId,
		status: payload.status,
	}
}

/**
 * Evaluates a condition node against customer data and journey run context in regional SQLite.
 */
export async function evaluateJourneyCondition(
	orgId: string,
	payload: EvaluateConditionPayload,
) {
	const db = await getTenantDb(orgId)

	const customer = await db
		.select()
		.from(customers)
		.where(eq(customers.id, payload.customerId))
		.get()

	if (!customer) {
		return {
			success: false,
			error: `Customer "${payload.customerId}" not found`,
			statusCode: 404,
		}
	}

	const run = await db
		.select()
		.from(journeyRuns)
		.where(eq(journeyRuns.id, payload.runId))
		.get()

	if (!run) {
		return {
			success: false,
			error: `Journey run "${payload.runId}" not found`,
			statusCode: 404,
		}
	}

	let contextData: Record<string, unknown> = {}
	if (run.contextData) {
		try {
			contextData =
				typeof run.contextData === 'string'
					? JSON.parse(run.contextData)
					: (run.contextData as Record<string, unknown>)
		} catch {
			contextData = {}
		}
	}

	const { field, operator, value } = payload.condition

	// Resolve actual value from customer record or contextData
	let actualValue: unknown = undefined
	const customerRecord = customer as Record<string, unknown>
	if (field in customerRecord) {
		actualValue = customerRecord[field]
	} else if (field in contextData) {
		actualValue = contextData[field]
	}

	// Never persist raw PII into the audit trail. Conditions on name/email/phone
	// record a redacted marker; the boolean result is still authoritative.
	const PII_FIELDS = new Set(['name', 'email', 'phone', 'nationalId', 'ssn'])
	const auditActualValue = PII_FIELDS.has(field) ? '[redacted]' : actualValue

	let result = false
	const strActual =
		actualValue !== undefined && actualValue !== null
			? String(actualValue).trim()
			: ''
	const strExpected = (value || '').trim()

	switch (operator) {
		case 'equals':
			if (typeof actualValue === 'boolean') {
				result =
					actualValue ===
					(strExpected.toLowerCase() === 'true' || strExpected === '1')
			} else {
				result = strActual.toLowerCase() === strExpected.toLowerCase()
			}
			break
		case 'not_equals':
			if (typeof actualValue === 'boolean') {
				result =
					actualValue !==
					(strExpected.toLowerCase() === 'true' || strExpected === '1')
			} else {
				result = strActual.toLowerCase() !== strExpected.toLowerCase()
			}
			break
		case 'contains':
			result = strActual.toLowerCase().includes(strExpected.toLowerCase())
			break
		case 'greater_than': {
			const numActual = Number(actualValue)
			const numExpected = Number(value)
			result =
				!isNaN(numActual) && !isNaN(numExpected)
					? numActual > numExpected
					: strActual > strExpected
			break
		}
		case 'less_than': {
			const numActual = Number(actualValue)
			const numExpected = Number(value)
			result =
				!isNaN(numActual) && !isNaN(numExpected)
					? numActual < numExpected
					: strActual < strExpected
			break
		}
		default:
			result = false
	}

	const stepExecutionId = randomUUID()
	await db.insert(journeyStepExecutions).values({
		id: stepExecutionId,
		runId: payload.runId,
		journeyId: payload.journeyId,
		customerId: payload.customerId,
		nodeId: payload.nodeId,
		nodeType: 'condition',
		stepType: 'condition',
		status: 'completed',
		retryCount: 0,
		executedAt: new Date(),
		completedAt: new Date(),
		executionDetails: JSON.stringify({
			field,
			operator,
			expectedValue: value,
			actualValue: auditActualValue,
			result,
			evaluatedAt: new Date().toISOString(),
		}),
	})

	await db
		.update(journeyRuns)
		.set({
			currentNodeId: payload.nodeId,
			currentStepNodeId: payload.nodeId,
			updatedAt: new Date(),
		})
		.where(eq(journeyRuns.id, payload.runId))

	return {
		success: true,
		executionId: stepExecutionId,
		result,
	}
}

/**
 * Retrieves the graph definition for a journey by ID.
 */
export async function getJourneyDefinition(orgId: string, journeyId: string) {
	const db = await getTenantDb(orgId)
	const journey = await db
		.select()
		.from(marketingJourneys)
		.where(eq(marketingJourneys.id, journeyId))
		.get()

	if (!journey) {
		return {
			success: false,
			error: `Journey "${journeyId}" not found`,
			statusCode: 404,
		}
	}

	let nodes: unknown[] = []
	let edges: unknown[] = []
	let triggerConfig: Record<string, unknown> = {}

	try {
		nodes =
			typeof journey.nodes === 'string'
				? JSON.parse(journey.nodes)
				: journey.nodes || []
	} catch {
		nodes = []
	}

	try {
		edges =
			typeof journey.edges === 'string'
				? JSON.parse(journey.edges)
				: journey.edges || []
	} catch {
		edges = []
	}

	try {
		triggerConfig =
			typeof journey.triggerConfig === 'string'
				? JSON.parse(journey.triggerConfig)
				: (journey.triggerConfig as Record<string, unknown>) || {}
	} catch {
		triggerConfig = {}
	}

	return {
		success: true,
		journey: {
			id: journey.id,
			name: journey.name,
			description: journey.description,
			status: journey.status,
			triggerType: journey.triggerType,
			triggerConfig,
			nodes,
			edges,
			graphJson: journey.graphJson,
			version: journey.version,
			publishedAt: journey.publishedAt,
			createdAt: journey.createdAt,
			updatedAt: journey.updatedAt,
		},
	}
}

/**
 * Evaluates active journeys matching an incoming trigger event and spawns
 * zero-PII Cloudflare Workflow runs.
 */
export async function evaluateAndSpawnTriggers(
	orgId: string,
	triggerType: string,
	customerId: string,
	tenantApiUrl?: string,
	contextData: Record<string, unknown> = {},
) {
	const db = await getTenantDb(orgId)

	// 1. Query active journeys configured for this trigger event
	const activeJourneys = await db
		.select()
		.from(marketingJourneys)
		.where(
			and(
				eq(marketingJourneys.status, 'active'),
				eq(marketingJourneys.triggerType, triggerType as any),
			),
		)
		.all()

	const spawnedRuns: Array<{
		journeyId: string
		runId: string
		workflowInstanceId?: string
	}> = []

	const workerUrl = getEnvVar('JOBS_CRON_WORKER_URL', 'http://localhost:8787')
	const internalToken = getEnvVar('INTERNAL_COMMAND_TOKEN', '')
	const resolvedTenantApiUrl =
		tenantApiUrl ||
		getEnvVar('TENANT_API_URL') ||
		(getNodeRegion() === 'ksa'
			? 'http://localhost:3009'
			: 'http://localhost:3007')

	for (const journey of activeJourneys) {
		const runId = randomUUID()

		// 2. Insert run record in regional SQLite
		await db.insert(journeyRuns).values({
			id: runId,
			journeyId: journey.id,
			customerId,
			triggerEvent: triggerType,
			contextData: JSON.stringify(contextData),
			status: 'running',
			startedAt: new Date(),
		})

		let nodes: unknown[] = []
		let edges: unknown[] = []
		try {
			nodes =
				typeof journey.nodes === 'string'
					? JSON.parse(journey.nodes)
					: journey.nodes || []
		} catch {
			nodes = []
		}
		try {
			edges =
				typeof journey.edges === 'string'
					? JSON.parse(journey.edges)
					: journey.edges || []
		} catch {
			edges = []
		}

		// 3. Dispatch zero-PII payload to Cloudflare Workflow worker
		try {
			const res = await fetch(
				`${workerUrl.replace(/\/$/, '')}/api/workflows/marketing-journey/start`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${internalToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						orgId,
						tenantApiUrl: resolvedTenantApiUrl,
						journeyId: journey.id,
						runId,
						customerId,
						triggerEvent: triggerType,
						graph: { nodes, edges },
					}),
				},
			)

			if (res.ok) {
				const responseData = (await res.json().catch(() => ({}))) as {
					instanceId?: string
					runId?: string
				}
				const instanceId = responseData.instanceId || responseData.runId
				if (instanceId) {
					await db
						.update(journeyRuns)
						.set({ workflowInstanceId: instanceId })
						.where(eq(journeyRuns.id, runId))
				}
				spawnedRuns.push({
					journeyId: journey.id,
					runId,
					workflowInstanceId: instanceId,
				})
			} else {
				console.warn(
					`Workflow worker returned status ${res.status} for journey run ${runId}`,
				)
				await db
					.update(journeyRuns)
					.set({
						errorMessage: `Workflow worker returned status ${res.status}`,
						updatedAt: new Date(),
					})
					.where(eq(journeyRuns.id, runId))
				spawnedRuns.push({ journeyId: journey.id, runId })
			}
		} catch (err) {
			// In dev or test environments where worker is not running, gracefully continue but record error
			console.warn(
				`Could not dispatch to workflow worker at ${workerUrl} for run ${runId}:`,
				err instanceof Error ? err.message : err,
			)
			const errorMsg = err instanceof Error ? err.message : String(err)
			await db
				.update(journeyRuns)
				.set({
					errorMessage: `Workflow worker dispatch error: ${errorMsg}`,
					updatedAt: new Date(),
				})
				.where(eq(journeyRuns.id, runId))
			spawnedRuns.push({ journeyId: journey.id, runId })
		}
	}

	return {
		success: true,
		spawnedCount: spawnedRuns.length,
		runs: spawnedRuns,
	}
}

/**
 * Lists all marketing journeys for an organization with aggregated run counts.
 */
export async function listJourneys(orgId: string) {
	const db = await getTenantDb(orgId)
	const journeys = await db
		.select()
		.from(marketingJourneys)
		.orderBy(desc(marketingJourneys.updatedAt))
		.limit(JOURNEY_LIST_LIMIT)
		.all()

	const runs = await db
		.select({
			journeyId: journeyRuns.journeyId,
			status: journeyRuns.status,
			count: count(),
		})
		.from(journeyRuns)
		.groupBy(journeyRuns.journeyId, journeyRuns.status)
		.all()

	const runStatsMap = new Map<
		string,
		{ total: number; running: number; completed: number; failed: number }
	>()

	for (const r of runs) {
		const stats = runStatsMap.get(r.journeyId) || {
			total: 0,
			running: 0,
			completed: 0,
			failed: 0,
		}
		stats.total += r.count
		if (r.status === 'running') stats.running += r.count
		if (r.status === 'completed') stats.completed += r.count
		if (r.status === 'failed') stats.failed += r.count
		runStatsMap.set(r.journeyId, stats)
	}

	const formattedJourneys = journeys.map((j) => {
		let nodes: unknown[] = []
		let edges: unknown[] = []
		let triggerConfig: Record<string, unknown> = {}

		try {
			nodes = typeof j.nodes === 'string' ? JSON.parse(j.nodes) : j.nodes || []
		} catch {}
		try {
			edges = typeof j.edges === 'string' ? JSON.parse(j.edges) : j.edges || []
		} catch {}
		try {
			triggerConfig =
				typeof j.triggerConfig === 'string'
					? JSON.parse(j.triggerConfig)
					: (j.triggerConfig as Record<string, unknown>) || {}
		} catch {}

		return {
			...j,
			nodes,
			edges,
			triggerConfig,
			stats: runStatsMap.get(j.id) || {
				total: 0,
				running: 0,
				completed: 0,
				failed: 0,
			},
		}
	})

	return { journeys: formattedJourneys }
}

/**
 * Creates a new marketing journey draft for an organization.
 */
export async function createJourney(orgId: string, input: CreateJourneyInput) {
	const db = await getTenantDb(orgId)

	const nodes = input.nodes || []
	const edges = input.edges || []

	// Validate DAG if nodes are provided
	if (nodes.length > 0) {
		const validation = validateWorkflowDAG({ nodes, edges })
		if (!validation.valid) {
			return {
				success: false,
				error: 'Invalid workflow DAG structure',
				issues: validation.errors,
				statusCode: 400,
			}
		}
	}

	const journeyId = randomUUID()
	const graphJson = input.graphJson || JSON.stringify({ nodes, edges })

	const newJourney = {
		id: journeyId,
		name: input.name,
		description: input.description || null,
		status: 'draft' as const,
		triggerType: input.triggerType || ('phone_verified' as const),
		triggerConfig: JSON.stringify(input.triggerConfig || {}),
		graphJson,
		nodes: JSON.stringify(nodes),
		edges: JSON.stringify(edges),
		version: 1,
		createdAt: new Date(),
		updatedAt: new Date(),
	}

	await db.insert(marketingJourneys).values(newJourney)

	return {
		success: true,
		journeyId,
		journey: {
			...newJourney,
			nodes,
			edges,
			triggerConfig: input.triggerConfig || {},
		},
	}
}

/**
 * Updates a marketing journey definition.
 */
export async function updateJourney(
	orgId: string,
	journeyId: string,
	input: UpdateJourneyInput,
) {
	const db = await getTenantDb(orgId)
	const existing = await db
		.select()
		.from(marketingJourneys)
		.where(eq(marketingJourneys.id, journeyId))
		.get()

	if (!existing) {
		return {
			success: false,
			error: `Journey "${journeyId}" not found`,
			statusCode: 404,
		}
	}

	let nodes = input.nodes
	let edges = input.edges

	if (nodes !== undefined || edges !== undefined) {
		const candidateNodes =
			nodes !== undefined
				? nodes
				: typeof existing.nodes === 'string'
					? JSON.parse(existing.nodes)
					: existing.nodes || []
		const candidateEdges =
			edges !== undefined
				? edges
				: typeof existing.edges === 'string'
					? JSON.parse(existing.edges)
					: existing.edges || []

		if (input.status === 'active' || existing.status === 'active') {
			const validation = validateWorkflowDAG({
				nodes: candidateNodes,
				edges: candidateEdges,
			})
			if (!validation.valid) {
				return {
					success: false,
					error: 'Cannot update active journey with invalid graph DAG',
					issues: validation.errors,
					statusCode: 400,
				}
			}
		}
	}

	const updateValues: Partial<typeof marketingJourneys.$inferInsert> = {
		updatedAt: new Date(),
		version: existing.version + 1,
	}

	if (input.name !== undefined) updateValues.name = input.name
	if (input.description !== undefined)
		updateValues.description = input.description || null
	if (input.status !== undefined) updateValues.status = input.status
	if (input.triggerType !== undefined)
		updateValues.triggerType = input.triggerType
	if (input.triggerConfig !== undefined)
		updateValues.triggerConfig = JSON.stringify(input.triggerConfig)
	if (input.nodes !== undefined)
		updateValues.nodes = JSON.stringify(input.nodes)
	if (input.edges !== undefined)
		updateValues.edges = JSON.stringify(input.edges)
	if (input.graphJson !== undefined) {
		updateValues.graphJson = input.graphJson
	} else if (input.nodes !== undefined || input.edges !== undefined) {
		const n =
			input.nodes !== undefined
				? input.nodes
				: typeof existing.nodes === 'string'
					? JSON.parse(existing.nodes)
					: existing.nodes || []
		const e =
			input.edges !== undefined
				? input.edges
				: typeof existing.edges === 'string'
					? JSON.parse(existing.edges)
					: existing.edges || []
		updateValues.graphJson = JSON.stringify({ nodes: n, edges: e })
	}

	await db
		.update(marketingJourneys)
		.set(updateValues)
		.where(eq(marketingJourneys.id, journeyId))

	return {
		success: true,
		journeyId,
		version: updateValues.version,
	}
}

/**
 * Validates and publishes a journey (transitions to 'active' status).
 */
export async function publishJourney(orgId: string, journeyId: string) {
	const db = await getTenantDb(orgId)
	const journey = await db
		.select()
		.from(marketingJourneys)
		.where(eq(marketingJourneys.id, journeyId))
		.get()

	if (!journey) {
		return {
			success: false,
			error: `Journey "${journeyId}" not found`,
			statusCode: 404,
		}
	}

	let nodes: unknown[] = []
	let edges: unknown[] = []
	try {
		nodes =
			typeof journey.nodes === 'string'
				? JSON.parse(journey.nodes)
				: journey.nodes || []
	} catch {}
	try {
		edges =
			typeof journey.edges === 'string'
				? JSON.parse(journey.edges)
				: journey.edges || []
	} catch {}

	const validation = validateWorkflowDAG({ nodes, edges })
	if (!validation.valid) {
		return {
			success: false,
			error: 'Cannot publish journey with invalid graph DAG',
			issues: validation.errors,
			statusCode: 400,
		}
	}

	const now = new Date()
	await db
		.update(marketingJourneys)
		.set({
			status: 'active',
			publishedAt: now,
			updatedAt: now,
		})
		.where(eq(marketingJourneys.id, journeyId))

	return {
		success: true,
		status: 'active',
		publishedAt: now.toISOString(),
	}
}

/**
 * Pauses an active journey.
 */
export async function pauseJourney(orgId: string, journeyId: string) {
	const db = await getTenantDb(orgId)
	const journey = await db
		.select()
		.from(marketingJourneys)
		.where(eq(marketingJourneys.id, journeyId))
		.get()

	if (!journey) {
		return {
			success: false,
			error: `Journey "${journeyId}" not found`,
			statusCode: 404,
		}
	}

	await db
		.update(marketingJourneys)
		.set({
			status: 'paused',
			updatedAt: new Date(),
		})
		.where(eq(marketingJourneys.id, journeyId))

	return {
		success: true,
		status: 'paused',
	}
}

/**
 * Deletes a journey and cascades deletion to runs and step executions.
 */
export async function deleteJourney(orgId: string, journeyId: string) {
	const db = await getTenantDb(orgId)
	const journey = await db
		.select()
		.from(marketingJourneys)
		.where(eq(marketingJourneys.id, journeyId))
		.get()

	if (!journey) {
		return {
			success: false,
			error: `Journey "${journeyId}" not found`,
			statusCode: 404,
		}
	}

	await db.delete(marketingJourneys).where(eq(marketingJourneys.id, journeyId))

	return { success: true }
}

/**
 * Lists execution runs for a specific journey.
 */
export async function listJourneyRuns(orgId: string, journeyId: string) {
	const db = await getTenantDb(orgId)
	const runs = await db
		.select({
			id: journeyRuns.id,
			journeyId: journeyRuns.journeyId,
			customerId: journeyRuns.customerId,
			customerName: customers.name,
			customerEmail: customers.email,
			customerPhone: customers.phone,
			workflowInstanceId: journeyRuns.workflowInstanceId,
			status: journeyRuns.status,
			currentNodeId: journeyRuns.currentNodeId,
			currentStepNodeId: journeyRuns.currentStepNodeId,
			triggerEvent: journeyRuns.triggerEvent,
			errorMessage: journeyRuns.errorMessage,
			startedAt: journeyRuns.startedAt,
			completedAt: journeyRuns.completedAt,
			createdAt: journeyRuns.createdAt,
			updatedAt: journeyRuns.updatedAt,
		})
		.from(journeyRuns)
		.leftJoin(customers, eq(journeyRuns.customerId, customers.id))
		.where(eq(journeyRuns.journeyId, journeyId))
		.orderBy(desc(journeyRuns.startedAt))
		.limit(JOURNEY_LIST_LIMIT)
		.all()

	return { runs }
}

/**
 * Gets step execution timeline for a specific journey run.
 */
export async function getJourneyRunTimeline(orgId: string, runId: string) {
	const db = await getTenantDb(orgId)
	const run = await db
		.select({
			id: journeyRuns.id,
			journeyId: journeyRuns.journeyId,
			customerId: journeyRuns.customerId,
			customerName: customers.name,
			customerEmail: customers.email,
			customerPhone: customers.phone,
			workflowInstanceId: journeyRuns.workflowInstanceId,
			status: journeyRuns.status,
			currentNodeId: journeyRuns.currentNodeId,
			currentStepNodeId: journeyRuns.currentStepNodeId,
			triggerEvent: journeyRuns.triggerEvent,
			errorMessage: journeyRuns.errorMessage,
			startedAt: journeyRuns.startedAt,
			completedAt: journeyRuns.completedAt,
			createdAt: journeyRuns.createdAt,
			updatedAt: journeyRuns.updatedAt,
		})
		.from(journeyRuns)
		.leftJoin(customers, eq(journeyRuns.customerId, customers.id))
		.where(eq(journeyRuns.id, runId))
		.get()

	if (!run) {
		return {
			success: false,
			error: `Run "${runId}" not found`,
			statusCode: 404,
		}
	}

	const steps = await db
		.select()
		.from(journeyStepExecutions)
		.where(eq(journeyStepExecutions.runId, runId))
		.orderBy(journeyStepExecutions.executedAt)
		.all()

	return {
		success: true,
		run,
		steps,
	}
}

/**
 * Triggers a manual test execution of a journey for a specific customer.
 */
export async function triggerTestJourney(
	orgId: string,
	payload: { journeyId: string; customerId: string },
) {
	const db = await getTenantDb(orgId)

	const journey = await db
		.select()
		.from(marketingJourneys)
		.where(eq(marketingJourneys.id, payload.journeyId))
		.get()

	if (!journey) {
		return {
			success: false,
			error: `Journey "${payload.journeyId}" not found`,
			statusCode: 404,
		}
	}

	const customer = await db
		.select()
		.from(customers)
		.where(eq(customers.id, payload.customerId))
		.get()

	if (!customer) {
		return {
			success: false,
			error: `Customer "${payload.customerId}" not found`,
			statusCode: 404,
		}
	}

	const runId = randomUUID()
	await db.insert(journeyRuns).values({
		id: runId,
		journeyId: journey.id,
		customerId: customer.id,
		triggerEvent: 'manual',
		status: 'running',
		contextData: JSON.stringify({ isTestRun: true }),
		startedAt: new Date(),
	})

	let nodes: unknown[] = []
	let edges: unknown[] = []
	try {
		nodes =
			typeof journey.nodes === 'string'
				? JSON.parse(journey.nodes)
				: journey.nodes || []
	} catch {}
	try {
		edges =
			typeof journey.edges === 'string'
				? JSON.parse(journey.edges)
				: journey.edges || []
	} catch {}

	const workerUrl = getEnvVar('JOBS_CRON_WORKER_URL', 'http://localhost:8787')
	const internalToken = getEnvVar('INTERNAL_COMMAND_TOKEN', '')
	const tenantApiUrl =
		getEnvVar('TENANT_API_URL') ||
		(getNodeRegion() === 'ksa'
			? 'http://localhost:3009'
			: 'http://localhost:3007')

	try {
		const res = await fetch(
			`${workerUrl.replace(/\/$/, '')}/api/workflows/marketing-journey/start`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${internalToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					orgId,
					tenantApiUrl,
					journeyId: journey.id,
					runId,
					customerId: customer.id,
					triggerEvent: 'manual',
					graph: { nodes, edges },
				}),
			},
		)

		if (res.ok) {
			const data = (await res.json().catch(() => ({}))) as {
				instanceId?: string
			}
			if (data.instanceId) {
				await db
					.update(journeyRuns)
					.set({ workflowInstanceId: data.instanceId })
					.where(eq(journeyRuns.id, runId))
			}
		}
	} catch (err) {
		console.warn('Could not dispatch test journey to workflow worker:', err)
	}

	return {
		success: true,
		runId,
		status: 'running',
	}
}
