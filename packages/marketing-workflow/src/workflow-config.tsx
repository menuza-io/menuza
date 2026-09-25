import {
	type WorkflowGraph,
	type JourneyTriggerType,
} from '@repo/tenant-db/types/journey'
import React, { createContext, useContext, type ReactNode } from 'react'
import { type PaletteItem } from './types.ts'
import { createDefaultTenantJourneyGraph } from './serialization.ts'

export type WorkflowAudience = 'tenant' | 'platform'

export interface TriggerOption {
	value: string
	label: string
	description?: string
}

export interface WorkflowConfig {
	audience: WorkflowAudience
	triggerLabels: Record<string, { label: string; desc: string }>
	triggerOptions: TriggerOption[]
	paletteItems: PaletteItem[]
	defaultGraph: () => WorkflowGraph
	mergeTagHint: string
	subjectEntityLabel: string
}

const TENANT_TRIGGER_LABELS: Record<string, { label: string; desc: string }> = {
	phone_verified: {
		label: 'Phone Verified',
		desc: 'Runs when customer verifies phone OTP',
	},
	profile_completed: {
		label: 'Profile Completed',
		desc: 'Runs when customer updates name/email',
	},
	custom_event: {
		label: 'Custom Event',
		desc: 'Runs when custom event triggers',
	},
	manual: {
		label: 'Manual Trigger',
		desc: 'Triggered via operator test or API',
	},
}

const TENANT_TRIGGER_OPTIONS: TriggerOption[] = [
	{ value: 'phone_verified', label: 'Phone Verified (OTP Success)' },
	{ value: 'profile_completed', label: 'Profile Completed (Name/Email)' },
	{ value: 'custom_event', label: 'Custom Event' },
	{ value: 'manual', label: 'Manual Trigger' },
]

const PLATFORM_TRIGGER_LABELS: Record<string, { label: string; desc: string }> =
	{
		org_created: {
			label: 'Organization Created',
			desc: 'Runs when a new tenant organization is created',
		},
		operator_invited: {
			label: 'Operator Invited',
			desc: 'Runs when an operator is invited to an organization',
		},
		subscription_started: {
			label: 'Subscription Started',
			desc: 'Runs when a tenant starts a paid subscription',
		},
		subscription_cancelled: {
			label: 'Subscription Cancelled',
			desc: 'Runs when a tenant cancels their subscription',
		},
		manual: {
			label: 'Manual Trigger',
			desc: 'Triggered via admin test or API',
		},
	}

const PLATFORM_TRIGGER_OPTIONS: TriggerOption[] = Object.entries(
	PLATFORM_TRIGGER_LABELS,
).map(([value, meta]) => ({
	value,
	label: meta.label,
	description: meta.desc,
}))

const BASE_PALETTE_ITEMS: Omit<PaletteItem, 'defaultData'>[] = [
	{
		type: 'trigger',
		label: 'Trigger Event',
		description: 'Start journey on lifecycle event',
		icon: 'play',
		color: 'text-muted-foreground ',
	},
	{
		type: 'delay',
		label: 'Time Delay',
		description: 'Wait for a specified duration before next step',
		icon: 'clock',
		color: 'text-muted-foreground ',
	},
	{
		type: 'action_email',
		label: 'Send Email',
		description: 'Dispatch personalized email with merge tags',
		icon: 'mail',
		color: 'text-muted-foreground ',
	},
	{
		type: 'action_sms',
		label: 'Send SMS',
		description: 'Dispatch text message with merge tags',
		icon: 'smartphone',
		color: 'text-muted-foreground ',
		isGated: true,
	},
	{
		type: 'condition',
		label: 'Condition Branch',
		description: 'Split path based on rules (True / False)',
		icon: 'split',
		color: 'text-muted-foreground ',
	},
]

function createTenantPaletteItems(): PaletteItem[] {
	return [
		{
			...BASE_PALETTE_ITEMS[0]!,
			defaultData: {
				triggerType: 'phone_verified' as JourneyTriggerType,
				config: {},
			},
		},
		{
			...BASE_PALETTE_ITEMS[1]!,
			defaultData: { duration: 1, unit: 'hours' as const },
		},
		{
			...BASE_PALETTE_ITEMS[2]!,
			defaultData: {
				subject: 'Your Exclusive Update',
				bodyHtml: '<p>Hi {{name}},</p><p>Check out our latest update.</p>',
				bodyText: 'Hi {{name}}, Check out our latest update.',
				fromName: 'Team',
			},
		},
		{
			...BASE_PALETTE_ITEMS[3]!,
			defaultData: {
				messageText: 'Hi {{name}}, your account update is ready!',
			},
		},
		{
			...BASE_PALETTE_ITEMS[4]!,
			defaultData: {
				field: 'tags',
				operator: 'contains' as const,
				value: 'VIP',
			},
		},
	]
}

function createPlatformPaletteItems(): PaletteItem[] {
	return [
		{
			...BASE_PALETTE_ITEMS[0]!,
			defaultData: { triggerType: 'org_created' as never, config: {} },
		},
		{
			...BASE_PALETTE_ITEMS[1]!,
			defaultData: { duration: 1, unit: 'days' as const },
		},
		{
			...BASE_PALETTE_ITEMS[2]!,
			defaultData: {
				subject: 'Welcome to Menuza, {{organizationName}}',
				bodyHtml:
					'<p>Hi {{name}},</p><p>Your organization {{organizationName}} is ready.</p>',
				bodyText:
					'Hi {{name}}, Your organization {{organizationName}} is ready.',
				fromName: 'Menuza Team',
			},
		},
		{
			...BASE_PALETTE_ITEMS[3]!,
			defaultData: {
				messageText: 'Hi {{name}}, your Menuza account is ready.',
			},
		},
		{
			...BASE_PALETTE_ITEMS[4]!,
			defaultData: {
				field: 'planName',
				operator: 'equals' as const,
				value: 'pro',
			},
		},
	]
}

export function createDefaultPlatformJourneyGraph(): WorkflowGraph {
	return {
		nodes: [
			{
				id: 'node_trigger_1',
				type: 'trigger',
				position: { x: 250, y: 50 },
				data: { triggerType: 'org_created' as never, config: {} },
			},
			{
				id: 'node_delay_1',
				type: 'delay',
				position: { x: 250, y: 220 },
				data: { duration: 1, unit: 'days' },
			},
			{
				id: 'node_email_1',
				type: 'action_email',
				position: { x: 250, y: 390 },
				data: {
					subject: 'Welcome to Menuza, {{organizationName}}',
					bodyHtml:
						'<p>Hi {{name}},</p><p>Your organization is ready to go.</p>',
					bodyText: 'Hi {{name}}, Your organization is ready to go.',
					fromName: 'Menuza Team',
				},
			},
		],
		edges: [
			{
				id: 'edge_1',
				source: 'node_trigger_1',
				target: 'node_delay_1',
				sourceHandle: 'output',
				targetHandle: 'input',
			},
			{
				id: 'edge_2',
				source: 'node_delay_1',
				target: 'node_email_1',
				sourceHandle: 'output',
				targetHandle: 'input',
			},
		],
		viewport: { x: 0, y: 0, zoom: 1 },
	}
}

export const TENANT_WORKFLOW_CONFIG: WorkflowConfig = {
	audience: 'tenant',
	triggerLabels: TENANT_TRIGGER_LABELS,
	triggerOptions: TENANT_TRIGGER_OPTIONS,
	paletteItems: createTenantPaletteItems(),
	defaultGraph: createDefaultTenantJourneyGraph,
	mergeTagHint: '{{name}}, {{email}}, {{phone}}',
	subjectEntityLabel: 'customer',
}

export const PLATFORM_WORKFLOW_CONFIG: WorkflowConfig = {
	audience: 'platform',
	triggerLabels: PLATFORM_TRIGGER_LABELS,
	triggerOptions: PLATFORM_TRIGGER_OPTIONS,
	paletteItems: createPlatformPaletteItems(),
	defaultGraph: createDefaultPlatformJourneyGraph,
	mergeTagHint: '{{name}}, {{email}}, {{organizationName}}',
	subjectEntityLabel: 'operator',
}

const WorkflowConfigContext = createContext<WorkflowConfig>(
	TENANT_WORKFLOW_CONFIG,
)

export function WorkflowConfigProvider({
	config,
	children,
}: {
	config: WorkflowConfig
	children: ReactNode
}) {
	return (
		<WorkflowConfigContext.Provider value={config}>
			{children}
		</WorkflowConfigContext.Provider>
	)
}

export function useWorkflowConfig() {
	return useContext(WorkflowConfigContext)
}
