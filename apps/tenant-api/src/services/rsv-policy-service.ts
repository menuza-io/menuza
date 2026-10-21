import { randomUUID } from 'node:crypto'
import {
	localizedTextSchema,
	type ReservationsContext,
} from '@repo/reservations'
import {
	RSV_POLICY_REFUND_RULE_VALUES,
	rsvLocationSettings,
	rsvPolicies,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { HttpError } from '../lib/http.ts'
import { assertLocalizedMap, localeOrgOf } from '../lib/reservations-i18n.ts'
import { withSetupWrite } from '../lib/reservations-write.ts'
import { writeSetupAuditLog } from './rsv-setup-service.ts'

/**
 * Payment policy CRUD. Policies are regional configuration (no PII). Money
 * kinds (`card_guarantee`, `deposit`, `prepay`) need the `payments` feature
 * and a processor that supports them; `none` stays savable whatever the flags
 * say. The currency always comes from the location, never from the client.
 * `terms_version` bumps whenever anything the guest consents to changes (the
 * terms text, the amounts, the windows or the refund rule).
 */

export const POLICY_SAVABLE_KINDS = [
	'none',
	'card_guarantee',
	'deposit',
	'prepay',
] as const

const termsSchema = localizedTextSchema(4000)

const minor = z.number().int().min(0).max(10_000_000)

export const policyInputSchema = z
	.strictObject({
		name: z.string().trim().min(1).max(80),
		kind: z.enum(POLICY_SAVABLE_KINDS),
		amountMinor: minor.default(0),
		perCover: z.boolean().default(false),
		freeCancelUntilMin: z.number().int().min(0).max(43_200).default(0),
		lateCancelFeeMinor: minor.default(0),
		noShowFeeMinor: minor.default(0),
		feePerCover: z.boolean().default(false),
		feeCapMinor: minor.nullish(),
		refundRule: z
			.enum(RSV_POLICY_REFUND_RULE_VALUES)
			.default('full_before_window'),
		partialRefundBp: z.number().int().min(1).max(10_000).nullish(),
		appliesPartyMin: z.number().int().min(1).max(99).nullish(),
		termsI18n: termsSchema.nullish(),
	})
	.superRefine((value, ctx) => {
		if (
			(value.kind === 'deposit' || value.kind === 'prepay') &&
			value.amountMinor <= 0
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['amountMinor'],
				message: 'required',
			})
		}
		if (value.refundRule === 'partial' && !value.partialRefundBp) {
			ctx.addIssue({
				code: 'custom',
				path: ['partialRefundBp'],
				message: 'required',
			})
		}
	})
export type PolicyInputBody = z.infer<typeof policyInputSchema>

export const policyUpdateSchema = z.strictObject({
	name: z.string().trim().min(1).max(80).optional(),
	kind: z.enum(POLICY_SAVABLE_KINDS).optional(),
	amountMinor: minor.optional(),
	perCover: z.boolean().optional(),
	freeCancelUntilMin: z.number().int().min(0).max(43_200).optional(),
	lateCancelFeeMinor: minor.optional(),
	noShowFeeMinor: minor.optional(),
	feePerCover: z.boolean().optional(),
	feeCapMinor: minor.nullish(),
	refundRule: z.enum(RSV_POLICY_REFUND_RULE_VALUES).optional(),
	partialRefundBp: z.number().int().min(1).max(10_000).nullish(),
	appliesPartyMin: z.number().int().min(1).max(99).nullish(),
	termsI18n: termsSchema.nullish(),
	expectedVersion: z.number().int().min(1),
})
export type PolicyUpdateBody = z.infer<typeof policyUpdateSchema>

type PolicyRow = typeof rsvPolicies.$inferSelect

export function serializePolicy(row: PolicyRow) {
	return {
		id: row.id,
		locationId: row.locationId,
		name: row.name,
		kind: row.kind,
		amountMinor: row.amountMinor,
		perCover: row.perCover,
		currency: row.currency,
		freeCancelUntilMin: row.freeCancelUntilMin,
		lateCancelFeeMinor: row.lateCancelFeeMinor,
		noShowFeeMinor: row.noShowFeeMinor,
		feePerCover: row.feePerCover,
		feeCapMinor: row.feeCapMinor,
		refundRule: row.refundRule,
		partialRefundBp: row.partialRefundBp,
		appliesPartyMin: row.appliesPartyMin,
		termsI18n: row.termsI18n ?? {},
		termsVersion: row.termsVersion,
		archived: row.archivedAt !== null,
		version: row.version,
	}
}

export async function listPolicies(
	db: TenantDatabase,
	locationId: string,
	options: { includeArchived?: boolean } = {},
) {
	const rows = await db
		.select()
		.from(rsvPolicies)
		.where(
			options.includeArchived
				? eq(rsvPolicies.locationId, locationId)
				: and(
						eq(rsvPolicies.locationId, locationId),
						isNull(rsvPolicies.archivedAt),
					),
		)
	return rows.map(serializePolicy)
}

async function locationCurrency(
	db: TenantDatabase,
	locationId: string,
): Promise<string> {
	const settings = await db
		.select({ currency: rsvLocationSettings.currency })
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	if (!settings) throw new HttpError(404, 'not_found')
	return (settings.currency || 'USD').toUpperCase()
}

/** A money kind needs the payments feature and processor support (fail closed). */
export function assertPolicyKindAvailable(
	kind: string,
	input: {
		paymentsFeature: boolean
		context: ReservationsContext | null
	},
): void {
	if (kind === 'none') return
	if (!input.paymentsFeature) throw new HttpError(404, 'feature_off')
	const payments = input.context?.payments
	const supported =
		kind === 'card_guarantee' ? payments?.guarantee : payments?.deposit
	if (!payments?.processor || !supported) {
		throw new HttpError(409, 'policy_unavailable')
	}
}

function termsChanged(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? {}) !== JSON.stringify(b ?? {})
}

export async function createPolicy(params: {
	db: TenantDatabase
	orgId: string
	locationId: string
	actorId: string
	input: PolicyInputBody
	paymentsFeature: boolean
	context: ReservationsContext | null
}): Promise<ReturnType<typeof serializePolicy>> {
	assertPolicyKindAvailable(params.input.kind, params)
	return withSetupWrite(
		params.db,
		async (tx) => {
			const currency = await locationCurrency(tx, params.locationId)
			const id = `pol_${randomUUID()}`
			await tx.insert(rsvPolicies).values({
				id,
				locationId: params.locationId,
				name: params.input.name,
				kind: params.input.kind,
				amountMinor:
					params.input.kind === 'none' ? 0 : params.input.amountMinor,
				perCover: params.input.perCover,
				currency,
				freeCancelUntilMin: params.input.freeCancelUntilMin,
				lateCancelFeeMinor: params.input.lateCancelFeeMinor,
				noShowFeeMinor: params.input.noShowFeeMinor,
				feePerCover: params.input.feePerCover,
				feeCapMinor: params.input.feeCapMinor ?? null,
				refundRule: params.input.refundRule,
				partialRefundBp:
					params.input.refundRule === 'partial'
						? (params.input.partialRefundBp ?? null)
						: null,
				appliesPartyMin: params.input.appliesPartyMin ?? null,
				termsI18n: params.input.termsI18n
					? assertLocalizedMap(
							params.input.termsI18n,
							localeOrgOf(params.context),
							'termsI18n',
						)
					: null,
				termsVersion: 1,
				version: 1,
			})
			await writeSetupAuditLog(tx, {
				actorId: params.actorId,
				locationId: params.locationId,
				action: 'policy.create',
				entityType: 'policy',
				entityId: id,
				changes: { kind: params.input.kind },
			})
			const row = (await tx
				.select()
				.from(rsvPolicies)
				.where(eq(rsvPolicies.id, id))
				.get())!
			return serializePolicy(row)
		},
		params.orgId,
	)
}

export async function updatePolicy(params: {
	db: TenantDatabase
	orgId: string
	locationId: string
	policyId: string
	actorId: string
	patch: PolicyUpdateBody
	paymentsFeature: boolean
	context: ReservationsContext | null
}): Promise<ReturnType<typeof serializePolicy>> {
	return withSetupWrite(
		params.db,
		async (tx) => {
			const row = await tx
				.select()
				.from(rsvPolicies)
				.where(
					and(
						eq(rsvPolicies.id, params.policyId),
						eq(rsvPolicies.locationId, params.locationId),
					),
				)
				.get()
			if (!row || row.archivedAt !== null) throw new HttpError(404, 'not_found')
			if (row.version !== params.patch.expectedVersion) {
				throw new HttpError(409, 'stale_version', undefined, {
					currentVersion: row.version,
				})
			}
			const { expectedVersion: ignoredExpectedVersion, ...patch } = params.patch
			void ignoredExpectedVersion
			const next = {
				name: patch.name ?? row.name,
				kind: patch.kind ?? row.kind,
				amountMinor: patch.amountMinor ?? row.amountMinor,
				perCover: patch.perCover ?? row.perCover,
				freeCancelUntilMin: patch.freeCancelUntilMin ?? row.freeCancelUntilMin,
				lateCancelFeeMinor: patch.lateCancelFeeMinor ?? row.lateCancelFeeMinor,
				noShowFeeMinor: patch.noShowFeeMinor ?? row.noShowFeeMinor,
				feePerCover: patch.feePerCover ?? row.feePerCover,
				feeCapMinor:
					patch.feeCapMinor !== undefined ? patch.feeCapMinor : row.feeCapMinor,
				refundRule: patch.refundRule ?? row.refundRule,
				partialRefundBp:
					patch.partialRefundBp !== undefined
						? patch.partialRefundBp
						: row.partialRefundBp,
				appliesPartyMin:
					patch.appliesPartyMin !== undefined
						? patch.appliesPartyMin
						: row.appliesPartyMin,
				termsI18n:
					patch.termsI18n !== undefined
						? patch.termsI18n
							? assertLocalizedMap(
									patch.termsI18n,
									localeOrgOf(params.context),
									'termsI18n',
								)
							: patch.termsI18n
						: row.termsI18n,
			}
			const check = policyInputSchema.safeParse({
				...next,
				feeCapMinor: next.feeCapMinor,
				partialRefundBp: next.partialRefundBp,
				appliesPartyMin: next.appliesPartyMin,
				termsI18n: next.termsI18n,
			})
			if (!check.success) {
				throw new HttpError(400, 'invalid', undefined, {
					issues: check.error.issues
						.slice(0, 10)
						.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
				})
			}
			// Switching to a money kind needs the feature and processor support.
			if (next.kind !== row.kind || next.kind !== 'none') {
				assertPolicyKindAvailable(next.kind, params)
			}
			const consentChanged =
				termsChanged(next.termsI18n, row.termsI18n) ||
				next.amountMinor !== row.amountMinor ||
				next.perCover !== row.perCover ||
				next.kind !== row.kind ||
				next.freeCancelUntilMin !== row.freeCancelUntilMin ||
				next.lateCancelFeeMinor !== row.lateCancelFeeMinor ||
				next.noShowFeeMinor !== row.noShowFeeMinor ||
				next.feePerCover !== row.feePerCover ||
				next.feeCapMinor !== row.feeCapMinor ||
				next.refundRule !== row.refundRule ||
				next.partialRefundBp !== row.partialRefundBp
			await tx
				.update(rsvPolicies)
				.set({
					...next,
					partialRefundBp:
						next.refundRule === 'partial' ? next.partialRefundBp : null,
					termsI18n: next.termsI18n ?? null,
					termsVersion: consentChanged
						? row.termsVersion + 1
						: row.termsVersion,
					version: row.version + 1,
				})
				.where(eq(rsvPolicies.id, row.id))
			await writeSetupAuditLog(tx, {
				actorId: params.actorId,
				locationId: params.locationId,
				action: 'policy.update',
				entityType: 'policy',
				entityId: row.id,
				changes: {
					termsVersion: consentChanged
						? row.termsVersion + 1
						: row.termsVersion,
				},
			})
			const fresh = (await tx
				.select()
				.from(rsvPolicies)
				.where(eq(rsvPolicies.id, row.id))
				.get())!
			return serializePolicy(fresh)
		},
		params.orgId,
	)
}

export async function archivePolicy(params: {
	db: TenantDatabase
	orgId: string
	locationId: string
	policyId: string
	actorId: string
}): Promise<void> {
	await withSetupWrite(
		params.db,
		async (tx) => {
			const row = await tx
				.select()
				.from(rsvPolicies)
				.where(
					and(
						eq(rsvPolicies.id, params.policyId),
						eq(rsvPolicies.locationId, params.locationId),
					),
				)
				.get()
			if (!row) throw new HttpError(404, 'not_found')
			if (row.archivedAt !== null) return
			await tx
				.update(rsvPolicies)
				.set({
					archivedAt: Date.now(),
					version: row.version + 1,
				})
				.where(eq(rsvPolicies.id, row.id))
			await writeSetupAuditLog(tx, {
				actorId: params.actorId,
				locationId: params.locationId,
				action: 'policy.archive',
				entityType: 'policy',
				entityId: row.id,
			})
		},
		params.orgId,
	)
}
