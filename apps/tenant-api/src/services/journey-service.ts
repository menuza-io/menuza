import { createHash, randomUUID } from 'node:crypto'
import { eq, and, desc, count } from 'drizzle-orm'
import { ENV } from 'varlock/env'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import {
	BROADCAST_TOPIC,
	hasDeliverableSubscription,
	hasMarketingConsent,
} from './marketing-audience.ts'
import { z } from 'zod'
import {
	getTenantDb,
	customers,
	marketingJourneys,
	journeyRuns,
	journeyStepExecutions,
	marketingMessages,
	isLoyaltyJourneyTrigger,
	isReservationJourneyTrigger,
	validateWorkflowDAG,
	actionEmailNodeDataSchema,
	actionPushNodeDataSchema,
	interpolateMergeTags,
	interpolateMergeTagsHtml,
	createJourneySchema,
	updateJourneySchema,
	type ExecuteStepPayload,
	type CompleteRunPayload,
	type EvaluateConditionPayload,
	runTenantTransaction,
	JOURNEY_GOAL_REACHED_REASON,
	triggerConfigMatches,
} from '@repo/tenant-db'
import { withUnsubscribeFooter } from '@repo/common/email-unsubscribe'
import { billingPeriod } from '@repo/common/marketing-allowance'
import { parseMarketingOffer } from '@repo/discounts'
import { sendSms } from '@repo/sms'
import {
	consentBaseUrl,
	listUnsubscribeHeaders,
	unsubscribeUrl,
} from '../lib/email-consent.ts'
import { isMarketingSmsEnabled } from '../lib/marketing-sms-switch.ts'
import { postSmsAllowance } from '../lib/sms-allowance-client.ts'
import { getNodeRegion } from '../lib/region.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { couponCodeForRecipient } from './discount-marketing-codes.ts'
import { loyaltyMergeValues } from './loyalty-merge-values.ts'
import {
	goalReachedForRun,
	marketingMessageCount,
	readFrequencyCap,
} from './journey-guards.ts'
import {
	isVirtualConditionField,
	virtualConditionValue,
} from './journey-conditions.ts'
import { customerInAudience } from './marketing-audience-service.ts'
import { cartLinkForGuest } from './cart-reminders.ts'
import { tagEmailLinks } from './campaign-links.ts'
import { prepareMarketingSms, TIME_ZONE_RETRY_MS } from './marketing-sms.ts'

export const JOURNEY_PROCESSING_LEASE_MS = 5 * 60 * 1000
export const JOURNEY_LIST_LIMIT = 100

/** Triggers that describe a one-time change of a customer, not an event. */
const ONCE_PER_CUSTOMER_TRIGGERS: ReadonlySet<string> = new Set([
	'phone_verified',
	'profile_completed',
])

/** Drizzle wraps the driver error: the constraint message may be on `cause`. */
function isWrappedUniqueError(error: unknown, depth = 0): boolean {
	if (!(error instanceof Error) || depth > 4) return false
	return (
		isSqliteUniqueConstraintError(error) ||
		isWrappedUniqueError(error.cause, depth + 1)
	)
}

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
	let outcomeUnknown = false
	try {
		const details =
			typeof execution.executionDetails === 'string'
				? JSON.parse(execution.executionDetails)
				: execution.executionDetails
		if (details && typeof details === 'object') {
			outcomeUnknown = details.outcomeUnknown === true
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
		status: outcomeUnknown ? 'unknown' : 'delivered',
		messageId,
	}
}

/**
 * The opaque id an automation text step holds its send of the month under: a
 * hash of the journey, the step and the billing month, so a step is counted
 * once per month and the control plane never learns a journey's contents.
 */
export function journeyStepAllowanceKey(
	journeyId: string,
	nodeId: string,
	now: number,
): string {
	const period = billingPeriod(now).key
	const digest = createHash('sha256')
		.update(`${journeyId}:${nodeId}:${period}`)
		.digest('hex')
		.slice(0, 40)
	return `journey:${digest}`
}

/** An operator's test run (`contextData.isTestRun`) is never held for quiet hours. */
function isTestRunContext(raw: unknown): boolean {
	try {
		const value = typeof raw === 'string' ? JSON.parse(raw) : raw
		return (value as { isTestRun?: unknown } | null)?.isTestRun === true
	} catch {
		return false
	}
}

function parseRunContext(raw: unknown): Record<string, unknown> {
	if (!raw) return {}
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
		return parsed && typeof parsed === 'object'
			? (parsed as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

/**
 * Why a run must not take another step, or null when it may. A run goes on
 * only while it is `running` and its journey is `active`. An operator test run
 * (`triggerTestJourney`) may also exercise a draft or paused journey, but never
 * an archived one. Pausing a journey therefore stops its in-flight runs at
 * their next step, including runs waiting out a delay.
 */
function runHaltReason(
	run: { status: string; triggerEvent?: string | null; contextData?: unknown },
	journey: { status: string } | undefined,
): string | null {
	if (run.status !== 'running') return `Journey run is ${run.status}`
	if (!journey) return 'Journey no longer exists'
	if (journey.status === 'active') return null
	const isTestRun =
		run.triggerEvent === 'manual' &&
		parseRunContext(run.contextData).isTestRun === true
	if (isTestRun && journey.status !== 'archived') return null
	return `Journey is ${journey.status}`
}

/**
 * Loads the run's journey and, when the run must stop, cancels the run (only
 * from `running`, so a finished run keeps its outcome) and returns the reason.
 */
async function haltRunIfStopped(
	db: Awaited<ReturnType<typeof getTenantDb>>,
	run: typeof journeyRuns.$inferSelect,
): Promise<string | null> {
	const journey = await db
		.select({ status: marketingJourneys.status, goal: marketingJourneys.goal })
		.from(marketingJourneys)
		.where(eq(marketingJourneys.id, run.journeyId))
		.get()
	let reason = runHaltReason(run, journey)
	// "Stop when the guest places an order" (#99): checked before every step,
	// a delay included, because a step is only ever run after its delay ended.
	// An operator's test run never stops for a goal.
	if (
		!reason &&
		journey?.goal === 'order' &&
		run.status === 'running' &&
		parseRunContext(run.contextData).isTestRun !== true &&
		(await goalReachedForRun(db, run))
	) {
		reason = JOURNEY_GOAL_REACHED_REASON
	}
	if (reason && run.status === 'running') {
		await db
			.update(journeyRuns)
			.set({
				status: 'cancelled',
				errorMessage: reason,
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(and(eq(journeyRuns.id, run.id), eq(journeyRuns.status, 'running')))
	}
	return reason
}

/**
 * A provider error after which the message may or may not have gone out: a
 * timeout, a dropped connection, or a provider 5xx. A definitive refusal (4xx,
 * missing credentials, a refused connection) means nothing was sent.
 */
const AMBIGUOUS_NETWORK_CODES = new Set([
	'ETIMEDOUT',
	'ECONNRESET',
	'ECONNABORTED',
	'EPIPE',
	'ESOCKETTIMEDOUT',
	'UND_ERR_SOCKET',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
])
export function isAmbiguousDispatchError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false
	const e = error as {
		name?: unknown
		code?: unknown
		status?: unknown
		statusCode?: unknown
		outcomeUnknown?: unknown
		cause?: unknown
	}
	if (e.outcomeUnknown === true) return true
	if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
	if (typeof e.code === 'string' && AMBIGUOUS_NETWORK_CODES.has(e.code)) {
		return true
	}
	const status =
		typeof e.status === 'number'
			? e.status
			: typeof e.statusCode === 'number'
				? e.statusCode
				: undefined
	if (status !== undefined && (status === 408 || status >= 500)) return true
	if (e.cause && e.cause !== error) return isAmbiguousDispatchError(e.cause)
	return false
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

/**
 * Another attempt holds this step's lease and may be sending right now. Not a
 * success: a caller that took it as one would move the journey on even when
 * that attempt died before sending. 409 is retried by the workflow until the
 * lease expires and the step can be reclaimed.
 */
function stillProcessing(executionId: string): StepExecutionResult {
	return {
		success: false,
		executionId,
		status: 'processing',
		error: 'Step is still being sent by another attempt',
		statusCode: 409,
	}
}

export interface StepExecutionResult {
	success: boolean
	executionId?: string
	/**
	 * `halted`: the journey was paused or the run ended, so nothing was sent
	 * and the workflow must stop the run. `unknown`: the provider failed in a
	 * way that may have sent the message; it is never sent again.
	 */
	status:
		| 'delivered'
		| 'failed'
		| 'skipped'
		| 'processing'
		| 'halted'
		| 'unknown'
		/**
		 * A marketing text outside 9:00 to 20:00 local time (#75): nothing was
		 * sent or recorded, and the workflow sleeps until `notBefore` and asks
		 * again. A step moves forward; it is never dropped.
		 */
		| 'deferred'
	/** With `deferred`: the instant (epoch ms) the step may be asked again. */
	notBefore?: number
	messageId?: string
	/** Why a step was `skipped`. */
	reason?: JourneySkipReason
	error?: string
	statusCode?: number
}

/**
 * Reservation journeys reach guests who agreed to hear from the restaurant,
 * on the channels they agreed to. A step on any other channel (or after the
 * guest withdrew) is recorded as skipped and nothing is sent. Loyalty journeys
 * likewise need a deliverable marketing subscription. Journeys with any other
 * trigger keep their behavior.
 */
async function skipWithoutReservationConsent(
	db: Awaited<ReturnType<typeof getTenantDb>>,
	payload: ExecuteStepPayload,
	stepType: 'email' | 'sms' | 'push',
): Promise<StepExecutionResult | null> {
	if (!payload.journeyId) return null
	const journey = await db
		.select({ triggerType: marketingJourneys.triggerType })
		.from(marketingJourneys)
		.where(eq(marketingJourneys.id, payload.journeyId))
		.get()
	if (!journey) return null
	const topic = isReservationJourneyTrigger(journey.triggerType)
		? ('reservations' as const)
		: isLoyaltyJourneyTrigger(journey.triggerType)
			? ('marketing' as const)
			: null
	if (!topic) return null

	// Active subscription on the `reservations` topic (loyalty journeys: the
	// `marketing` topic, so a member without marketing consent gets nothing); an
	// email also needs an address its owner confirmed (double opt-in), like a
	// broadcast does.
	const consent = await hasDeliverableSubscription(db, {
		customerId: payload.customerId,
		topic,
		channel: stepType,
	})
	if (consent) return null

	const existing = await db
		.select()
		.from(journeyStepExecutions)
		.where(
			and(
				eq(journeyStepExecutions.runId, payload.runId),
				eq(journeyStepExecutions.nodeId, payload.nodeId),
			),
		)
		.get()
	// What was already sent stays sent; the retry just reports it.
	if (
		existing &&
		(existing.status === 'delivered' || existing.status === 'completed')
	) {
		return null
	}
	const details = JSON.stringify({
		skipped: true,
		reason: 'no_consent',
		skipReason: 'no_consent' satisfies JourneySkipReason,
		channel: stepType,
	})
	if (existing) {
		await db
			.update(journeyStepExecutions)
			.set({
				status: 'skipped',
				executionDetails: details,
				errorMessage: null,
				completedAt: new Date(),
			})
			.where(eq(journeyStepExecutions.id, existing.id))
		return { success: true, executionId: existing.id, status: 'skipped' }
	}
	const executionId = randomUUID()
	await db
		.insert(journeyStepExecutions)
		.values({
			id: executionId,
			runId: payload.runId,
			journeyId: payload.journeyId,
			customerId: payload.customerId,
			nodeId: payload.nodeId,
			nodeType: payload.nodeType as 'action_email',
			stepType,
			status: 'skipped',
			retryCount: 0,
			executionDetails: details,
			executedAt: new Date(),
			completedAt: new Date(),
		})
		.onConflictDoNothing()
	return { success: true, executionId, status: 'skipped' }
}

/**
 * Recorded as `executionDetails.skipReason` on a skipped step, so the runs view
 * can say why nothing was sent. `no_consent`: the customer has no marketing
 * consent for the step's channel (see `hasMarketingConsent`).
 * `no_unsubscribe_origin`: an email step with no trusted origin for its
 * unsubscribe link (`TENANT_API_URL` unset in production), so it is not sent.
 */
export type JourneySkipReason =
	| 'no_consent'
	| 'no_unsubscribe_origin'
	| 'frequency_capped'
	/** `MARKETING_SMS_ENABLED=false` on this node (#75). */
	| 'marketing_sms_disabled'

/**
 * The provider may have accepted the message (timeout, dropped connection,
 * 5xx). Marks the step dispatched with an unknown outcome so no retry sends it
 * again (at most once), and lets the journey go on.
 */
async function recordOutcomeUnknown(
	db: Awaited<ReturnType<typeof getTenantDb>>,
	input: {
		stepExecutionId: string
		channel: 'email' | 'sms' | 'push'
		messageId?: string
		errorMessage: string
	},
): Promise<StepExecutionResult> {
	await db
		.update(journeyStepExecutions)
		.set({
			status: 'failed',
			errorMessage: `Dispatch outcome unknown, not resent: ${input.errorMessage}`,
			executionDetails: JSON.stringify({
				...(input.messageId ? { messageId: input.messageId } : {}),
				channel: input.channel,
				dispatched: true,
				outcomeUnknown: true,
				dispatchedAt: new Date().toISOString(),
			}),
			completedAt: new Date(),
		})
		.where(eq(journeyStepExecutions.id, input.stepExecutionId))
	return {
		success: true,
		executionId: input.stepExecutionId,
		status: 'unknown',
		messageId: input.messageId,
	}
}

/**
 * The push step (#105). Consent, the frequency cap and idempotency are checked
 * by the caller before this runs; the push goes out once per run and step (the
 * send log is unique per run, step and device), only to a guest who opted in,
 * with the operator's plain words (no merge tags) and a link on the site.
 */
async function executePushDispatch(
	db: Awaited<ReturnType<typeof getTenantDb>>,
	input: {
		orgId: string
		payload: ExecuteStepPayload
		customerId: string
		stepExecutionId: string
		config: Record<string, unknown>
		isTestRun: boolean
		journeyId: string
		runId: string
	},
): Promise<StepExecutionResult> {
	const { stepExecutionId } = input
	const fail = async (errorMessage: string, statusCode: number) => {
		await db
			.update(journeyStepExecutions)
			.set({ status: 'failed', errorMessage, completedAt: new Date() })
			.where(eq(journeyStepExecutions.id, stepExecutionId))
		return {
			success: false as const,
			executionId: stepExecutionId,
			status: 'failed' as const,
			error: errorMessage,
			statusCode,
		}
	}
	const parsed = actionPushNodeDataSchema.safeParse(input.config)
	if (!parsed.success) return fail('Invalid push configuration', 422)
	const { sendPushToCustomer, marketingBuilder } =
		await import('./push-service.ts')
	const result = await sendPushToCustomer(db, {
		orgId: input.orgId,
		customerId: input.customerId,
		kind: 'marketing',
		ref: `${input.runId}:${input.payload.nodeId}`,
		build: marketingBuilder(parsed.data),
	})
	if (result.sent === 0) {
		await db
			.update(journeyStepExecutions)
			.set({
				status: 'skipped',
				errorMessage: null,
				executionDetails: JSON.stringify({
					skipReason: 'no_consent' satisfies JourneySkipReason,
					channel: 'push',
					detail: result.reason ?? 'not_sent',
				}),
				completedAt: new Date(),
			})
			.where(eq(journeyStepExecutions.id, stepExecutionId))
		return {
			success: true,
			executionId: stepExecutionId,
			status: 'skipped',
			reason: 'no_consent',
		}
	}
	// Counted by the frequency cap like any marketing message.
	await db.insert(marketingMessages).values({
		id: randomUUID(),
		journeyStepExecutionId: stepExecutionId,
		customerId: input.customerId,
		channel: 'push',
		status: 'Sent',
		sentAt: new Date(),
	})
	await db
		.update(journeyStepExecutions)
		.set({
			status: 'delivered',
			executionDetails: JSON.stringify({
				channel: 'push',
				dispatched: true,
				deliveredAt: new Date().toISOString(),
			}),
			completedAt: new Date(),
		})
		.where(eq(journeyStepExecutions.id, stepExecutionId))
	await db
		.update(journeyRuns)
		.set({
			currentNodeId: input.payload.nodeId,
			currentStepNodeId: input.payload.nodeId,
			updatedAt: new Date(),
		})
		.where(eq(journeyRuns.id, input.runId))
	return {
		success: true,
		executionId: stepExecutionId,
		status: 'delivered',
	}
}

/**
 * Executes a journey action step (Email, SMS or push) within the regional boundary.
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

	// A paused journey or an ended run sends nothing more. `halted` is not a
	// failure the workflow retries: it ends the run there.
	const haltReason = await haltRunIfStopped(db, run)
	if (haltReason) {
		return {
			success: true,
			status: 'halted',
			error: haltReason,
		}
	}

	const rawType = payload.nodeType
	const stepType: 'email' | 'sms' | 'push' =
		rawType === 'action_email' || rawType === 'email'
			? 'email'
			: rawType === 'action_push' || rawType === 'push'
				? 'push'
				: 'sms'

	const skipped = await skipWithoutReservationConsent(db, payload, stepType)
	if (skipped) return skipped

	// Quiet hours (#75): a marketing text goes out from 9:00 to 20:00 in the
	// location's time zone. Outside it nothing is written; the workflow sleeps
	// until the window opens and asks again. An operator's own test run is not
	// held back.
	if (stepType === 'sms' && !isTestRunContext(run.contextData)) {
		const timing = await prepareMarketingSms({
			orgId,
			text: '',
			now: Date.now(),
		})
		if (timing.reason) {
			return {
				success: true,
				status: 'deferred',
				notBefore: timing.notBefore,
				error: timing.reason,
			}
		}
		// The monthly text allowance (#247): an automation text step counts one
		// send the first time it sends in a billing month, however many guests
		// pass through it. With none left the step waits for the month to turn
		// over, as a broadcast does; it is never dropped.
		const gate = await postSmsAllowance({
			orgId,
			campaignId: journeyStepAllowanceKey(
				payload.journeyId,
				payload.nodeId,
				Date.now(),
			),
			action: 'start',
		})
		if (gate.ok === false) {
			return {
				success: true,
				status: 'deferred',
				notBefore: gate.resetsAt,
				error: 'allowance_exhausted',
			}
		}
		if (gate.ok === 'unavailable') {
			return {
				success: true,
				status: 'deferred',
				notBefore: Date.now() + TIME_ZONE_RETRY_MS,
				error: 'allowance_unavailable',
			}
		}
	}

	const txResult = await retryOnSqliteBusy(() =>
		runTenantTransaction(db, async (tx) => {
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

			const skippedExecution = existing.find((e) => e.status === 'skipped')
			if (skippedExecution) {
				return {
					success: true,
					executionId: skippedExecution.id,
					status: 'skipped' as const,
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
				return stillProcessing(processingExecution.id)
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

				if (raced.status === 'skipped') {
					return {
						success: true,
						executionId: raced.id,
						status: 'skipped' as const,
					}
				}

				if (
					raced.status === 'processing' &&
					raced.executedAt &&
					Date.now() - new Date(raced.executedAt).getTime() <
						JOURNEY_PROCESSING_LEASE_MS
				) {
					return stillProcessing(raced.id)
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

	// Journeys are marketing: the same consent rules as a broadcast apply to
	// every send (active subscription, confirmed email, verified phone). A
	// customer without consent skips this step and the journey goes on. There
	// is no transactional exemption: a welcome text right after
	// `phone_verified` is skipped until the customer subscribes to texts (see
	// docs/platform-marketing-email.md, "Journey consent").
	// Reservation journeys are gated on the `reservations` topic instead
	// (`skipWithoutReservationConsent`): a guest who agreed to hear about their
	// bookings has not agreed to marketing.
	const journeyRow = payload.journeyId
		? await db
				.select({
					triggerType: marketingJourneys.triggerType,
					name: marketingJourneys.name,
				})
				.from(marketingJourneys)
				.where(eq(marketingJourneys.id, payload.journeyId))
				.get()
		: undefined
	const journeyTrigger = journeyRow?.triggerType
	const journeyName = journeyRow?.name ?? null
	const isReservationJourney = isReservationJourneyTrigger(
		journeyTrigger ?? run.triggerEvent,
	)
	if (
		!isReservationJourney &&
		!(await hasMarketingConsent(db, customer.id, stepType))
	) {
		await db
			.update(journeyStepExecutions)
			.set({
				status: 'skipped',
				errorMessage:
					stepType === 'sms'
						? 'Skipped: the customer has not subscribed to marketing texts'
						: stepType === 'push'
							? 'Skipped: the customer has not turned on push offers and news'
							: 'Skipped: the customer has not confirmed marketing email',
				executionDetails: JSON.stringify({
					skipReason: 'no_consent' satisfies JourneySkipReason,
					channel: stepType,
				}),
				completedAt: new Date(),
			})
			.where(eq(journeyStepExecutions.id, stepExecutionId))
		return {
			success: true,
			executionId: stepExecutionId,
			status: 'skipped',
			reason: 'no_consent',
		}
	}

	// The frequency cap (#99): at most N marketing messages per guest per window,
	// across broadcasts and automations. Transactional messages never count (they
	// are not in `marketing_messages`). A step over the cap is skipped, the
	// journey goes on, and the run timeline says why. Not applied to an
	// operator's own test run.
	if (contextData.isTestRun !== true) {
		const cap = await readFrequencyCap(db)
		if (
			cap &&
			(await marketingMessageCount(db, customer.id, cap, Date.now())) >=
				cap.limit
		) {
			await db
				.update(journeyStepExecutions)
				.set({
					status: 'skipped',
					errorMessage: null,
					executionDetails: JSON.stringify({
						skipped: true,
						skipReason: 'frequency_capped' satisfies JourneySkipReason,
						channel: stepType,
						cappedAt: new Date().toISOString(),
					}),
					completedAt: new Date(),
				})
				.where(eq(journeyStepExecutions.id, stepExecutionId))
			return {
				success: true,
				executionId: stepExecutionId,
				status: 'skipped',
				reason: 'frequency_capped',
			}
		}
	}

	// Every journey email carries a signed unsubscribe link, like a broadcast.
	// The link's origin must be the configured one: without it the step is
	// skipped before anything is sent or a coupon is minted. Ids only in the log.
	const consentOrigin = stepType === 'email' ? consentBaseUrl() : null
	if (stepType === 'email' && !consentOrigin) {
		console.error('Journey email skipped: TENANT_API_URL is not set', {
			orgId,
			journeyId: payload.journeyId,
			runId: payload.runId,
		})
		await db
			.update(journeyStepExecutions)
			.set({
				status: 'skipped',
				errorMessage:
					'Skipped: no unsubscribe link could be made (TENANT_API_URL is not set)',
				executionDetails: JSON.stringify({
					skipReason: 'no_unsubscribe_origin' satisfies JourneySkipReason,
					channel: stepType,
				}),
				completedAt: new Date(),
			})
			.where(eq(journeyStepExecutions.id, stepExecutionId))
		return {
			success: true,
			executionId: stepExecutionId,
			status: 'skipped',
			reason: 'no_unsubscribe_origin',
		}
	}

	// A loyalty journey fills the points tags from the customer's account as it
	// is now, not as it was when the journey started.
	if (isLoyaltyJourneyTrigger(run.triggerEvent)) {
		const rewardId = contextData.rewardId
		contextData = {
			...contextData,
			...(await loyaltyMergeValues(
				orgId,
				customer.id,
				typeof rewardId === 'string' ? rewardId : null,
			)),
		}
	}

	// A cart reminder fills `{{cartLink}}` with the guest's "Back to your order"
	// link, minted now (valid 7 days). Empty when the cart is gone: an order,
	// an emptied cart and the 7-day cleanup all delete it, and the message then
	// has no link rather than a dead one.
	if (run.triggerEvent === 'cart_left_behind') {
		contextData = {
			...contextData,
			cartLink: (await cartLinkForGuest(orgId, customer.id)) ?? '',
		}
	}

	// A step with a coupon fills `{{couponCode}}`: one shared code, or a
	// single-use code minted once for this run's step (a retry reuses it).
	const offerValue = (config as { discountOffer?: unknown }).discountOffer
	if (offerValue) {
		const offer = parseMarketingOffer(offerValue)
		let couponCode: string | null = null
		let couponError = 'Invalid coupon configuration'
		if (offer) {
			try {
				couponCode = await couponCodeForRecipient(db, offer, {
					sourceType: 'journey',
					sourceId: `${payload.runId}:${payload.nodeId}`,
					customerId: customer.id,
				})
			} catch (error) {
				couponError =
					error instanceof Error ? error.message : 'Coupon could not be issued'
			}
		}
		if (!couponCode) {
			await db
				.update(journeyStepExecutions)
				.set({
					status: 'failed',
					errorMessage: couponError,
					completedAt: new Date(),
				})
				.where(eq(journeyStepExecutions.id, stepExecutionId))
			return {
				success: false,
				executionId: stepExecutionId,
				status: 'failed',
				error: couponError,
				statusCode: offer ? 500 : 422,
			}
		}
		contextData = { ...contextData, couponCode }
	}

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
			// Release the lease: left `processing`, a retry would be told the
			// step is still being sent.
			await db
				.update(journeyStepExecutions)
				.set({
					status: 'failed',
					errorMessage: 'Invalid email journey configuration',
					completedAt: new Date(),
				})
				.where(eq(journeyStepExecutions.id, stepExecutionId))
			return {
				success: false,
				executionId: stepExecutionId,
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
		const bodyHtml = isDesigned
			? renderedHtml
			: renderedHtml
				? `<p>${renderedHtml}</p>`
				: `<p>${text}</p>`
		// The signed opt-out link, in the body and as List-Unsubscribe /
		// one-click headers. Reservation journeys opt out of the `reservations`
		// topic, every other journey of `marketing` (the broadcast topic).
		const optOutUrl = unsubscribeUrl(consentOrigin!, {
			orgId,
			customerId: customer.id,
			topic: isReservationJourney ? 'reservations' : BROADCAST_TOPIC,
		})
		// Links to the own site carry the campaign and step ids (#115).
		const tagged = await tagEmailLinks(
			orgId,
			{ html: bodyHtml, text: text || subject },
			{
				campaignId: payload.journeyId,
				stepId: payload.nodeId,
				campaignName: journeyName,
			},
		)
		const html = withUnsubscribeFooter(tagged.html, optOutUrl)
		const plainText = `${tagged.text}\n\nUnsubscribe: ${optOutUrl}`

		try {
			// Stable across retries of this step: a reclaimed step keeps its
			// execution id, so a resend carries the same Message-ID.
			const outboundMessageId = stepExecutionId
			const emailRes = await sendTenantEmail({
				to: customer.email,
				toName: customer.name,
				subject,
				html,
				text: plainText,
				extraHeaders: listUnsubscribeHeaders(optOutUrl),
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
				if (
					emailRes.error.cause !== undefined &&
					isAmbiguousDispatchError(emailRes.error.cause)
				) {
					return recordOutcomeUnknown(db, {
						stepExecutionId,
						channel: 'email',
						messageId: outboundMessageId,
						errorMessage,
					})
				}
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
			if (isAmbiguousDispatchError(dispatchErr)) {
				return recordOutcomeUnknown(db, {
					stepExecutionId,
					channel: 'email',
					messageId: stepExecutionId,
					errorMessage,
				})
			}
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
	} else if (stepType === 'push') {
		return executePushDispatch(db, {
			orgId,
			payload,
			customerId: customer.id,
			stepExecutionId,
			config,
			isTestRun: contextData.isTestRun === true,
			journeyId: payload.journeyId,
			runId: payload.runId,
		})
	} else {
		// SMS Dispatch
		if (!isMarketingSmsEnabled()) {
			await db
				.update(journeyStepExecutions)
				.set({
					status: 'skipped',
					errorMessage: null,
					executionDetails: JSON.stringify({
						skipped: true,
						skipReason: 'marketing_sms_disabled' satisfies JourneySkipReason,
						channel: 'sms',
					}),
					completedAt: new Date(),
				})
				.where(eq(journeyStepExecutions.id, stepExecutionId))
			return {
				success: true,
				executionId: stepExecutionId,
				status: 'skipped',
				reason: 'marketing_sms_disabled',
			}
		}
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
		const merged = interpolateMergeTags(rawMessage, customer, contextData)
		// The recipient's message row id travels in the short link, so a click
		// marks this text clicked (#159). The row is written after the send.
		const smsMessageId = randomUUID()
		// Every marketing text ends with the opt-out phrase (#75), and links to
		// the own site are short and tagged (#159, #115).
		const message = (
			await prepareMarketingSms({
				orgId,
				text: merged,
				now: Date.now(),
				links: {
					campaignId: payload.journeyId,
					stepId: payload.nodeId,
					campaignName: journeyName,
					messageId: smsMessageId,
				},
			})
		).body

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
				id: smsMessageId,
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
			// Twilio has no idempotency key for a new message, so an SMS whose
			// outcome is unknown is never sent again.
			if (isAmbiguousDispatchError(dispatchErr)) {
				return recordOutcomeUnknown(db, {
					stepExecutionId,
					channel: 'sms',
					errorMessage,
				})
			}
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

	// A run cancelled because its journey was paused stays cancelled: an
	// older workflow that kept walking the graph must not mark it completed.
	if (run.status === 'cancelled') {
		return {
			success: true,
			runId: payload.runId,
			status: 'cancelled' as const,
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

	// A workflow retry after the answer was recorded (the response was lost)
	// gets the recorded answer, not a unique-constraint error.
	const recorded = await db
		.select()
		.from(journeyStepExecutions)
		.where(
			and(
				eq(journeyStepExecutions.runId, payload.runId),
				eq(journeyStepExecutions.nodeId, payload.nodeId),
			),
		)
		.get()
	if (recorded && recorded.status === 'completed') {
		const details = parseRunContext(recorded.executionDetails)
		return {
			success: true,
			executionId: recorded.id,
			result: details.result === true,
		}
	}

	const haltReason = await haltRunIfStopped(db, run)
	if (haltReason) {
		return {
			success: true,
			halted: true,
			result: false,
			reason: haltReason,
		}
	}

	const contextData = parseRunContext(run.contextData)

	const { field, operator, value } = payload.condition

	// Resolve actual value from customer record or contextData
	let actualValue: unknown = undefined
	const customerRecord = customer as Record<string, unknown>
	if (field in customerRecord) {
		actualValue = customerRecord[field]
	} else if (field in contextData) {
		actualValue = contextData[field]
	} else if (isVirtualConditionField(field)) {
		// Computed from the guest's orders and reservations as they are now.
		actualValue = await virtualConditionValue(
			db,
			field,
			payload.customerId,
			Date.now(),
		)
	}
	// "Guest is in audience X" (#98): the value is the audience's id. An audience
	// that was deleted answers "no", so a path never opens by accident.
	const audienceAnswer =
		field === 'audience'
			? await customerInAudience(db, value || '', payload.customerId)
			: null
	if (field === 'audience') actualValue = audienceAnswer === true

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

	if (field === 'audience') {
		result =
			operator === 'not_equals'
				? audienceAnswer === false
				: audienceAnswer === true
	} else
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
			goal: journey.goal,
			programId: journey.programId,
			programVersion: journey.programVersion,
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
	options: { journeyId?: string } = {},
) {
	const db = await getTenantDb(orgId)

	// 1. Query active journeys configured for this trigger event. A journey
	// whose own settings do not match the event (a location, "only the 3rd
	// order") is left out; `journeyId` starts one journey only (a quiet-spell
	// trigger with its own number of days).
	const activeJourneys = (
		await db
			.select()
			.from(marketingJourneys)
			.where(
				and(
					eq(marketingJourneys.status, 'active'),
					eq(marketingJourneys.triggerType, triggerType as any),
					options.journeyId
						? eq(marketingJourneys.id, options.journeyId)
						: undefined,
				),
			)
			.all()
	).filter((journey) =>
		triggerConfigMatches(
			triggerType,
			parseRunContext(journey.triggerConfig),
			contextData,
		),
	)

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

		// 2. Insert run record in regional SQLite. A once-per-customer trigger
		// (verified phone, completed profile) enrolls a customer in a journey
		// once: a later sign-in or profile save must not start it again. The
		// check and the insert share a transaction so two concurrent sign-ins
		// enroll once.
		const enrolled = await retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				if (ONCE_PER_CUSTOMER_TRIGGERS.has(triggerType)) {
					const prior = await tx
						.select({ id: journeyRuns.id })
						.from(journeyRuns)
						.where(
							and(
								eq(journeyRuns.journeyId, journey.id),
								eq(journeyRuns.customerId, customerId),
								eq(journeyRuns.triggerEvent, triggerType),
							),
						)
						.get()
					if (prior) return false
				}
				// A unique index backs the check for once-per-customer triggers: a
				// conflict means the customer is already enrolled.
				const inserted = await tx
					.insert(journeyRuns)
					.values({
						id: runId,
						journeyId: journey.id,
						customerId,
						triggerEvent: triggerType,
						contextData: JSON.stringify(contextData),
						status: 'running',
						startedAt: new Date(),
					})
					.onConflictDoNothing()
					.returning({ id: journeyRuns.id })
				return inserted.length > 0
			}),
		)
		if (!enrolled) continue

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
		goal: input.goal ?? null,
		programId: input.programId ?? null,
		programVersion: input.programId ? (input.programVersion ?? 1) : null,
		createdAt: new Date(),
		updatedAt: new Date(),
	}

	try {
		await db.insert(marketingJourneys).values(newJourney)
	} catch (error) {
		// One live journey per ready-made program (#100): the unique index on
		// `program_id` refuses a second, whatever raced.
		if (input.programId && isWrappedUniqueError(error)) {
			return {
				success: false,
				error: 'program_already_active',
				statusCode: 409,
			}
		}
		throw error
	}

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
	if (input.goal !== undefined) updateValues.goal = input.goal ?? null
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
 * Error texts tenant-api writes itself. They name no person, so the runs view
 * (an Automations browser token) may show them as they are.
 */
const PUBLIC_JOURNEY_ERRORS = new Set([
	'Skipped: the customer has not subscribed to marketing texts',
	'Skipped: the customer has not confirmed marketing email',
	'Skipped: no unsubscribe link could be made (TENANT_API_URL is not set)',
	'Customer has no email address',
	'Customer has no phone number',
	'Invalid email journey configuration',
	'Invalid coupon configuration',
	'Journey no longer exists',
	JOURNEY_GOAL_REACHED_REASON,
])
const PUBLIC_JOURNEY_ERROR_PATTERNS = [
	/^Journey run is [a-z_]+$/,
	/^Journey is [a-z_]+$/,
	/^Workflow worker returned status \d{3}$/,
]

/**
 * What the runs view may show of a stored run or step error. Provider and
 * coupon errors, and the workflow's copy of a failed step's response, can
 * echo the recipient's address, so anything not written by tenant-api itself
 * is replaced by a fixed label. The full text stays in the regional row.
 */
export function publicJourneyError(
	message: string | null | undefined,
	fallback: 'Step failed' | 'Run failed',
): string | null {
	if (!message) return null
	if (PUBLIC_JOURNEY_ERRORS.has(message)) return message
	if (PUBLIC_JOURNEY_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
		return message
	}
	if (message.startsWith('Dispatch outcome unknown')) {
		return 'Dispatch outcome unknown, not resent'
	}
	if (message.startsWith('Workflow worker dispatch error')) {
		return 'Workflow worker dispatch error'
	}
	return fallback
}

/**
 * The step details the runs view may show. A condition step keeps its field,
 * operator and result but never the compared values: `actualValue` is the
 * customer's own data (only some fields are redacted when stored).
 */
const PUBLIC_STEP_DETAIL_KEYS = [
	'channel',
	'skipped',
	'skipReason',
	'messageId',
	'sid',
	'dispatched',
	'outcomeUnknown',
	'dispatchedAt',
	'deliveredAt',
	'field',
	'operator',
	'result',
	'evaluatedAt',
	'cappedAt',
] as const

function publicStepDetails(raw: unknown): Record<string, unknown> {
	let parsed: unknown = raw
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw)
		} catch {
			return {}
		}
	}
	if (!parsed || typeof parsed !== 'object') return {}
	const source = parsed as Record<string, unknown>
	const details: Record<string, unknown> = {}
	for (const key of PUBLIC_STEP_DETAIL_KEYS) {
		const value = source[key]
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean'
		) {
			details[key] = value
		}
	}
	return details
}

const PUBLIC_RUN_COLUMNS = {
	id: journeyRuns.id,
	journeyId: journeyRuns.journeyId,
	customerId: journeyRuns.customerId,
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
}

function publicRun<T extends { errorMessage: string | null }>(run: T): T {
	return {
		...run,
		errorMessage: publicJourneyError(run.errorMessage, 'Run failed'),
	}
}

/**
 * Lists execution runs for a specific journey. An Automations browser token
 * reads this, so it carries the customer id only (no name, email or phone)
 * and no provider error text (`publicJourneyError`).
 */
export async function listJourneyRuns(orgId: string, journeyId: string) {
	const db = await getTenantDb(orgId)
	const runs = await db
		.select(PUBLIC_RUN_COLUMNS)
		.from(journeyRuns)
		.where(eq(journeyRuns.journeyId, journeyId))
		.orderBy(desc(journeyRuns.startedAt))
		.limit(JOURNEY_LIST_LIMIT)
		.all()

	return { runs: runs.map(publicRun) }
}

/**
 * Gets step execution timeline for a specific journey run. Like the run list,
 * it carries the customer id only, never a contact: steps are an explicit
 * column list, their details an allowlist (no compared condition values) and
 * their errors pass `publicJourneyError`.
 */
export async function getJourneyRunTimeline(orgId: string, runId: string) {
	const db = await getTenantDb(orgId)
	const run = await db
		.select(PUBLIC_RUN_COLUMNS)
		.from(journeyRuns)
		.where(eq(journeyRuns.id, runId))
		.get()

	if (!run) {
		return {
			success: false,
			error: `Run "${runId}" not found`,
			statusCode: 404,
		}
	}

	const rows = await db
		.select({
			id: journeyStepExecutions.id,
			runId: journeyStepExecutions.runId,
			journeyId: journeyStepExecutions.journeyId,
			customerId: journeyStepExecutions.customerId,
			nodeId: journeyStepExecutions.nodeId,
			nodeType: journeyStepExecutions.nodeType,
			stepType: journeyStepExecutions.stepType,
			status: journeyStepExecutions.status,
			retryCount: journeyStepExecutions.retryCount,
			executionDetails: journeyStepExecutions.executionDetails,
			errorMessage: journeyStepExecutions.errorMessage,
			executedAt: journeyStepExecutions.executedAt,
			completedAt: journeyStepExecutions.completedAt,
		})
		.from(journeyStepExecutions)
		.where(eq(journeyStepExecutions.runId, runId))
		.orderBy(journeyStepExecutions.executedAt)
		.all()

	const steps = rows.map((step) => ({
		...step,
		attempt: step.retryCount + 1,
		executionDetails: publicStepDetails(step.executionDetails),
		errorMessage: publicJourneyError(step.errorMessage, 'Step failed'),
	}))

	return {
		success: true,
		run: publicRun(run),
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
