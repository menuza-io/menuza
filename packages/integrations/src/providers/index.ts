/**
 * Integration providers registry and initialization
 */

import { providerRegistry, registerDefaultInitializer } from '../provider'
import { createPosProviders } from '../pos/providers'
import { SlackProvider } from './slack/provider'
import { JiraProvider } from './jira/provider'
import { LinearProvider } from './linear/provider'
import { GitLabProvider } from './gitlab/provider'
import { ClickUpProvider } from './clickup/provider'
import { NotionProvider } from './notion/provider'
import { AsanaProvider } from './asana/provider'
import { TrelloProvider } from './trello/provider'
import { GitHubProvider } from './github/provider'
import { GoogleBusinessProfileProvider } from './google-business-profile/provider'
import { YelpProvider } from './yelp/provider'
import { TripAdvisorProvider } from './tripadvisor/provider'
import { DeliverooProvider } from './deliveroo/provider'
import { JustEatProvider } from './just-eat/provider'
import { OpenTableProvider } from './opentable/provider'

/**
 * Initialize and register all available integration providers
 */
export function initializeProviders(): void {
	// Register Slack provider
	providerRegistry.register(new SlackProvider())

	// Register Jira provider
	providerRegistry.register(new JiraProvider())

	// Register Linear provider
	providerRegistry.register(new LinearProvider())

	// Register GitLab provider
	providerRegistry.register(new GitLabProvider())

	// Register ClickUp provider
	providerRegistry.register(new ClickUpProvider())

	// Register Notion provider
	providerRegistry.register(new NotionProvider())

	// Register Asana provider
	providerRegistry.register(new AsanaProvider())

	// Register Trello provider
	providerRegistry.register(new TrelloProvider())

	// Register GitHub provider
	providerRegistry.register(new GitHubProvider())
	providerRegistry.register(new GoogleBusinessProfileProvider())
	providerRegistry.register(new YelpProvider())
	providerRegistry.register(new TripAdvisorProvider())
	providerRegistry.register(new DeliverooProvider())
	providerRegistry.register(new JustEatProvider())
	providerRegistry.register(new OpenTableProvider())

	// Register POS and delivery providers
	for (const provider of createPosProviders()) {
		providerRegistry.register(provider)
	}

	// Future providers can be registered here
	// providerRegistry.register(new TeamsProvider())
}

registerDefaultInitializer(initializeProviders)

/**
 * Get the POS and delivery providers shown on the integrations page.
 *
 * The note/productivity providers above are intentionally omitted: this app
 * connects menus to point-of-sale and delivery platforms.
 */
export function getAvailablePosProviders() {
	return createPosProviders().map((provider) => ({
		name: provider.name,
		type: provider.type,
		kind: provider.kind,
		displayName: provider.displayName,
		description: provider.description,
		icon: provider.icon,
		writeMode: provider.writeMode,
		logoPath: provider.logoPath,
	}))
}

/**
 * Get all available providers for display in UI
 */
export function getAvailableProviders() {
	return [
		{
			name: 'slack',
			type: 'productivity',
			displayName: 'Slack',
			description: 'Connect notes to Slack channels for team collaboration',
			icon: 'slack',
		},
		{
			name: 'jira',
			type: 'productivity',
			displayName: 'Jira',
			description:
				'Connect notes to Jira projects for issue tracking and project management',
			icon: 'jira',
		},
		{
			name: 'linear',
			type: 'productivity',
			displayName: 'Linear',
			description:
				'Connect notes to Linear teams and projects for issue tracking and project management',
			icon: 'linear',
		},
		{
			name: 'gitlab',
			type: 'productivity',
			displayName: 'GitLab',
			description:
				'Connect notes to GitLab projects for issue tracking and project management',
			icon: 'gitlab',
		},
		{
			name: 'clickup',
			type: 'productivity',
			displayName: 'ClickUp',
			description:
				'Connect notes to ClickUp spaces and lists for task management',
			icon: 'clickup',
		},
		{
			name: 'notion',
			type: 'productivity',
			displayName: 'Notion',
			description:
				'Connect notes to Notion databases for knowledge management and collaboration',
			icon: 'notion',
		},
		{
			name: 'asana',
			type: 'productivity',
			displayName: 'Asana',
			description:
				'Connect notes to Asana projects for task management and team collaboration',
			icon: 'asana',
		},
		{
			name: 'trello',
			type: 'productivity',
			displayName: 'Trello',
			description:
				'Connect notes to Trello boards for task management and project organization',
			icon: 'trello',
		},
		{
			name: 'github',
			type: 'productivity',
			displayName: 'GitHub',
			description:
				'Connect notes to GitHub repositories for issue tracking and project management',
			icon: 'github',
		},
	]
}

// Initialize providers when module is loaded
initializeProviders()

// Re-export providers for convenience
export { SlackProvider }
export { JiraProvider }
export { LinearProvider }
export { GitLabProvider }
export { ClickUpProvider }
export { NotionProvider }
export { AsanaProvider }
export { TrelloProvider }
export { GitHubProvider }
export { GoogleBusinessProfileProvider }
export { YelpProvider }
export { TripAdvisorProvider }
export { DeliverooProvider }
export { JustEatProvider }
export { OpenTableProvider }
export {
	getAvailableReviewProviders,
	listUnifiedReviews,
	replyToUnifiedReview,
	type UnifiedReview,
	type UnifiedReviewPageTokens,
	type ReviewProviderDisplayInfo,
} from './unified-reviews'
export {
	CloverProvider,
	DoorDashProvider,
	SquareProvider,
	ToastProvider,
	UberEatsProvider,
	createPosProviders,
} from '../pos/providers'
export { providerRegistry } from '../provider'
