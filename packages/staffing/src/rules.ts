import { z } from 'zod'
import { basisPointsSchema, localDateSchema } from './schemas.ts'

export const ROUNDING_MODES = ['none', 'nearest', 'up', 'down'] as const
export type RoundingMode = (typeof ROUNDING_MODES)[number]

export const thresholdRuleSchema = z.object({
	/** Minutes worked before the premium applies. */
	thresholdMinutes: z
		.number()
		.int()
		.min(1)
		.max(60 * 24 * 7),
	/** Pay multiplier in basis points (15000 = 1.5x). */
	multiplierBp: basisPointsSchema,
})

/**
 * Configurable labor rules for one scope. This is data, not law: nothing here
 * encodes a legal claim, and every figure computed from it is an estimate.
 */
export const laborRulesSchema = z
	.object({
		/** 0 = Sunday ... 6 = Saturday. */
		weekStartsOn: z.number().int().min(0).max(6),
		/** Minutes after local midnight when a business day starts (0-1439). */
		workdayStartMinute: z.number().int().min(0).max(1439),
		/** Rounding applied to clock-in and clock-out; raw punches are kept. */
		rounding: z.object({
			mode: z.enum(ROUNDING_MODES),
			incrementMinutes: z.number().int().min(1).max(60),
		}),
		dailyOvertime: thresholdRuleSchema.nullable(),
		dailyDoubleTime: thresholdRuleSchema.nullable(),
		weeklyOvertime: thresholdRuleSchema.nullable(),
		holiday: z.object({
			dates: z.array(localDateSchema).max(366),
			/** 10000 means no premium; holiday hours never count toward overtime. */
			multiplierBp: basisPointsSchema,
		}),
		/** Deduct an unpaid break when none was recorded on a long enough shift. */
		autoBreakDeduction: z
			.object({
				afterMinutes: z
					.number()
					.int()
					.min(1)
					.max(60 * 24),
				deductMinutes: z.number().int().min(1).max(240),
			})
			.nullable(),
		/**
		 * Whether overtime is counted across all of a person's scopes. Has no
		 * default: it must be chosen explicitly wherever staff work at more than
		 * one scope.
		 */
		aggregateOvertimeAcrossScopes: z.boolean(),
		/** Shifts longer than this are flagged for review. */
		longShiftMinutes: z
			.number()
			.int()
			.min(60)
			.max(60 * 48),
	})
	.refine(
		(rules) =>
			!rules.dailyDoubleTime ||
			!rules.dailyOvertime ||
			rules.dailyDoubleTime.thresholdMinutes >
				rules.dailyOvertime.thresholdMinutes,
		{
			message: 'Double time must start after daily overtime',
			path: ['dailyDoubleTime'],
		},
	)

export type LaborRules = z.infer<typeof laborRulesSchema>

/** Neutral starting point: no rounding, no premiums, Monday week start. */
export const NEUTRAL_LABOR_RULES: LaborRules = {
	weekStartsOn: 1,
	workdayStartMinute: 0,
	rounding: { mode: 'none', incrementMinutes: 1 },
	dailyOvertime: null,
	dailyDoubleTime: null,
	weeklyOvertime: null,
	holiday: { dates: [], multiplierBp: 10_000 },
	autoBreakDeduction: null,
	aggregateOvertimeAcrossScopes: false,
	longShiftMinutes: 16 * 60,
}

/**
 * A region rule pack is a named, versioned bundle of default labor rules plus a
 * plain-language disclaimer. Packs are data: they seed a scope's labor
 * policy, which the organization can then change. Packs make no legal claims.
 */
export const rulePackSchema = z.object({
	id: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
	version: z.number().int().min(1),
	region: z.enum(['generic', 'us', 'ksa']),
	/** English label key; display strings are translated by the caller. */
	label: z.string().min(1).max(80),
	disclaimer: z.string().min(1).max(500),
	rules: laborRulesSchema,
})
export type RulePack = z.infer<typeof rulePackSchema>

export const GENERIC_RULE_PACK: RulePack = {
	id: 'generic',
	version: 1,
	region: 'generic',
	label: 'Generic (no overtime rules)',
	disclaimer:
		'Estimates only. These settings are not legal advice and are not payroll. Check your local requirements before relying on them.',
	rules: NEUTRAL_LABOR_RULES,
}

/** Packs available today. US and KSA packs are added after legal review. */
export const RULE_PACKS: readonly RulePack[] = [GENERIC_RULE_PACK]

export function getRulePack(id: string): RulePack | undefined {
	return RULE_PACKS.find((pack) => pack.id === id)
}
