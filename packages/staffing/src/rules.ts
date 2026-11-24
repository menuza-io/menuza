import { z } from 'zod'
import { type HourCaps, hourCapsSchema, NO_HOUR_CAPS } from './hour-caps.ts'
import { basisPointsSchema, localDateSchema } from './schemas.ts'

export const ROUNDING_MODES = ['none', 'nearest', 'up', 'down'] as const

/** Only divisors of 60 keep rounding boundaries on the local clock's hour. */
export const roundingIncrementSchema = z
	.number()
	.int()
	.min(1)
	.max(60)
	.refine((n) => 60 % n === 0, {
		error:
			'Rounding increment must divide 60 evenly (1, 2, 3, 5, 6, 10, 12, 15, 20, 30 or 60).',
	})
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
			incrementMinutes: roundingIncrementSchema,
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
	/** Hour caps a scope starts with when it follows this pack (#527). */
	hourCaps: hourCapsSchema,
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
	hourCaps: NO_HOUR_CAPS,
}

/**
 * Hour caps of the KSA pack: 8 hours a day and 48 a week, and 6 a day and 36 a
 * week in Ramadan for people who follow the Ramadan limit. Data a scope can
 * change, not a legal claim.
 */
export const KSA_HOUR_CAPS: HourCaps = {
	dailyMinutes: 8 * 60,
	weeklyMinutes: 48 * 60,
	ramadanDailyMinutes: 6 * 60,
	ramadanWeeklyMinutes: 36 * 60,
}

/**
 * Hour limits for Saudi Arabia. It sets hour caps only: overtime, breaks and
 * every other rule stay neutral until they are reviewed.
 */
export const KSA_RULE_PACK: RulePack = {
	id: 'ksa',
	version: 1,
	region: 'ksa',
	label: 'Saudi Arabia (hour limits)',
	disclaimer:
		'Estimates only. These hour limits are a starting point, not legal advice and not payroll. Check your local requirements before relying on them.',
	rules: NEUTRAL_LABOR_RULES,
	hourCaps: KSA_HOUR_CAPS,
}

/** Packs available today. A US pack is added after legal review. */
export const RULE_PACKS: readonly RulePack[] = [GENERIC_RULE_PACK, KSA_RULE_PACK]

export function getRulePack(id: string): RulePack | undefined {
	return RULE_PACKS.find((pack) => pack.id === id)
}
