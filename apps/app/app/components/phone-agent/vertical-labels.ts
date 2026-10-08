import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	callPurposesFor,
	callRequestTypesFor,
	faqCategoriesFor,
	trainingRuleCategoriesFor,
	type VerticalDefinition,
} from '@repo/phone-agent'
import { useMemo } from 'react'
import { phoneAgentVertical } from '#app/utils/phone-agent/vertical.ts'
import { type DefinitionLabels } from './vertical-ui-types.ts'
import { phoneAgentVerticalUi } from './vertical-ui.tsx'

const BASE_PURPOSE_LABELS: DefinitionLabels = {
	business_information: msg`Business info`,
	other: msg`Other`,
}

const BASE_REQUEST_TYPE_LABELS: DefinitionLabels = {
	callback: msg`Callback`,
	complaint: msg`Complaint`,
}

const BASE_RULE_CATEGORY_LABELS: DefinitionLabels = {
	general: msg`General`,
	escalation: msg`Escalation`,
	error_handling: msg`Error handling`,
}

const BASE_RULE_CATEGORY_DESCRIPTIONS: DefinitionLabels = {
	general: msg`How to talk about your business and what to offer.`,
	escalation: msg`When to transfer a call or take a message for staff.`,
	error_handling: msg`What to do when the agent mishears or can't help.`,
}

const BASE_FAQ_CATEGORY_LABELS: DefinitionLabels = {
	general: msg`General`,
	policies: msg`Policies`,
	custom: msg`Your questions`,
}

export type LabeledDefinition = {
	id: string
	label: string
	description: string | null
}

function labeler(
	translate: (descriptor: MessageDescriptor) => string,
	definitions: readonly VerticalDefinition[],
	labels: DefinitionLabels,
	descriptions: DefinitionLabels = {},
) {
	const byId = new Map(definitions.map((entry) => [entry.id, entry]))
	const label = (id: string) => {
		const descriptor = labels[id]
		return descriptor ? translate(descriptor) : (byId.get(id)?.label ?? id)
	}
	const description = (id: string) => {
		const descriptor = descriptions[id]
		return descriptor
			? translate(descriptor)
			: (byId.get(id)?.description ?? null)
	}
	const list: LabeledDefinition[] = definitions.map((entry) => ({
		id: entry.id,
		label: label(entry.id),
		description: description(entry.id),
	}))
	return { label, description, list }
}

/**
 * Translated names for the vertical's call purposes, request types, rule
 * categories, FAQ categories, and scope. Ids the app has no translation for
 * use the vertical's English label, and unknown ids show as they are.
 */
export function useVerticalLabels() {
	const { _ } = useLingui()
	return useMemo(() => {
		const ui = phoneAgentVerticalUi
		const purposes = labeler(_, callPurposesFor(phoneAgentVertical), {
			...BASE_PURPOSE_LABELS,
			...ui.purposeLabels,
		})
		const requestTypes = labeler(_, callRequestTypesFor(phoneAgentVertical), {
			...BASE_REQUEST_TYPE_LABELS,
			...ui.requestTypeLabels,
		})
		const ruleCategories = labeler(
			_,
			trainingRuleCategoriesFor(phoneAgentVertical),
			{ ...BASE_RULE_CATEGORY_LABELS, ...ui.ruleCategoryLabels },
			{ ...BASE_RULE_CATEGORY_DESCRIPTIONS, ...ui.ruleCategoryDescriptions },
		)
		const faqCategories = labeler(_, faqCategoriesFor(phoneAgentVertical), {
			...BASE_FAQ_CATEGORY_LABELS,
			...ui.faqCategoryLabels,
		})
		const scopeDefinition = phoneAgentVertical.scope
		const scope = scopeDefinition
			? {
					label: ui.scope ? _(ui.scope.label) : scopeDefinition.label,
					all: ui.scope ? _(ui.scope.all) : _(msg`Everywhere`),
					unknown: ui.scope ? _(ui.scope.unknown) : _(msg`Unknown`),
					missing: ui.scope
						? _(ui.scope.missing)
						: _(msg`Add one in your business settings first.`),
				}
			: null
		return {
			purposeLabel: purposes.label,
			purposes: purposes.list,
			requestTypeLabel: requestTypes.label,
			requestTypes: requestTypes.list,
			ruleCategoryLabel: ruleCategories.label,
			ruleCategories: ruleCategories.list,
			faqCategoryLabel: faqCategories.label,
			faqCategories: faqCategories.list,
			scope,
		}
	}, [_])
}
