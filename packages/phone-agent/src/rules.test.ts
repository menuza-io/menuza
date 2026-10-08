import { describe, expect, it } from 'vitest'
import { compileTrainingRules, type TrainingRule } from './rules.ts'

function rule(overrides: Partial<TrainingRule>): TrainingRule {
	return {
		id: overrides.id ?? Math.random().toString(36),
		category: 'escalation',
		title: 'Rule',
		description: 'Do the thing.',
		priority: 'medium',
		isActive: true,
		...overrides,
	}
}

describe('compileTrainingRules', () => {
	it('scopes rules and applies the vertical filter', () => {
		const rules = [
			rule({ id: 'escalate', category: 'escalation' }),
			rule({ id: 'feature', category: 'feature_x' }),
			rule({
				id: 'other_scope',
				category: 'error_handling',
				scopeId: 'scope_2',
			}),
			rule({ id: 'off', category: 'error_handling', isActive: false }),
		]
		const first = compileTrainingRules(rules, { scopeId: 'scope_1' })
		expect(first.includedIds.sort()).toEqual(['escalate', 'feature'])

		const filtered = compileTrainingRules(rules, {
			scopeId: 'scope_1',
			include: (candidate) => candidate.category !== 'feature_x',
		})
		expect(filtered.includedIds).toEqual(['escalate'])

		const second = compileTrainingRules(rules, { scopeId: 'scope_2' })
		expect(second.includedIds).toContain('other_scope')
	})

	it('groups rules by the given categories and puts unknown ones last', () => {
		const compiled = compileTrainingRules(
			[
				rule({ id: 'a', category: 'error_handling', title: 'Retry' }),
				rule({ id: 'b', category: 'greeting', title: 'Say hi' }),
				rule({ id: 'c', category: 'mystery', title: 'Old rule' }),
			],
			{
				categories: [
					{ id: 'greeting', label: 'Greeting' },
					{ id: 'error_handling', label: 'Error handling' },
				],
				title: 'Clinic rules',
			},
		)
		expect(compiled.text).toBe(
			[
				'Clinic rules. Follow these; rules marked "must follow" override everything except safety and honesty.',
				'',
				'Greeting:\n- Say hi: Do the thing.',
				'',
				'Error handling:\n- Retry: Do the thing.',
				'',
				'Other:\n- Old rule: Do the thing.',
			].join('\n'),
		)
	})

	it('uses a neutral title by default', () => {
		expect(compileTrainingRules([rule({})]).text).toMatch(/^Business rules\./)
	})

	it('counts high priority rules against the budget too', () => {
		const long = 'x'.repeat(80)
		const rules = [
			rule({ id: 'high_1', priority: 'high', description: long }),
			rule({ id: 'high_2', priority: 'high', description: long }),
			rule({ id: 'high_3', priority: 'high', description: long }),
			rule({ id: 'low', priority: 'low', description: 'Short.' }),
		]
		const compiled = compileTrainingRules(rules, { charBudget: 230 })
		expect(compiled.includedIds).toEqual(['high_1', 'high_2', 'low'])
		expect(compiled.droppedIds).toEqual(['high_3'])
		const ruleLines = compiled.text
			.split('\n')
			.filter((line) => line.startsWith('- '))
		expect(ruleLines.join('\n').length).toBeLessThanOrEqual(230)
	})

	it('drops a rule that cannot fit instead of exceeding the budget', () => {
		const compiled = compileTrainingRules(
			[rule({ id: 'huge', priority: 'high', description: 'x'.repeat(500) })],
			{ charBudget: 100 },
		)
		expect(compiled).toEqual({
			text: '',
			includedIds: [],
			droppedIds: ['huge'],
		})
	})

	it('keeps high priority rules and drops low ones over budget', () => {
		const long = 'x'.repeat(80)
		const rules = [
			rule({ id: 'low', priority: 'low', description: long }),
			rule({ id: 'high', priority: 'high', description: long }),
			rule({ id: 'medium', priority: 'medium', description: long }),
		]
		const compiled = compileTrainingRules(rules, { charBudget: 200 })
		expect(compiled.includedIds).toEqual(['high', 'medium'])
		expect(compiled.droppedIds).toEqual(['low'])
		expect(compiled.text).toContain('(must follow)')
	})

	it('returns empty text when nothing applies', () => {
		expect(compileTrainingRules([rule({ isActive: false })]).text).toBe('')
	})
})
