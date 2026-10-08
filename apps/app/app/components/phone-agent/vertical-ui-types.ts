import { type MessageDescriptor } from '@lingui/core'
import { type PhraseKey, type TrainingRule } from '@repo/phone-agent'
import { type ComponentType } from 'react'
import { type CallHandoff } from './call-data.ts'

/** Translated labels for a vertical's definition ids. */
export type DefinitionLabels = Record<string, MessageDescriptor>

export type VerticalSettingsSectionProps = {
	/** `settings.vertical` as saved. */
	value: Record<string, unknown>
	onChange(next: Record<string, unknown>): void
	disabled: boolean
	/** What the server vertical's `advancedPageData` returned. */
	data: unknown
	/** Field errors under `vertical.`, keyed without the prefix. */
	fieldErrors: Record<string, string>
}

export type RuleExample = {
	category: string
	title: MessageDescriptor
	description: MessageDescriptor
}

/**
 * The UI half of a phone agent vertical. Everything is optional: missing
 * labels fall back to the vertical's English labels, and missing sections are
 * simply not shown.
 */
export type PhoneAgentVerticalUi = {
	purposeLabels?: DefinitionLabels
	requestTypeLabels?: DefinitionLabels
	ruleCategoryLabels?: DefinitionLabels
	ruleCategoryDescriptions?: DefinitionLabels
	faqCategoryLabels?: DefinitionLabels
	/** Names for the vertical's scope, when it has one. */
	scope?: {
		label: MessageDescriptor
		all: MessageDescriptor
		unknown: MessageDescriptor
		/** Shown where a scope is needed but there are none yet. */
		missing: MessageDescriptor
	}
	/** Starter rules offered when there are none yet. */
	ruleExamples?: RuleExample[]
	/** Rules the agent skips with these vertical settings. */
	includeRule?(
		rule: Pick<TrainingRule, 'category'>,
		verticalSettings: Record<string, unknown>,
	): boolean
	/** A note shown above a rule category, e.g. when the agent skips it. */
	ruleCategoryNotice?(
		category: string,
		verticalSettings: Record<string, unknown>,
	): MessageDescriptor | null
	/** Extra Advanced page section for `settings.vertical`. */
	SettingsSection?: ComponentType<VerticalSettingsSectionProps>
	/** Replaces the Phrases page label or hint for a phrase. */
	phraseCopy?: Partial<
		Record<PhraseKey, { label?: MessageDescriptor; hint?: MessageDescriptor }>
	>
	/** Heading for the texted links on a call. */
	handoffsTitle?: MessageDescriptor
	/** What a texted link carried, rendered from its payload. */
	HandoffDetails?: ComponentType<{ handoff: CallHandoff }>
}
