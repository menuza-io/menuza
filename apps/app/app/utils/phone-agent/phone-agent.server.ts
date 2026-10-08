import { createId } from '@paralleldrive/cuid2'
import { AuditAction, auditService } from '@repo/audit'
import {
	and,
	asc,
	db,
	desc,
	eq,
	isNull,
	lt,
	lte,
	ne,
	or,
	PhoneAgent,
	PhoneAgentFlowVersion,
	PhoneAgentNumber,
	PhoneAgentTrainingRule,
	PlatformPhoneNumber,
	sql,
} from '@repo/database'
import {
	defaultFlowFor,
	defaultSettingsFor,
	describeLineTransferLoop,
	E164Schema,
	findFlowTransferLoops,
	findLineTransferLoop,
	findSettingsTransferLoop,
	type FlowGraph,
	FlowGraphSchema,
	isUsOrCanadaNumber,
	PHONE_NUMBER_MODES,
	type PhoneAgentSettings,
	PhoneAgentSettingsSchema,
	type TrainingRule,
	type TrainingRuleInput,
	validateFlowGraph,
} from '@repo/phone-agent'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import {
	checkRateLimit,
	type RateLimitConfig,
} from '#app/utils/rate-limit.server.ts'
import {
	PhoneLineVerificationError,
	sendPhoneLineVerification,
} from '#app/utils/tenant-api.server.ts'
import {
	checkLineVerificationCode,
	generateLineVerificationCode,
	hashLineVerificationCode,
	LINE_VERIFICATION_CODE_TTL_MS,
	LINE_VERIFICATION_MAX_ATTEMPTS,
} from './line-verification.server.ts'
import { settingsError } from './settings-errors.ts'
import { phoneAgentServerVertical } from './vertical.server.ts'
import { phoneAgentVertical } from './vertical.ts'

const DRAFT_VERSION = 0

const DEFAULT_SETTINGS = defaultSettingsFor(phoneAgentVertical)

const SCOPE_LABEL = (phoneAgentVertical.scope?.label ?? 'scope').toLowerCase()

/**
 * Agent numbers are platform-owned, so businesses pick one assigned to them
 * rather than typing a number. Forwarding requires the business's own line.
 */
export const PhoneNumberInputSchema = z
	.object({
		scopeId: z.string().trim().min(1).max(64).optional().nullable(),
		platformNumberId: z.string().trim().min(1).max(64),
		mode: z.enum(PHONE_NUMBER_MODES),
		forwardedFrom: E164Schema.optional().nullable(),
	})
	.superRefine((value, context) => {
		if (value.mode === 'forwarding' && !value.forwardedFrom) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['forwardedFrom'],
				message: 'Enter the business line that forwards calls to the agent.',
			})
		}
	})
export type PhoneNumberInput = z.infer<typeof PhoneNumberInputSchema>

export function parsePhoneAgentSettings(
	raw: string | null | undefined,
): PhoneAgentSettings {
	if (!raw) return DEFAULT_SETTINGS
	try {
		const parsed = PhoneAgentSettingsSchema.safeParse({
			...DEFAULT_SETTINGS,
			...(JSON.parse(raw) as object),
		})
		return parsed.success ? parsed.data : DEFAULT_SETTINGS
	} catch {
		return DEFAULT_SETTINGS
	}
}

function parseGraph(raw: string): FlowGraph {
	try {
		const parsed = FlowGraphSchema.safeParse(JSON.parse(raw))
		if (parsed.success) return parsed.data
	} catch {}
	return defaultFlowFor(phoneAgentVertical)
}

export async function getPhoneAgent(organizationId: string) {
	const [existing] = await db
		.select()
		.from(PhoneAgent)
		.where(eq(PhoneAgent.organizationId, organizationId))
		.limit(1)
	if (existing) {
		return {
			...existing,
			settings: parsePhoneAgentSettings(existing.settings),
			rawSettings: existing.settings,
		}
	}
	const [created] = await db
		.insert(PhoneAgent)
		.values({
			organizationId,
			settings: JSON.stringify(DEFAULT_SETTINGS),
		})
		.onConflictDoNothing()
		.returning()
	if (created) {
		return {
			...created,
			settings: DEFAULT_SETTINGS,
			rawSettings: created.settings,
		}
	}
	const [raced] = await db
		.select()
		.from(PhoneAgent)
		.where(eq(PhoneAgent.organizationId, organizationId))
		.limit(1)
	return {
		...raced!,
		settings: parsePhoneAgentSettings(raced!.settings),
		rawSettings: raced!.settings,
	}
}

export type SettingsSaveResult =
	| { ok: true; settings: PhoneAgentSettings }
	| { ok: false; error: string; conflict?: boolean }

/**
 * Errors are codes from `settings-errors.ts`. With `expectedRawSettings`, the
 * write only happens if the stored JSON still equals it; otherwise the result
 * is `{ ok: false, conflict: true }` and nothing is written.
 */
export async function updatePhoneAgentSettings(
	organizationId: string,
	settings: PhoneAgentSettings,
	options: { expectedRawSettings?: string } = {},
): Promise<SettingsSaveResult> {
	await getPhoneAgent(organizationId)
	if (settings.autoEscalate && !settings.escalationPhone) {
		return { ok: false, error: settingsError('escalation_phone_required') }
	}
	const numbers = await listPhoneNumbers(organizationId)
	if (findSettingsTransferLoop(settings, numbers)) {
		return { ok: false, error: settingsError('staff_phone_loop') }
	}
	const updated = await db
		.update(PhoneAgent)
		.set({ settings: JSON.stringify(settings) })
		.where(
			options.expectedRawSettings === undefined
				? eq(PhoneAgent.organizationId, organizationId)
				: and(
						eq(PhoneAgent.organizationId, organizationId),
						eq(PhoneAgent.settings, options.expectedRawSettings),
					),
		)
		.returning({ organizationId: PhoneAgent.organizationId })
	if (!updated.length) {
		return { ok: false, error: settingsError('conflict'), conflict: true }
	}
	return { ok: true, settings }
}

export async function getDraftFlow(organizationId: string) {
	const [draft] = await db
		.select()
		.from(PhoneAgentFlowVersion)
		.where(
			and(
				eq(PhoneAgentFlowVersion.organizationId, organizationId),
				eq(PhoneAgentFlowVersion.version, DRAFT_VERSION),
			),
		)
		.limit(1)
	if (draft) return { ...draft, graph: parseGraph(draft.graph) }

	const graph = defaultFlowFor(phoneAgentVertical)
	await db
		.insert(PhoneAgentFlowVersion)
		.values({
			organizationId,
			version: DRAFT_VERSION,
			status: 'draft',
			graph: JSON.stringify(graph),
		})
		.onConflictDoNothing()
	const [created] = await db
		.select()
		.from(PhoneAgentFlowVersion)
		.where(
			and(
				eq(PhoneAgentFlowVersion.organizationId, organizationId),
				eq(PhoneAgentFlowVersion.version, DRAFT_VERSION),
			),
		)
		.limit(1)
	return { ...created!, graph: parseGraph(created!.graph) }
}

export async function saveDraftFlow(
	organizationId: string,
	graph: FlowGraph,
	userId: string,
) {
	const draft = await getDraftFlow(organizationId)
	await db
		.update(PhoneAgentFlowVersion)
		.set({ graph: JSON.stringify(graph), createdById: userId })
		.where(eq(PhoneAgentFlowVersion.id, draft.id))
}

export type PublishResult =
	| { ok: true; id: string; version: number }
	| { ok: false; issues: ReturnType<typeof validateFlowGraph> }

/**
 * Archives the current version, inserts the next one, and points the agent
 * at it in one batch (a single transaction on D1 and libsql). The version is
 * computed inside the INSERT, and the (organizationId, version) unique index
 * makes a racing publish fail as a whole instead of half-applying.
 */
async function insertPublishedVersion(
	organizationId: string,
	graph: FlowGraph,
	userId: string,
) {
	const id = createId()
	const [, inserted] = await db.batch([
		db
			.update(PhoneAgentFlowVersion)
			.set({ status: 'archived' })
			.where(
				and(
					eq(PhoneAgentFlowVersion.organizationId, organizationId),
					eq(PhoneAgentFlowVersion.status, 'published'),
				),
			),
		db
			.insert(PhoneAgentFlowVersion)
			.values({
				id,
				organizationId,
				version: sql<number>`(SELECT COALESCE(MAX(${PhoneAgentFlowVersion.version}), 0) + 1 FROM ${PhoneAgentFlowVersion} WHERE ${PhoneAgentFlowVersion.organizationId} = ${organizationId})`,
				status: 'published',
				graph: JSON.stringify(graph),
				createdById: userId,
				publishedAt: new Date(),
			})
			.returning({
				id: PhoneAgentFlowVersion.id,
				version: PhoneAgentFlowVersion.version,
			}),
		db
			.update(PhoneAgent)
			.set({ publishedFlowVersionId: id })
			.where(eq(PhoneAgent.organizationId, organizationId)),
	])
	const row = inserted[0]
	if (!row) throw new Error('Publishing the flow did not insert a version.')
	return row
}

function isUniqueConstraintError(error: unknown) {
	const seen = new Set<unknown>()
	let current: unknown = error
	while (current && typeof current === 'object' && !seen.has(current)) {
		seen.add(current)
		if (/UNIQUE constraint failed/i.test(String((current as Error).message)))
			return true
		current = (current as { cause?: unknown }).cause
	}
	return false
}

export async function publishFlow(
	organizationId: string,
	graph: FlowGraph,
	userId: string,
): Promise<PublishResult> {
	const issues = validateFlowGraph(graph)
	if (issues.length) return { ok: false, issues }
	const loops = findFlowTransferLoops(
		graph,
		await listPhoneNumbers(organizationId),
	)
	if (loops.length) return { ok: false, issues: loops }
	await saveDraftFlow(organizationId, graph, userId)
	await getPhoneAgent(organizationId)

	try {
		return {
			ok: true,
			...(await insertPublishedVersion(organizationId, graph, userId)),
		}
	} catch (error) {
		if (!isUniqueConstraintError(error)) throw error
		// Another publish took this version number; the next one is free.
		return {
			ok: true,
			...(await insertPublishedVersion(organizationId, graph, userId)),
		}
	}
}

export async function getPublishedFlow(organizationId: string) {
	const agent = await getPhoneAgent(organizationId)
	if (!agent.publishedFlowVersionId) return null
	const [row] = await db
		.select()
		.from(PhoneAgentFlowVersion)
		.where(
			and(
				eq(PhoneAgentFlowVersion.id, agent.publishedFlowVersionId),
				eq(PhoneAgentFlowVersion.organizationId, organizationId),
			),
		)
		.limit(1)
	return row ? { ...row, graph: parseGraph(row.graph) } : null
}

export async function listPublishedFlowVersions(organizationId: string) {
	return db
		.select({
			id: PhoneAgentFlowVersion.id,
			version: PhoneAgentFlowVersion.version,
			status: PhoneAgentFlowVersion.status,
			publishedAt: PhoneAgentFlowVersion.publishedAt,
		})
		.from(PhoneAgentFlowVersion)
		.where(
			and(
				eq(PhoneAgentFlowVersion.organizationId, organizationId),
				ne(PhoneAgentFlowVersion.version, DRAFT_VERSION),
			),
		)
		.orderBy(desc(PhoneAgentFlowVersion.version))
		.limit(10)
}

export async function listTrainingRules(
	organizationId: string,
): Promise<Array<TrainingRule & { updatedAt: Date }>> {
	const rows = await db
		.select()
		.from(PhoneAgentTrainingRule)
		.where(eq(PhoneAgentTrainingRule.organizationId, organizationId))
		.orderBy(
			asc(PhoneAgentTrainingRule.category),
			asc(PhoneAgentTrainingRule.sortOrder),
			asc(PhoneAgentTrainingRule.createdAt),
		)
	return rows.map((row) => ({
		id: row.id,
		category: row.category as TrainingRule['category'],
		title: row.title,
		description: row.description,
		priority: row.priority as TrainingRule['priority'],
		isActive: row.isActive,
		scopeId: row.scopeId,
		sortOrder: row.sortOrder,
		updatedAt: row.updatedAt,
	}))
}

export async function saveTrainingRule(
	organizationId: string,
	input: TrainingRuleInput,
	ruleId?: string,
) {
	const scopeId = phoneAgentVertical.scope ? (input.scopeId ?? null) : null
	if (
		scopeId &&
		!(await phoneAgentServerVertical.findScope(organizationId, scopeId))
	) {
		return {
			ok: false as const,
			error: `Choose a ${SCOPE_LABEL} from this business.`,
		}
	}
	const values = {
		category: input.category,
		title: input.title,
		description: input.description,
		priority: input.priority,
		isActive: input.isActive,
		scopeId,
	}
	if (ruleId) {
		const updated = await db
			.update(PhoneAgentTrainingRule)
			.set(values)
			.where(
				and(
					eq(PhoneAgentTrainingRule.id, ruleId),
					eq(PhoneAgentTrainingRule.organizationId, organizationId),
				),
			)
			.returning({ id: PhoneAgentTrainingRule.id })
		return updated.length
			? { ok: true as const, id: ruleId }
			: { ok: false as const, error: 'Rule not found.' }
	}
	const [inserted] = await db
		.insert(PhoneAgentTrainingRule)
		.values({ organizationId, ...values })
		.returning({ id: PhoneAgentTrainingRule.id })
	return { ok: true as const, id: inserted?.id ?? '' }
}

export async function setTrainingRuleActive(
	organizationId: string,
	ruleId: string,
	isActive: boolean,
) {
	await db
		.update(PhoneAgentTrainingRule)
		.set({ isActive })
		.where(
			and(
				eq(PhoneAgentTrainingRule.id, ruleId),
				eq(PhoneAgentTrainingRule.organizationId, organizationId),
			),
		)
}

export async function deleteTrainingRule(
	organizationId: string,
	ruleId: string,
) {
	await db
		.delete(PhoneAgentTrainingRule)
		.where(
			and(
				eq(PhoneAgentTrainingRule.id, ruleId),
				eq(PhoneAgentTrainingRule.organizationId, organizationId),
			),
		)
}

export async function listPhoneNumbers(organizationId: string) {
	return db
		.select({
			id: PhoneAgentNumber.id,
			scopeId: PhoneAgentNumber.scopeId,
			e164: PhoneAgentNumber.e164,
			mode: PhoneAgentNumber.mode,
			forwardedFrom: PhoneAgentNumber.forwardedFrom,
			isActive: PhoneAgentNumber.isActive,
			verifiedAt: PhoneAgentNumber.verifiedAt,
			verificationSentAt: PhoneAgentNumber.verificationSentAt,
			verificationExpiresAt: PhoneAgentNumber.verificationExpiresAt,
		})
		.from(PhoneAgentNumber)
		.where(eq(PhoneAgentNumber.organizationId, organizationId))
		.orderBy(asc(PhoneAgentNumber.createdAt))
}

/** Platform numbers assigned to this organization that aren't in use yet. */
export async function listAssignablePlatformNumbers(organizationId: string) {
	return db
		.select({
			id: PlatformPhoneNumber.id,
			e164: PlatformPhoneNumber.e164,
			label: PlatformPhoneNumber.label,
		})
		.from(PlatformPhoneNumber)
		.leftJoin(
			PhoneAgentNumber,
			eq(PhoneAgentNumber.platformNumberId, PlatformPhoneNumber.id),
		)
		.where(
			and(
				eq(PlatformPhoneNumber.assignedOrganizationId, organizationId),
				isNull(PlatformPhoneNumber.retiredAt),
				isNull(PhoneAgentNumber.id),
			),
		)
		.orderBy(asc(PlatformPhoneNumber.e164))
}

type NumberResult = { ok: true } | { ok: false; error: string }

/** Who changed a number, for the audit log. */
export type NumberActor = { userId: string; request?: Request }

const US_OR_CANADA_LINE_ERROR =
	'Enter a US or Canadian number for the business line. The AI phone agent only works with lines in the US and Canada.'

const ORG_VERIFICATION_LIMIT_ERROR =
	'Your business has sent the most verification codes allowed today. Try again tomorrow, or contact support if you need help.'

const NOT_ASSIGNED_ERROR =
	'Choose one of the numbers assigned to your business.'

// Each send bills an SMS or a call, and removing and re-adding a line resets
// its per-line cooldown, so the whole organization gets a daily budget too.
const PHONE_LINE_VERIFICATION_ORG_DAILY_LIMIT: RateLimitConfig = {
	scope: 'phone-agent-line-verification-org-daily',
	maxRequests: process.env.NODE_ENV === 'development' ? 100 : 10,
	windowMs: 24 * 60 * 60 * 1000,
}

/** Audit entries keep only the last digits so they don't hold phone numbers. */
function lastFour(phone: string | null | undefined) {
	return phone ? phone.replace(/\D/gu, '').slice(-4) : null
}

async function recordNumberEvent(input: {
	organizationId: string
	actor: NumberActor | undefined
	action: AuditAction
	details: string
	numberId: string
	metadata?: Record<string, unknown>
}) {
	await auditService.log({
		action: input.action,
		userId: input.actor?.userId ?? null,
		organizationId: input.organizationId,
		details: input.details,
		metadata: { numberId: input.numberId, ...input.metadata },
		request: input.actor?.request,
		resourceType: 'phone_agent_number',
		resourceId: input.numberId,
	})
}

/**
 * Error message when connecting `lines` would let a transfer ring the agent:
 * the staff phone, a transfer contact, or a published phone menu step.
 */
async function findLoopForLines(
	organizationId: string,
	lines: Array<{ e164: string; forwardedFrom?: string | null }>,
) {
	const [{ settings }, published] = await Promise.all([
		getPhoneAgent(organizationId),
		getPublishedFlow(organizationId),
	])
	const loop = findLineTransferLoop(
		{ settings, graph: published?.graph },
		lines,
	)
	return loop ? describeLineTransferLoop(loop) : null
}

/** The scope a new number answers for; null for verticals without scopes. */
async function resolveNumberScope(
	organizationId: string,
	scopeId: string | null | undefined,
): Promise<{ ok: true; scopeId: string | null } | { ok: false }> {
	if (!phoneAgentVertical.scope) return { ok: true, scopeId: null }
	if (!scopeId) return { ok: false }
	const scope = await phoneAgentServerVertical.findScope(
		organizationId,
		scopeId,
	)
	return scope?.isActive ? { ok: true, scopeId } : { ok: false }
}

function assignedPlatformNumber(
	organizationId: string,
	platformNumberId: string,
) {
	return and(
		eq(PlatformPhoneNumber.id, platformNumberId),
		eq(PlatformPhoneNumber.assignedOrganizationId, organizationId),
		isNull(PlatformPhoneNumber.retiredAt),
	)
}

export async function addPhoneNumber(
	organizationId: string,
	input: PhoneNumberInput,
	actor?: NumberActor,
): Promise<NumberResult> {
	const scope = await resolveNumberScope(organizationId, input.scopeId)
	if (!scope.ok) {
		return {
			ok: false,
			error: `Choose an active ${SCOPE_LABEL} from this business.`,
		}
	}
	const [platformNumber] = await db
		.select({
			id: PlatformPhoneNumber.id,
			e164: PlatformPhoneNumber.e164,
		})
		.from(PlatformPhoneNumber)
		.where(assignedPlatformNumber(organizationId, input.platformNumberId))
		.limit(1)
	if (!platformNumber) {
		return { ok: false, error: NOT_ASSIGNED_ERROR }
	}
	const forwardedFrom =
		input.mode === 'forwarding' ? (input.forwardedFrom ?? null) : null
	if (input.mode === 'forwarding' && !forwardedFrom) {
		return {
			ok: false,
			error: 'Enter the business line that forwards calls to the agent.',
		}
	}
	if (forwardedFrom && !isUsOrCanadaNumber(forwardedFrom)) {
		return { ok: false, error: US_OR_CANADA_LINE_ERROR }
	}
	if (forwardedFrom) {
		const [platformLine] = await db
			.select({ id: PlatformPhoneNumber.id })
			.from(PlatformPhoneNumber)
			.where(eq(PlatformPhoneNumber.e164, forwardedFrom))
			.limit(1)
		if (platformLine) {
			return {
				ok: false,
				error:
					'Enter the line customers dial today, not one of the agent numbers.',
			}
		}
		const [claimed] = await db
			.select({ id: PhoneAgentNumber.id })
			.from(PhoneAgentNumber)
			.where(
				and(
					eq(PhoneAgentNumber.forwardedFrom, forwardedFrom),
					eq(PhoneAgentNumber.isActive, true),
				),
			)
			.limit(1)
		if (claimed) {
			return {
				ok: false,
				error: 'That business line is already connected to an agent.',
			}
		}
	}
	const loop = await findLoopForLines(organizationId, [
		{ e164: platformNumber.e164, forwardedFrom },
	])
	if (loop) return { ok: false, error: loop }

	const now = Date.now()
	// One statement re-checks the assignment, so a number Admin unassigns or
	// retires after the check above is never connected.
	const [inserted] = await db
		.insert(PhoneAgentNumber)
		.select(
			db
				.select({
					id: sql`${createId()}`.as('id'),
					organizationId: sql`${organizationId}`.as('organizationId'),
					scopeId: sql`${scope.scopeId}`.as('scopeId'),
					platformNumberId: PlatformPhoneNumber.id,
					e164: PlatformPhoneNumber.e164,
					mode: sql`${input.mode}`.as('mode'),
					forwardedFrom: sql`${forwardedFrom}`.as('forwardedFrom'),
					// Dedicated numbers belong to the platform, so they answer right
					// away. Forwarded lines wait until the owner verifies the line.
					isActive: sql`${input.mode === 'dedicated' ? 1 : 0}`.as('isActive'),
					verifiedAt: sql`null`.as('verifiedAt'),
					verificationCodeHash: sql`null`.as('verificationCodeHash'),
					verificationExpiresAt: sql`null`.as('verificationExpiresAt'),
					verificationAttempts: sql`0`.as('verificationAttempts'),
					verificationSentAt: sql`null`.as('verificationSentAt'),
					createdAt: sql`${now}`.as('createdAt'),
					updatedAt: sql`${now}`.as('updatedAt'),
				})
				.from(PlatformPhoneNumber)
				.where(assignedPlatformNumber(organizationId, platformNumber.id)),
		)
		.onConflictDoNothing()
		.returning({ id: PhoneAgentNumber.id })
	if (!inserted) {
		const [stillAssigned] = await db
			.select({ id: PlatformPhoneNumber.id })
			.from(PlatformPhoneNumber)
			.where(assignedPlatformNumber(organizationId, platformNumber.id))
			.limit(1)
		return {
			ok: false,
			error: stillAssigned
				? 'This number is already connected.'
				: NOT_ASSIGNED_ERROR,
		}
	}
	await recordNumberEvent({
		organizationId,
		actor,
		action: AuditAction.PHONE_AGENT_NUMBER_ADDED,
		details: `Phone agent number ending ${lastFour(platformNumber.e164)} connected (${input.mode})`,
		numberId: inserted.id,
		metadata: {
			platformNumberId: platformNumber.id,
			scopeId: scope.scopeId,
			mode: input.mode,
			numberLast4: lastFour(platformNumber.e164),
			forwardedFromLast4: lastFour(forwardedFrom),
		},
	})
	return { ok: true }
}

async function getForwardedLineForVerification(
	organizationId: string,
	numberId: string,
) {
	const [row] = await db
		.select({
			id: PhoneAgentNumber.id,
			e164: PhoneAgentNumber.e164,
			mode: PhoneAgentNumber.mode,
			forwardedFrom: PhoneAgentNumber.forwardedFrom,
			verifiedAt: PhoneAgentNumber.verifiedAt,
			verificationCodeHash: PhoneAgentNumber.verificationCodeHash,
			verificationExpiresAt: PhoneAgentNumber.verificationExpiresAt,
			verificationAttempts: PhoneAgentNumber.verificationAttempts,
			verificationSentAt: PhoneAgentNumber.verificationSentAt,
		})
		.from(PhoneAgentNumber)
		.where(
			and(
				eq(PhoneAgentNumber.id, numberId),
				eq(PhoneAgentNumber.organizationId, organizationId),
			),
		)
		.limit(1)
	return row ?? null
}

function verificationSecret() {
	const secret = ENV.SESSION_SECRET
	if (!secret) throw new Error('SESSION_SECRET is required.')
	return secret
}

const LINE_VERIFICATION_RESEND_COOLDOWN_MS = 30 * 1000

/**
 * Takes the line's send slot in a single conditional write so that parallel
 * requests can't each pass the cooldown check and each text or call the line.
 */
async function claimLineVerificationSendSlot(numberId: string, now: Date) {
	const [claimed] = await db
		.update(PhoneAgentNumber)
		.set({ verificationSentAt: now })
		.where(
			and(
				eq(PhoneAgentNumber.id, numberId),
				isNull(PhoneAgentNumber.verifiedAt),
				or(
					isNull(PhoneAgentNumber.verificationSentAt),
					lte(
						PhoneAgentNumber.verificationSentAt,
						new Date(now.getTime() - LINE_VERIFICATION_RESEND_COOLDOWN_MS),
					),
				),
			),
		)
		.returning({ id: PhoneAgentNumber.id })
	return claimed ?? null
}

/** Gives the slot back when nothing was sent, keeping the earlier send time. */
async function releaseLineVerificationSendSlot(
	numberId: string,
	claimedAt: Date,
	previousSentAt: Date | null,
) {
	await db
		.update(PhoneAgentNumber)
		.set({ verificationSentAt: previousSentAt })
		.where(
			and(
				eq(PhoneAgentNumber.id, numberId),
				eq(PhoneAgentNumber.verificationSentAt, claimedAt),
			),
		)
}

export async function sendLineVerificationCode(
	organizationId: string,
	numberId: string,
	method: 'sms' | 'call',
	actor?: NumberActor,
): Promise<NumberResult> {
	const row = await getForwardedLineForVerification(organizationId, numberId)
	if (!row) return { ok: false, error: 'Number not found.' }
	if (row.mode !== 'forwarding' || !row.forwardedFrom) {
		return { ok: false, error: 'Only forwarded lines need verification.' }
	}
	if (row.verifiedAt) {
		return { ok: false, error: 'This line is already verified.' }
	}
	// Texts and calls to other countries are billed at international rates
	// and are the usual target of toll fraud.
	if (!isUsOrCanadaNumber(row.forwardedFrom)) {
		return { ok: false, error: US_OR_CANADA_LINE_ERROR }
	}
	const loop = await findLoopForLines(organizationId, [row])
	if (loop) return { ok: false, error: loop }

	const now = new Date()
	const slot = await claimLineVerificationSendSlot(row.id, now)
	if (!slot) {
		return {
			ok: false,
			error: 'A code was just sent. Wait 30 seconds before sending another.',
		}
	}
	const orgBudget = await checkRateLimit(
		{ type: 'org', value: organizationId },
		PHONE_LINE_VERIFICATION_ORG_DAILY_LIMIT,
	)
	if (!orgBudget.allowed) {
		await releaseLineVerificationSendSlot(row.id, now, row.verificationSentAt)
		return { ok: false, error: ORG_VERIFICATION_LIMIT_ERROR }
	}

	const code = generateLineVerificationCode()
	const [stored] = await db
		.update(PhoneAgentNumber)
		.set({
			verificationCodeHash: hashLineVerificationCode(
				verificationSecret(),
				row.id,
				code,
			),
			verificationExpiresAt: new Date(
				now.getTime() + LINE_VERIFICATION_CODE_TTL_MS,
			),
			verificationAttempts: 0,
		})
		.where(
			and(
				eq(PhoneAgentNumber.id, row.id),
				eq(PhoneAgentNumber.verificationSentAt, now),
			),
		)
		.returning({ id: PhoneAgentNumber.id })
	if (!stored) return { ok: false, error: 'Number not found.' }
	try {
		await sendPhoneLineVerification({
			orgId: organizationId,
			phone: row.forwardedFrom,
			code,
			method,
		})
	} catch (error) {
		console.error('Phone line verification send failed', error)
		await db
			.update(PhoneAgentNumber)
			.set({
				verificationCodeHash: null,
				verificationExpiresAt: null,
				verificationSentAt: null,
			})
			.where(
				and(
					eq(PhoneAgentNumber.id, row.id),
					eq(PhoneAgentNumber.verificationSentAt, now),
				),
			)
		const refused =
			error instanceof PhoneLineVerificationError ? error.code : null
		if (refused === 'daily_limit_exceeded') {
			return { ok: false, error: ORG_VERIFICATION_LIMIT_ERROR }
		}
		if (refused === 'not_allowed_number') {
			return { ok: false, error: US_OR_CANADA_LINE_ERROR }
		}
		return {
			ok: false,
			error:
				method === 'sms'
					? "We couldn't text that line. If it can't receive texts, choose a phone call instead."
					: "We couldn't call that line. Try again in a few minutes.",
		}
	}
	await recordNumberEvent({
		organizationId,
		actor,
		action: AuditAction.PHONE_AGENT_LINE_VERIFICATION_SENT,
		details: `Verification ${method === 'sms' ? 'text' : 'call'} sent to the line ending ${lastFour(row.forwardedFrom)}`,
		numberId: row.id,
		metadata: { method, forwardedFromLast4: lastFour(row.forwardedFrom) },
	})
	return { ok: true }
}

export async function verifyLineVerificationCode(
	organizationId: string,
	numberId: string,
	code: string,
	actor?: NumberActor,
): Promise<NumberResult> {
	const row = await getForwardedLineForVerification(organizationId, numberId)
	if (!row) return { ok: false, error: 'Number not found.' }
	if (row.verifiedAt) return { ok: true }
	if (!row.verificationCodeHash) {
		return { ok: false, error: 'Send a code to the business line first.' }
	}
	// Spend the attempt before comparing so parallel guesses can't share one.
	const [reserved] = await db
		.update(PhoneAgentNumber)
		.set({
			verificationAttempts: sql`${PhoneAgentNumber.verificationAttempts} + 1`,
		})
		.where(
			and(
				eq(PhoneAgentNumber.id, row.id),
				lt(
					PhoneAgentNumber.verificationAttempts,
					LINE_VERIFICATION_MAX_ATTEMPTS,
				),
			),
		)
		.returning({
			verificationAttempts: PhoneAgentNumber.verificationAttempts,
			verificationCodeHash: PhoneAgentNumber.verificationCodeHash,
			verificationExpiresAt: PhoneAgentNumber.verificationExpiresAt,
		})
	const check = checkLineVerificationCode(
		reserved
			? {
					...reserved,
					verificationAttempts: reserved.verificationAttempts - 1,
				}
			: { ...row, verificationAttempts: LINE_VERIFICATION_MAX_ATTEMPTS },
		{ secret: verificationSecret(), numberId: row.id, code, now: new Date() },
	)
	if (!check.ok) {
		switch (check.reason) {
			case 'no_code':
				return { ok: false, error: 'Send a code to the business line first.' }
			case 'expired':
				return { ok: false, error: 'That code expired. Send a new one.' }
			case 'too_many_attempts':
				return {
					ok: false,
					error: 'Too many wrong codes. Send a new code to try again.',
				}
			case 'mismatch':
				return {
					ok: false,
					error:
						check.attemptsLeft > 0
							? `That code isn't right. ${check.attemptsLeft} ${check.attemptsLeft === 1 ? 'try' : 'tries'} left.`
							: 'Too many wrong codes. Send a new code to try again.',
				}
		}
	}

	const loop = await findLoopForLines(organizationId, [row])
	if (loop) return { ok: false, error: loop }
	const [claimed] = await db
		.select({ id: PhoneAgentNumber.id })
		.from(PhoneAgentNumber)
		.where(
			and(
				eq(PhoneAgentNumber.forwardedFrom, row.forwardedFrom!),
				eq(PhoneAgentNumber.isActive, true),
				ne(PhoneAgentNumber.id, row.id),
			),
		)
		.limit(1)
	if (claimed) {
		return {
			ok: false,
			error: 'That business line is already connected to an agent.',
		}
	}
	const [activated] = await db
		.update(PhoneAgentNumber)
		.set({
			isActive: true,
			verifiedAt: new Date(),
			verificationCodeHash: null,
			verificationExpiresAt: null,
			verificationAttempts: 0,
		})
		.where(
			and(
				eq(PhoneAgentNumber.id, row.id),
				// A code is single-use: a resend in between invalidates this one.
				eq(
					PhoneAgentNumber.verificationCodeHash,
					reserved!.verificationCodeHash!,
				),
			),
		)
		.returning({ id: PhoneAgentNumber.id })
	if (!activated) {
		return { ok: false, error: 'That code is no longer valid. Send a new one.' }
	}
	await recordNumberEvent({
		organizationId,
		actor,
		action: AuditAction.PHONE_AGENT_LINE_VERIFIED,
		details: `Business line ending ${lastFour(row.forwardedFrom)} verified and connected`,
		numberId: row.id,
		metadata: {
			numberLast4: lastFour(row.e164),
			forwardedFromLast4: lastFour(row.forwardedFrom),
		},
	})
	return { ok: true }
}

export async function removePhoneNumber(
	organizationId: string,
	numberId: string,
	actor?: NumberActor,
) {
	const [removed] = await db
		.delete(PhoneAgentNumber)
		.where(
			and(
				eq(PhoneAgentNumber.id, numberId),
				eq(PhoneAgentNumber.organizationId, organizationId),
			),
		)
		.returning({
			id: PhoneAgentNumber.id,
			e164: PhoneAgentNumber.e164,
			mode: PhoneAgentNumber.mode,
			platformNumberId: PhoneAgentNumber.platformNumberId,
		})
	if (!removed) return
	await recordNumberEvent({
		organizationId,
		actor,
		action: AuditAction.PHONE_AGENT_NUMBER_REMOVED,
		details: `Phone agent number ending ${lastFour(removed.e164)} disconnected`,
		numberId: removed.id,
		metadata: {
			platformNumberId: removed.platformNumberId,
			mode: removed.mode,
			numberLast4: lastFour(removed.e164),
		},
	})
}

/**
 * Disconnects the numbers and deletes the training rules of a scope that no
 * longer exists. Scopes aren't foreign keys, so their owner calls this.
 */
export async function deleteScopeData(
	organizationId: string,
	scopeId: string,
	actor?: NumberActor,
) {
	const numbers = await db
		.select({ id: PhoneAgentNumber.id })
		.from(PhoneAgentNumber)
		.where(
			and(
				eq(PhoneAgentNumber.organizationId, organizationId),
				eq(PhoneAgentNumber.scopeId, scopeId),
			),
		)
	for (const number of numbers) {
		await removePhoneNumber(organizationId, number.id, actor)
	}
	await db
		.delete(PhoneAgentTrainingRule)
		.where(
			and(
				eq(PhoneAgentTrainingRule.organizationId, organizationId),
				eq(PhoneAgentTrainingRule.scopeId, scopeId),
			),
		)
}
