/**
 * Navigable UI destinations for the AI assistant.
 *
 * React Router file routes also include APIs, resources, auth callbacks, and
 * parameterized editors (notes.$noteId, pages.$pageId). Dumping that full tree
 * into the model would be noisy and unsafe. This catalog is the AI-facing
 * subset: the same screens the sidebar and command menu expose. Path templates
 * match remix-flat-routes under `apps/app/app/routes/_app+`.
 *
 * `:orgSlug` is the organization slug route param.
 */
export type AppNavRoute = {
	id: string
	title: string
	aliases: string[]
	description: string
	/** Path template. `:orgSlug` is replaced with the current organization. */
	path: string
	requiresOrg: boolean
}

export type AppLocationContext = {
	currentPath: string | null
	orgSlug: string | null
	params: Record<string, string>
}

export const APP_NAV_ROUTES: readonly AppNavRoute[] = [
	{
		id: 'dashboard',
		title: 'Dashboard',
		aliases: ['home', 'org home', 'organization home'],
		description: 'Organization dashboard / home',
		path: '/:orgSlug',
		requiresOrg: true,
	},
	{
		id: 'reports',
		title: 'Reports',
		aliases: ['analytics', 'report list'],
		description: 'Organization reports',
		path: '/:orgSlug/reports',
		requiresOrg: true,
	},
	{
		id: 'notes',
		title: 'Notes',
		aliases: ['note list', 'all notes'],
		description: 'Organization notes list',
		path: '/:orgSlug/notes',
		requiresOrg: true,
	},
	{
		id: 'notes-new',
		title: 'New note',
		aliases: ['create note', 'add note'],
		description: 'Create a new note',
		path: '/:orgSlug/notes/new',
		requiresOrg: true,
	},
	{
		id: 'media',
		title: 'Media library',
		aliases: ['media', 'images', 'image library', 'assets'],
		description: 'Reusable organization image library',
		path: '/:orgSlug/media',
		requiresOrg: true,
	},
	{
		id: 'customers',
		title: 'Customers',
		aliases: ['customer list', 'contacts'],
		description: 'Organization customers',
		path: '/:orgSlug/customers',
		requiresOrg: true,
	},
	{
		id: 'marketing',
		title: 'Marketing',
		aliases: ['marketing overview'],
		description: 'Marketing overview',
		path: '/:orgSlug/marketing',
		requiresOrg: true,
	},
	{
		id: 'marketing-campaigns',
		title: 'Broadcasts',
		aliases: ['campaigns', 'marketing campaigns', 'email campaigns'],
		description: 'Marketing broadcasts / campaigns',
		path: '/:orgSlug/marketing/campaigns',
		requiresOrg: true,
	},
	{
		id: 'marketing-automations',
		title: 'Automations',
		aliases: ['journeys', 'marketing automations'],
		description: 'Marketing automations / journeys',
		path: '/:orgSlug/marketing/automations',
		requiresOrg: true,
	},
	{
		id: 'website',
		title: 'Website settings',
		aliases: ['site settings', 'website general'],
		description: 'Website general settings',
		path: '/:orgSlug/website',
		requiresOrg: true,
	},
	{
		id: 'website-pages',
		title: 'Website pages',
		aliases: ['pages', 'page list', 'cms pages'],
		description:
			'Website page list. To edit a specific page, use navigateToPage with that page ID.',
		path: '/:orgSlug/website/pages',
		requiresOrg: true,
	},
	{
		id: 'website-announcements',
		title: 'Announcements',
		aliases: ['site announcements'],
		description: 'Website announcements',
		path: '/:orgSlug/website/announcements',
		requiresOrg: true,
	},
	{
		id: 'org-settings',
		title: 'Organization settings',
		aliases: [
			'settings',
			'org settings',
			'organization settings',
			'general settings',
		],
		description: 'Organization general settings',
		path: '/:orgSlug/settings',
		requiresOrg: true,
	},
	{
		id: 'org-settings-members',
		title: 'Members',
		aliases: ['team', 'invite', 'people', 'organization members'],
		description: 'Organization members and invitations',
		path: '/:orgSlug/settings/members',
		requiresOrg: true,
	},
	{
		id: 'org-settings-integrations',
		title: 'Integrations',
		aliases: ['apps', 'connected apps'],
		description: 'Organization integrations',
		path: '/:orgSlug/settings/integrations',
		requiresOrg: true,
	},
	{
		id: 'org-settings-shop',
		title: 'Shop',
		aliases: ['store', 'commerce', 'shop settings'],
		description: 'Organization shop settings',
		path: '/:orgSlug/settings/shop',
		requiresOrg: true,
	},
	{
		id: 'org-mcp',
		title: 'MCP Server',
		aliases: ['mcp', 'model context protocol'],
		description: 'Organization MCP server settings',
		path: '/:orgSlug/mcp',
		requiresOrg: true,
	},
	{
		id: 'org-settings-notifications',
		title: 'Organization notifications',
		aliases: ['notification settings', 'org notifications'],
		description: 'Organization notification settings',
		path: '/:orgSlug/settings/notifications',
		requiresOrg: true,
	},
	{
		id: 'org-settings-billing',
		title: 'Billing',
		aliases: ['plans', 'subscription', 'upgrade', 'billing settings'],
		description: 'Organization billing and plans',
		path: '/:orgSlug/settings/billing',
		requiresOrg: true,
	},
	{
		id: 'account-profile',
		title: 'Account settings',
		aliases: ['profile', 'my profile', 'account'],
		description: 'Personal profile and account settings',
		path: '/profile',
		requiresOrg: false,
	},
	{
		id: 'account-security',
		title: 'Security',
		aliases: ['password', '2fa', 'passkeys', 'account security'],
		description: 'Personal security settings',
		path: '/security',
		requiresOrg: false,
	},
	{
		id: 'account-organizations',
		title: 'Organizations',
		aliases: ['switch organization', 'my organizations'],
		description: 'List of organizations the user belongs to',
		path: '/organizations',
		requiresOrg: false,
	},
]

const ROUTES_BY_ID = new Map(APP_NAV_ROUTES.map((route) => [route.id, route]))

export function getNavigableAppRoutes(options?: {
	includeBilling?: boolean
}): AppNavRoute[] {
	const includeBilling = options?.includeBilling ?? true
	if (includeBilling) return [...APP_NAV_ROUTES]
	return APP_NAV_ROUTES.filter((route) => route.id !== 'org-settings-billing')
}

export function getAppNavRoute(routeId: string): AppNavRoute | undefined {
	return ROUTES_BY_ID.get(routeId)
}

export type ResolveAppNavResult =
	{ ok: true; path: string; route: AppNavRoute } | { ok: false; error: string }

export function resolveAppNavPath(
	routeId: string,
	params: { orgSlug?: string | null },
): ResolveAppNavResult {
	const route = ROUTES_BY_ID.get(routeId)
	if (!route) {
		return {
			ok: false,
			error: `Unknown route id "${routeId}". Use an id from the app navigation list.`,
		}
	}

	if (route.requiresOrg) {
		const orgSlug = params.orgSlug?.trim()
		if (!orgSlug) {
			return {
				ok: false,
				error: `Route "${route.title}" needs the current organization slug.`,
			}
		}
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(orgSlug)) {
			return {
				ok: false,
				error: 'Invalid organization slug.',
			}
		}
		return {
			ok: true,
			path: route.path.replaceAll(':orgSlug', orgSlug),
			route,
		}
	}

	return { ok: true, path: route.path, route }
}

export function formatAppNavRoutesForPrompt(
	routes: Array<{
		id: string
		title: string
		aliases?: string[]
		description: string
		path: string
	}>,
): string {
	return routes
		.map((route) => {
			const aliases =
				route.aliases && route.aliases.length > 0
					? ` aliases: ${route.aliases.join(', ')}`
					: ''
			return `- ${route.id} — ${route.title} (${route.path})${aliases}. ${route.description}`
		})
		.join('\n')
}

export function formatAppLocationForPrompt(
	location: AppLocationContext,
): string {
	const paramEntries = Object.entries(location.params)
	const paramsLine =
		paramEntries.length > 0
			? paramEntries.map(([key, value]) => `${key}=${value}`).join(', ')
			: 'none'

	return `Current location: ${location.currentPath || 'unknown'}
Current organization slug (orgSlug): ${location.orgSlug || 'none'}
Route params: ${paramsLine}`
}

export function buildNavigationSystemPrompt(
	basePrompt: string,
	ctx: {
		location: AppLocationContext
		routes: Array<{
			id: string
			title: string
			aliases?: string[]
			description: string
			path: string
		}>
	},
): string {
	return `${basePrompt}

## App navigation
${formatAppLocationForPrompt(ctx.location)}

You can take the user to any of these screens with the navigateToAppPage tool. Pass the route id. The current orgSlug is filled in automatically — do not invent a different organization.

${formatAppNavRoutesForPrompt(ctx.routes)}

Use navigateToAppPage for app screens (settings, notes, marketing, profile, and so on).
Use navigateToPage only to open a specific website CMS page in the page editor (by website page ID from the website pages list).`
}
