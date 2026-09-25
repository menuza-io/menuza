/**
 * Centralized brand configuration for all apps
 * Change these values once to update across the entire monorepo
 */

export function toBrandSlug(name: string) {
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
	let start = 0
	let end = slug.length
	while (start < end && slug.charCodeAt(start) === 45) start += 1
	while (end > start && slug.charCodeAt(end - 1) === 45) end -= 1
	return slug.slice(start, end) || 'app'
}

export const brand = {
	// Core brand identity
	name: 'Menuza',
	shortName: 'menuza',
	slug: 'menuza',
	domain: 'menuza.io',
	tagline: 'Shopify for Restaurants',
	description: 'Restaurant OS for SMB Restaurant owners',

	// URLs
	url: 'https://menuza.io',
	supportEmail: 'support@menuza.io',

	// Social/Meta
	twitterHandle: '@getmenuza',

	// Legal
	companyName: 'Menuza',
	copyrightYear: new Date().getFullYear(),

	// Product-specific descriptions
	products: {
		app: {
			name: 'Menuza',
			description: "Your own captain's log",
			tagline: 'Comprehensive note-taking and organization management platform',
		},
		admin: {
			name: 'Menuza Admin',
			description: 'Admin dashboard for Menuza',
		},
		web: {
			name: 'Menuza',
			description:
				'Modern SaaS boilerplate that helps developers and founders launch production-ready applications in minutes.',
		},
		extension: {
			name: 'Menuza Extension',
			chrome: 'Menuza Chrome Extension',
			firefox: 'Menuza Firefox Extension',
			description: 'Chrome extension for Menuza',
		},
		cms: {
			name: 'Menuza CMS',
			description: 'Content management system for Menuza',
		},
		sites: {
			name: 'Menuza Sites',
			description: 'Public organization websites',
		},
	},

	// Email subjects
	email: {
		passwordReset: 'Menuza Password Reset',
		welcome: 'Welcome to Menuza!',
		emailChange: 'Menuza Email Change Verification',
		newDeviceSignin: 'New Sign-In Detected - Menuza',
	},

	// AI Assistant configuration
	ai: {
		systemPrompt:
			'You are an intelligent AI assistant for Menuza, a comprehensive note-taking and organization management platform. You specialize in helping users maximize their productivity and collaboration through smart note management.',
	},
} as const

export const getBrandDomain = () => brand.domain

/**
 * Reserved, non-public hostname used by the local HTTPS development proxy.
 * Keep this derived from the brand slug so local setup can never shadow the
 * production domain in /etc/hosts.
 */
export const getLocalDomain = () => `${brand.slug}.test`

export const getBrandTeam = () => `The ${brand.name} Team`

export const getIntegrationUserAgent = () => `${brand.slug}-Integration/1.0`

export const getMcpServerName = () => `${brand.slug}-mcp`

// Helper to generate page titles
export const getPageTitle = (page?: string) => {
	if (!page) return brand.name
	return `${page} | ${brand.name}`
}

// Helper for error titles
export const getErrorTitle = () => `Error | ${brand.name}`

// Helper for copyright text
export const getCopyright = () =>
	`© ${brand.copyrightYear} ${brand.companyName}. All rights reserved.`
