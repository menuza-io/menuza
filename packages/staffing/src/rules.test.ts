import { describe, expect, it } from 'vitest'
import {
	GENERIC_RULE_PACK,
	getRulePack,
	laborRulesSchema,
	NEUTRAL_LABOR_RULES,
	rulePackSchema,
	RULE_PACKS,
} from './rules.ts'

describe('laborRulesSchema', () => {
	it('accepts the neutral rules', () => {
		expect(laborRulesSchema.safeParse(NEUTRAL_LABOR_RULES).success).toBe(true)
	})
	it('requires the cross-scope aggregation choice explicitly', () => {
		const { aggregateOvertimeAcrossScopes, ...rest } = NEUTRAL_LABOR_RULES
		expect(aggregateOvertimeAcrossScopes).toBe(false)
		expect(laborRulesSchema.safeParse(rest).success).toBe(false)
	})
	it('keeps multipliers in basis points of at least 1x and rejects fractions', () => {
		const bad = {
			...NEUTRAL_LABOR_RULES,
			weeklyOvertime: { thresholdMinutes: 2400, multiplierBp: 1.5 },
		}
		expect(laborRulesSchema.safeParse(bad).success).toBe(false)
		const low = {
			...NEUTRAL_LABOR_RULES,
			weeklyOvertime: { thresholdMinutes: 2400, multiplierBp: 5000 },
		}
		expect(laborRulesSchema.safeParse(low).success).toBe(false)
	})
	it('requires double time to start after daily overtime', () => {
		const rules = {
			...NEUTRAL_LABOR_RULES,
			dailyOvertime: { thresholdMinutes: 480, multiplierBp: 15_000 },
			dailyDoubleTime: { thresholdMinutes: 480, multiplierBp: 20_000 },
		}
		expect(laborRulesSchema.safeParse(rules).success).toBe(false)
		rules.dailyDoubleTime.thresholdMinutes = 720
		expect(laborRulesSchema.safeParse(rules).success).toBe(true)
	})
	it('bounds the week start and workday start', () => {
		expect(
			laborRulesSchema.safeParse({ ...NEUTRAL_LABOR_RULES, weekStartsOn: 7 })
				.success,
		).toBe(false)
		expect(
			laborRulesSchema.safeParse({
				...NEUTRAL_LABOR_RULES,
				workdayStartMinute: 1440,
			}).success,
		).toBe(false)
	})
})

describe('rule packs', () => {
	it('ships a valid generic pack with a disclaimer and no overtime', () => {
		expect(rulePackSchema.safeParse(GENERIC_RULE_PACK).success).toBe(true)
		expect(GENERIC_RULE_PACK.rules.weeklyOvertime).toBeNull()
		expect(GENERIC_RULE_PACK.disclaimer.toLowerCase()).toContain(
			'not legal advice',
		)
	})
	it('looks packs up by id', () => {
		expect(getRulePack('generic')).toBe(GENERIC_RULE_PACK)
		expect(getRulePack('nope')).toBeUndefined()
		expect(RULE_PACKS.every((p) => rulePackSchema.safeParse(p).success)).toBe(
			true,
		)
	})
})
