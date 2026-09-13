import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useMemo } from 'react'
import { createDefaultTenantJourneyGraph } from './serialization.ts'
import { type PaletteItem } from './types.ts'
import {
	createDefaultPlatformJourneyGraph,
	type WorkflowConfig,
} from './workflow-config.tsx'

const TENANT_TRIGGER_MSGS: Record<
	string,
	{ label: ReturnType<typeof msg>; desc: ReturnType<typeof msg> }
> = {
	phone_verified: {
		label: msg`Phone Verified`,
		desc: msg`Runs when customer verifies phone OTP`,
	},
	profile_completed: {
		label: msg`Profile Completed`,
		desc: msg`Runs when customer updates name/email`,
	},
	custom_event: {
		label: msg`Custom Event`,
		desc: msg`Runs when custom event triggers`,
	},
	manual: {
		label: msg`Manual Trigger`,
		desc: msg`Triggered via operator test or API`,
	},
}

const TENANT_TRIGGER_OPTION_MSGS: Record<string, ReturnType<typeof msg>> = {
	phone_verified: msg`Phone Verified (OTP Success)`,
	profile_completed: msg`Profile Completed (Name/Email)`,
	custom_event: msg`Custom Event`,
	manual: msg`Manual Trigger`,
}

const PLATFORM_TRIGGER_MSGS: Record<
	string,
	{ label: ReturnType<typeof msg>; desc: ReturnType<typeof msg> }
> = {
	org_created: {
		label: msg`Organization Created`,
		desc: msg`Runs when a new tenant organization is created`,
	},
	operator_invited: {
		label: msg`Operator Invited`,
		desc: msg`Runs when an operator is invited to an organization`,
	},
	subscription_started: {
		label: msg`Subscription Started`,
		desc: msg`Runs when a tenant starts a paid subscription`,
	},
	subscription_cancelled: {
		label: msg`Subscription Cancelled`,
		desc: msg`Runs when a tenant cancels their subscription`,
	},
	manual: {
		label: msg`Manual Trigger`,
		desc: msg`Triggered via admin test or API`,
	},
}

const PALETTE_MSGS = {
	trigger: {
		label: msg`Trigger Event`,
		description: msg`Start journey on lifecycle event`,
	},
	delay: {
		label: msg`Time Delay`,
		description: msg`Wait for a specified duration before next step`,
	},
	action_email: {
		label: msg`Send Email`,
		description: msg`Dispatch personalized email with merge tags`,
	},
	action_sms: {
		label: msg`Send SMS`,
		description: msg`Dispatch text message with merge tags`,
	},
	condition: {
		label: msg`Condition Branch`,
		description: msg`Split path based on rules (True / False)`,
	},
} as const

const TENANT_EMAIL_DEFAULTS = {
	subject: msg`Your Exclusive Update`,
	bodyHtml: msg`<p>Hi {{name}},</p><p>Check out our latest update.</p>`,
	bodyText: msg`Hi {{name}}, Check out our latest update.`,
	fromName: msg`Team`,
}

const TENANT_SMS_DEFAULT = msg`Hi {{name}}, your account update is ready!`

const PLATFORM_EMAIL_DEFAULTS = {
	subject: msg`Welcome to Menuza, {{organizationName}}`,
	bodyHtml: msg`<p>Hi {{name}},</p><p>Your organization {{organizationName}} is ready.</p>`,
	bodyText: msg`Hi {{name}}, Your organization {{organizationName}} is ready.`,
	fromName: msg`Menuza Team`,
}

const PLATFORM_SMS_DEFAULT = msg`Hi {{name}}, your Menuza account is ready.`

function buildPaletteItems(
	_: (descriptor: ReturnType<typeof msg>) => string,
	audience: 'tenant' | 'platform',
): PaletteItem[] {
	const baseItems: Omit<PaletteItem, 'defaultData'>[] = [
		{
			type: 'trigger',
			label: _(PALETTE_MSGS.trigger.label),
			description: _(PALETTE_MSGS.trigger.description),
			icon: 'play',
			color: 'text-muted-foreground ',
		},
		{
			type: 'delay',
			label: _(PALETTE_MSGS.delay.label),
			description: _(PALETTE_MSGS.delay.description),
			icon: 'clock',
			color: 'text-muted-foreground ',
		},
		{
			type: 'action_email',
			label: _(PALETTE_MSGS.action_email.label),
			description: _(PALETTE_MSGS.action_email.description),
			icon: 'mail',
			color: 'text-muted-foreground ',
		},
		{
			type: 'action_sms',
			label: _(PALETTE_MSGS.action_sms.label),
			description: _(PALETTE_MSGS.action_sms.description),
			icon: 'smartphone',
			color: 'text-muted-foreground ',
			isGated: true,
		},
		{
			type: 'condition',
			label: _(PALETTE_MSGS.condition.label),
			description: _(PALETTE_MSGS.condition.description),
			icon: 'split',
			color: 'text-muted-foreground ',
		},
	]

	if (audience === 'tenant') {
		return [
			{
				...baseItems[0]!,
				defaultData: {
					triggerType: 'phone_verified',
					config: {},
				},
			},
			{
				...baseItems[1]!,
				defaultData: { duration: 1, unit: 'hours' },
			},
			{
				...baseItems[2]!,
				defaultData: {
					subject: _(TENANT_EMAIL_DEFAULTS.subject),
					bodyHtml: _(TENANT_EMAIL_DEFAULTS.bodyHtml),
					bodyText: _(TENANT_EMAIL_DEFAULTS.bodyText),
					fromName: _(TENANT_EMAIL_DEFAULTS.fromName),
				},
			},
			{
				...baseItems[3]!,
				defaultData: {
					messageText: _(TENANT_SMS_DEFAULT),
				},
			},
			{
				...baseItems[4]!,
				defaultData: {
					field: 'tags',
					operator: 'contains',
					value: 'VIP',
				},
			},
		]
	}

	return [
		{
			...baseItems[0]!,
			defaultData: { triggerType: 'org_created' as never, config: {} },
		},
		{
			...baseItems[1]!,
			defaultData: { duration: 1, unit: 'days' },
		},
		{
			...baseItems[2]!,
			defaultData: {
				subject: _(PLATFORM_EMAIL_DEFAULTS.subject),
				bodyHtml: _(PLATFORM_EMAIL_DEFAULTS.bodyHtml),
				bodyText: _(PLATFORM_EMAIL_DEFAULTS.bodyText),
				fromName: _(PLATFORM_EMAIL_DEFAULTS.fromName),
			},
		},
		{
			...baseItems[3]!,
			defaultData: {
				messageText: _(PLATFORM_SMS_DEFAULT),
			},
		},
		{
			...baseItems[4]!,
			defaultData: {
				field: 'planName',
				operator: 'equals',
				value: 'pro',
			},
		},
	]
}

function buildTriggerLabels(
	_: (descriptor: ReturnType<typeof msg>) => string,
	triggerMsgs: Record<
		string,
		{ label: ReturnType<typeof msg>; desc: ReturnType<typeof msg> }
	>,
): Record<string, { label: string; desc: string }> {
	return Object.fromEntries(
		Object.entries(triggerMsgs).map(([key, value]) => [
			key,
			{ label: _(value.label), desc: _(value.desc) },
		]),
	)
}

function buildTenantConfig(
	_: (descriptor: ReturnType<typeof msg>) => string,
): WorkflowConfig {
	return {
		audience: 'tenant',
		triggerLabels: buildTriggerLabels(_, TENANT_TRIGGER_MSGS),
		triggerOptions: Object.entries(TENANT_TRIGGER_OPTION_MSGS).map(
			([value, labelMsg]) => ({
				value,
				label: _(labelMsg),
			}),
		),
		paletteItems: buildPaletteItems(_, 'tenant'),
		defaultGraph: createDefaultTenantJourneyGraph,
		mergeTagHint: '{{name}}, {{email}}, {{phone}}',
		subjectEntityLabel: _(msg`customer`),
	}
}

function buildPlatformConfig(
	_: (descriptor: ReturnType<typeof msg>) => string,
): WorkflowConfig {
	const triggerLabels = buildTriggerLabels(_, PLATFORM_TRIGGER_MSGS)
	return {
		audience: 'platform',
		triggerLabels,
		triggerOptions: Object.entries(PLATFORM_TRIGGER_MSGS).map(
			([value, meta]) => ({
				value,
				label: _(meta.label),
				description: _(meta.desc),
			}),
		),
		paletteItems: buildPaletteItems(_, 'platform'),
		defaultGraph: createDefaultPlatformJourneyGraph,
		mergeTagHint: '{{name}}, {{email}}, {{organizationName}}',
		subjectEntityLabel: _(msg`operator`),
	}
}

export function useLocalizedTenantWorkflowConfig(): WorkflowConfig {
	const { _ } = useLingui()
	return useMemo(() => buildTenantConfig(_), [_])
}

export function useLocalizedPlatformWorkflowConfig(): WorkflowConfig {
	const { _ } = useLingui()
	return useMemo(() => buildPlatformConfig(_), [_])
}

export const DELAY_UNIT_MSGS: Record<string, ReturnType<typeof msg>> = {
	minutes: msg`minutes`,
	hours: msg`hours`,
	days: msg`days`,
	weeks: msg`weeks`,
}

export const JOURNEY_STATUS_MSGS: Record<string, ReturnType<typeof msg>> = {
	draft: msg`draft`,
	active: msg`active`,
	paused: msg`paused`,
	archived: msg`archived`,
}

export const CONDITION_FIELD_MSGS: Record<string, ReturnType<typeof msg>> = {
	email: msg`Email Address`,
	phone: msg`Phone Number`,
	phoneVerified: msg`Phone Verification Status`,
	name: msg`Name`,
	tags: msg`Tags`,
	planName: msg`Plan Name`,
}

export function useWorkflowUiLabels() {
	const { _ } = useLingui()
	return useMemo(
		() => ({
			delayUnitLabel: (unit: string) =>
				_(DELAY_UNIT_MSGS[unit] ?? msg`${unit}`),
			journeyStatusLabel: (status: string) =>
				_(JOURNEY_STATUS_MSGS[status] ?? msg`${status}`),
			conditionFieldLabel: (field: string) =>
				_(CONDITION_FIELD_MSGS[field] ?? msg`${field}`),
		}),
		[_],
	)
}
