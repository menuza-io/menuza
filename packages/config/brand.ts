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
	name: 'Epic Startup',
	shortName: 'Epic Startup',
	slug: 'epic-startup',
	domain: 'epic-startup.com',
	tagline: 'Build your next startup even faster',
	description:
		'Epic Startup is a modern SaaS boilerplate that helps developers and founders launch production-ready applications in minutes.',

	// URLs
	url: 'https://epic-startup.com',
	supportEmail: 'support@epic-startup.com',

	// Social/Meta
	twitterHandle: '@epicstartup',

	// Legal
	companyName: 'Epic Startup',
	get copyrightYear() {
		return new Date().getFullYear()
	},

	// Product-specific descriptions
	products: {
		app: {
			name: 'Epic Startup',
			description: "Your own captain's log",
			tagline: 'Comprehensive note-taking and organization management platform',
		},
		admin: {
			name: 'Epic Startup Admin',
			description: 'Admin dashboard for Epic Startup',
		},
		web: {
			name: 'Epic Startup',
			description:
				'Modern SaaS boilerplate that helps developers and founders launch production-ready applications in minutes.',
		},
		extension: {
			name: 'Epic Startup Extension',
			chrome: 'Epic Startup Chrome Extension',
			firefox: 'Epic Startup Firefox Extension',
			description: 'Chrome extension for Epic Startup',
		},
		cms: {
			name: 'Epic Startup CMS',
			description: 'Content management system for Epic Startup',
		},
		sites: {
			name: 'Epic Startup Sites',
			description: 'Public organization websites',
		},
	},

	// Email subjects
	email: {
		passwordReset: 'Epic Startup Password Reset',
		welcome: 'Welcome to Epic Startup!',
		emailChange: 'Epic Startup Email Change Verification',
		newDeviceSignin: 'New Sign-In Detected - Epic Startup',
	},

	// AI Assistant configuration
	ai: {
		systemPrompt:
			'You are an intelligent AI assistant for Epic Startup, a comprehensive note-taking and organization management platform. You specialize in helping users maximize their productivity and collaboration through smart note management.',
	},
}

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
