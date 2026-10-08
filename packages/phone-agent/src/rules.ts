import {
	type TrainingRuleCategory,
	type TrainingRulePriority,
} from './constants.ts'

export type TrainingRule = {
	id: string
	category: TrainingRuleCategory
	title: string
	description: string
	priority: TrainingRulePriority
	isActive: boolean
	scopeId?: string | null
	sortOrder?: number
}

/** A category id with the heading its rules get in the prompt. */
export type RuleCategoryHeading = { id: string; label: string }

/** Headings for the base categories; see `trainingRuleCategoriesFor`. */
export const BASE_RULE_CATEGORY_HEADINGS: readonly RuleCategoryHeading[] = [
	{ id: 'escalation', label: 'Escalation' },
	{ id: 'error_handling', label: 'Error handling' },
]

const PRIORITY_RANK: Record<TrainingRulePriority, number> = {
	high: 0,
	medium: 1,
	low: 2,
}

/** Roughly 4 characters per token for English prose. */
export const DEFAULT_RULES_CHAR_BUDGET = 6000

export const DEFAULT_RULES_TITLE = 'Business rules'

export type CompileRulesOptions = {
	scopeId?: string | null
	charBudget?: number
	/** Section sequence and headings. Defaults to the base categories. */
	categories?: readonly RuleCategoryHeading[]
	/** Extra filter from the vertical, e.g. rules for a feature that is off. */
	include?: (rule: TrainingRule) => boolean
	/** Prompt heading for the rules. Defaults to DEFAULT_RULES_TITLE. */
	title?: string
}

export type CompiledRules = {
	text: string
	includedIds: string[]
	droppedIds: string[]
}

function ruleLine(rule: TrainingRule) {
	const marker = rule.priority === 'high' ? ' (must follow)' : ''
	return `- ${rule.title.trim()}${marker}: ${rule.description.trim()}`
}

export function activeRules(
	rules: TrainingRule[],
	options: CompileRulesOptions = {},
) {
	return rules
		.filter((rule) => rule.isActive)
		.filter((rule) => !rule.scopeId || rule.scopeId === options.scopeId)
		.filter((rule) => !options.include || options.include(rule))
		.sort(
			(a, b) =>
				PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
				(a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
				a.title.localeCompare(b.title),
		)
}

/** Most training rules one organization can have, active or not. */
export const MAX_TRAINING_RULES = 200
/** Error code a create returns once an organization has MAX_TRAINING_RULES. */
export const TRAINING_RULE_LIMIT_ERROR = 'rule_limit'

/**
 * Turns the business's rules into a prompt section for the AI assistant.
 * Rules are taken highest priority first until the budget is spent; the rest
 * are dropped, because long prompts slow voice replies and weaken rule
 * adherence. High priority rules count against the budget too, so many of
 * them can't crowd out the rest of the prompt. Rules in a category the
 * vertical doesn't list (for example after switching verticals) go last,
 * under "Other".
 */
export function compileTrainingRules(
	rules: TrainingRule[],
	options: CompileRulesOptions = {},
): CompiledRules {
	const budget = options.charBudget ?? DEFAULT_RULES_CHAR_BUDGET
	const relevant = activeRules(rules, options)
	const included: TrainingRule[] = []
	const droppedIds: string[] = []
	let used = 0
	for (const rule of relevant) {
		const size = ruleLine(rule).length + 1
		if (used + size <= budget) {
			included.push(rule)
			used += size
		} else {
			droppedIds.push(rule.id)
		}
	}

	if (included.length === 0) {
		return { text: '', includedIds: [], droppedIds }
	}

	const categories = options.categories ?? BASE_RULE_CATEGORY_HEADINGS
	const known = new Set(categories.map((category) => category.id))
	const sections: string[] = []
	const section = (heading: string, inSection: TrainingRule[]) => {
		if (inSection.length === 0) return
		sections.push(`${heading}:\n${inSection.map(ruleLine).join('\n')}`)
	}
	for (const category of categories) {
		section(
			category.label,
			included.filter((rule) => rule.category === category.id),
		)
	}
	section(
		'Other',
		included.filter((rule) => !known.has(rule.category)),
	)

	return {
		text: `${options.title ?? DEFAULT_RULES_TITLE}. Follow these; rules marked "must follow" override everything except safety and honesty.\n\n${sections.join('\n\n')}`,
		includedIds: included.map((rule) => rule.id),
		droppedIds,
	}
}
