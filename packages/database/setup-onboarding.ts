import { db, OnboardingStep } from './db.server'

// Default onboarding steps to seed the database
export const DEFAULT_ONBOARDING_STEPS = [
	{
		key: 'create_first_note',
		title: 'Create your first note',
		description: 'Start documenting your ideas and thoughts',
		icon: 'file-text',
		actionConfig: {
			type: 'navigate' as const,
			target: '/notes/new',
			label: 'Create Note',
		},
		autoDetect: true,
		detectConfig: {
			condition: 'hasNotes',
		},
		sortOrder: 2,
	},
	{
		key: 'invite_members',
		title: 'Invite team members',
		description: 'Collaborate with your team by inviting members',
		icon: 'user-plus',
		actionConfig: {
			type: 'navigate' as const,
			target: '/settings/members',
			label: 'Invite Members',
		},
		autoDetect: true,
		detectConfig: {
			condition: 'hasMembersInvited',
		},
		sortOrder: 3,
	},
	{
		key: 'complete_profile',
		title: 'Set up your organization profile',
		description: 'Update your organization name and settings',
		icon: 'user',
		actionConfig: {
			type: 'navigate' as const,
			target: '/settings',
			label: 'Complete Profile',
		},
		autoDetect: true,
		detectConfig: {
			condition: 'hasCompletedProfile',
		},
		sortOrder: 1,
	},
	{
		key: 'try_ai_chat',
		title: 'Try the AI chat feature',
		description:
			'Experience AI-powered assistance for your notes (auto-completes when you use AI)',
		icon: 'sparkles',
		actionConfig: {
			type: 'navigate' as const,
			target: '/notes',
			label: 'Go to Notes',
		},
		autoDetect: true,
		detectConfig: {
			condition: 'hasUsedAiChat',
		},
		sortOrder: 4,
	},
	{
		key: 'explore_command_menu',
		title: 'Explore the command menu',
		description: 'Use Cmd/Ctrl + K to quickly navigate and perform actions',
		icon: 'command',
		actionConfig: {
			type: 'modal' as const,
			target: 'command-menu',
			label: 'Open Command Menu',
		},
		autoDetect: false, // This will be manually tracked when command menu opens
		detectConfig: {
			condition: 'hasUsedCommandMenu',
		},
		sortOrder: 5,
	},
	{
		key: 'connect_integration',
		title: 'Connect integrations',
		description: 'Enhance your workflow with third-party integrations',
		icon: 'blocks',
		actionConfig: {
			type: 'navigate' as const,
			target: '/settings/integrations',
			label: 'View Integrations',
		},
		autoDetect: true,
		detectConfig: {
			condition: 'hasIntegrations',
		},
		sortOrder: 6,
	},
	{
		key: 'connect_pos',
		title: 'Connect your POS',
		description:
			'Connect Clover, Square, Toast, Uber Eats or DoorDash to sync your menu (completes when a platform is connected)',
		icon: 'plug',
		actionConfig: {
			type: 'navigate' as const,
			target: '/settings/integrations',
			label: 'Connect POS',
		},
		autoDetect: true,
		detectConfig: {
			condition: 'hasPosIntegration',
		},
		sortOrder: 7,
	},
]

// Initialize onboarding steps in database
export async function initializeOnboardingSteps() {
	for (const step of DEFAULT_ONBOARDING_STEPS) {
		const values = {
			key: step.key,
			title: step.title,
			description: step.description,
			actionConfig: JSON.stringify(step.actionConfig),
			icon: step.icon,
			autoDetect: step.autoDetect,
			detectConfig: step.detectConfig
				? JSON.stringify(step.detectConfig)
				: null,
			sortOrder: step.sortOrder,
		}

		await db
			.insert(OnboardingStep)
			.values(values)
			.onConflictDoUpdate({
				target: OnboardingStep.key,
				set: {
					title: step.title,
					description: step.description,
					actionConfig: JSON.stringify(step.actionConfig),
					icon: step.icon,
					autoDetect: step.autoDetect,
					detectConfig: step.detectConfig
						? JSON.stringify(step.detectConfig)
						: null,
					sortOrder: step.sortOrder,
				},
			})
	}
}
