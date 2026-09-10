import { z } from 'zod'
import { ENV } from './package-env.js'

// Provider name validation
export const ProviderNameSchema = z
	.string()
	.min(1, 'Provider name is required')
	.max(100, 'Provider name must be less than 100 characters')
	.regex(/^[a-zA-Z0-9\s\-_.]+$/, 'Provider name contains invalid characters')

// URL validation for OIDC endpoints
export const UrlSchema = z
	.string()
	.url('Must be a valid URL')
	.refine((url) => {
		try {
			const parsed = new URL(url)
			return (
				parsed.protocol === 'https:' ||
				(ENV.NODE_ENV === 'development' && parsed.protocol === 'http:')
			)
		} catch {
			return false
		}
	}, 'URL must use HTTPS (or HTTP in development)')

// Client ID validation
export const ClientIdSchema = z
	.string()
	.min(1, 'Client ID is required')
	.max(255, 'Client ID must be less than 255 characters')
	.regex(/^[a-zA-Z0-9\-_.~]+$/, 'Client ID contains invalid characters')

// Client secret validation
export const ClientSecretSchema = z
	.string()
	.min(1, 'Client secret is required')
	.max(1000, 'Client secret must be less than 1000 characters')

// Scopes validation
export const ScopesSchema = z
	.string()
	.min(1, 'Scopes are required')
	.max(500, 'Scopes must be less than 500 characters')
	.refine((scopes) => {
		const scopeList = scopes.split(' ').filter((s) => s.length > 0)
		return (
			scopeList.length > 0 &&
			scopeList.every((scope) => /^[a-zA-Z0-9\-_./:]+$/.test(scope))
		)
	}, 'Invalid scope format')
	.refine((scopes) => {
		return scopes.includes('openid')
	}, 'OpenID scope is required for OIDC')

// Role validation
export const RoleSchema = z.enum(['admin', 'member', 'viewer'], {
	errorMap: () => ({ message: 'Role must be admin, member, or viewer' }),
})

// Attribute mapping validation
export const AttributeMappingSchema = z
	.string()
	.optional()
	.nullable()
	.refine((value) => {
		if (!value || value.trim() === '') return true
		try {
			const parsed = JSON.parse(value)
			// Must be an object
			if (
				typeof parsed !== 'object' ||
				Array.isArray(parsed) ||
				parsed === null
			) {
				return false
			}
			// Validate mapping keys and values
			for (const [key, val] of Object.entries(parsed)) {
				if (typeof key !== 'string' || typeof val !== 'string') {
					return false
				}
				// Key should be valid user attribute
				if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
					return false
				}
				// Value should be valid OIDC claim
				if (!/^[a-zA-Z][a-zA-Z0-9_.:/-]*$/.test(val)) {
					return false
				}
			}
			// Limit number of mappings
			if (Object.keys(parsed).length > 20) {
				return false
			}
			return true
		} catch {
			return false
		}
	}, 'Invalid attribute mapping JSON format')
	.transform((value) => {
		if (!value || value.trim() === '') return null
		try {
			const parsed = JSON.parse(value)
			// Sanitize and normalize the mapping
			const sanitized: Record<string, string> = {}
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				for (const [key, val] of Object.entries(parsed)) {
					if (typeof key === 'string' && typeof val === 'string') {
						sanitized[key.trim()] = val.trim()
					}
				}
			}
			return JSON.stringify(sanitized)
		} catch {
			return null
		}
	})

// Main SSO configuration schema
// Email domain validation (comma-separated domains)
const EmailDomainsSchema = z
	.string()
	.optional()
	.nullable()
	.refine(
		(val) => {
			if (!val) return true
			const domains = val.split(',').map((d) => d.trim())
			const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}$/
			return domains.every((d) => domainRegex.test(d))
		},
		{
			message:
				'Invalid email domain format. Use comma-separated domains like: example.com, company.org',
		},
	)

export const SSOConfigurationSchema = z.object({
	providerName: ProviderNameSchema,
	issuerUrl: UrlSchema,
	clientId: ClientIdSchema,
	clientSecret: ClientSecretSchema,
	scopes: ScopesSchema,
	autoDiscovery: z.boolean().default(true),
	pkceEnabled: z.boolean().default(true),
	autoProvision: z.boolean().default(false),
	defaultRole: RoleSchema.default('member'),
	attributeMapping: AttributeMappingSchema,
	authorizationUrl: UrlSchema.optional().nullable(),
	tokenUrl: UrlSchema.optional().nullable(),
	userinfoUrl: UrlSchema.optional().nullable(),
	revocationUrl: UrlSchema.optional().nullable(),
	requireVerifiedEmail: z.boolean().default(false),
	allowedEmailDomains: EmailDomainsSchema,
	enforceSSOLogin: z.boolean().default(false),
})

// Update schema (all fields optional except id)
export const SSOConfigurationUpdateSchema = z.object({
	id: z.string().uuid(),
	providerName: ProviderNameSchema.optional(),
	issuerUrl: UrlSchema.optional(),
	clientId: ClientIdSchema.optional(),
	clientSecret: ClientSecretSchema.optional(),
	scopes: ScopesSchema.optional(),
	autoDiscovery: z.boolean().optional(),
	pkceEnabled: z.boolean().optional(),
	autoProvision: z.boolean().optional(),
	defaultRole: RoleSchema.optional(),
	attributeMapping: AttributeMappingSchema.optional(),
	authorizationUrl: UrlSchema.optional().nullable(),
	tokenUrl: UrlSchema.optional().nullable(),
	userinfoUrl: UrlSchema.optional().nullable(),
	revocationUrl: UrlSchema.optional().nullable(),
	requireVerifiedEmail: z.boolean().optional(),
	allowedEmailDomains: EmailDomainsSchema.optional(),
	enforceSSOLogin: z.boolean().optional(),
})

// Connection test schema
export const SSOConnectionTestSchema = z.object({
	issuerUrl: UrlSchema,
	clientId: ClientIdSchema,
	clientSecret: ClientSecretSchema,
})

// Auth request schema
export const SSOAuthRequestSchema = z.object({
	organizationSlug: z.string().min(1),
	redirectTo: z.string().optional(),
})

// Callback schema
export const SSOCallbackSchema = z.object({
	code: z.string().min(1).optional(),
	state: z.string().min(1),
	organizationSlug: z.string().min(1),
	error: z.string().optional(),
	error_description: z.string().optional(),
})

// OIDC User Info schema
export const OIDCUserInfoSchema = z.object({
	sub: z.string(),
	email: z.string().email().optional(),
	name: z.string().optional(),
	given_name: z.string().optional(),
	family_name: z.string().optional(),
	picture: z.string().url().optional(),
})

// Input types
export type SSOConfigurationInput = z.infer<typeof SSOConfigurationSchema>
export type SSOConfigurationUpdateInput = z.infer<
	typeof SSOConfigurationUpdateSchema
>
export type SSOConfigurationUpdate = SSOConfigurationUpdateInput
export type SSOConnectionTest = z.infer<typeof SSOConnectionTestSchema>
export type SSOAuthRequest = z.infer<typeof SSOAuthRequestSchema>
export type SSOCallback = z.infer<typeof SSOCallbackSchema>
export type OIDCUserInfo = z.infer<typeof OIDCUserInfoSchema>

// Validation helper functions
export function validateSSOConfiguration(data: unknown): SSOConfigurationInput {
	return SSOConfigurationSchema.parse(data)
}

export function validateSSOConfigurationUpdate(
	data: unknown,
): SSOConfigurationUpdateInput {
	return SSOConfigurationUpdateSchema.parse(data)
}

// Security validation helpers
export function sanitizeSSOConfigInput(input: any): any {
	// Remove any potentially dangerous fields
	const {
		__proto__,
		constructor: _constructor,
		prototype: _prototype,
		...sanitized
	} = input || {}

	// Sanitize string fields
	if (sanitized.providerName && typeof sanitized.providerName === 'string') {
		sanitized.providerName = sanitized.providerName.trim().slice(0, 100)
	}

	if (sanitized.issuerUrl && typeof sanitized.issuerUrl === 'string') {
		sanitized.issuerUrl = sanitized.issuerUrl.trim()
	}

	if (sanitized.clientId && typeof sanitized.clientId === 'string') {
		sanitized.clientId = sanitized.clientId.trim().slice(0, 255)
	}

	if (sanitized.clientSecret && typeof sanitized.clientSecret === 'string') {
		sanitized.clientSecret = sanitized.clientSecret.trim().slice(0, 1000)
	}

	if (sanitized.scopes && typeof sanitized.scopes === 'string') {
		sanitized.scopes = sanitized.scopes.trim().slice(0, 500)
	}

	// Sanitize attribute mapping
	if (
		sanitized.attributeMapping &&
		typeof sanitized.attributeMapping === 'string'
	) {
		try {
			const parsed = JSON.parse(sanitized.attributeMapping)
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const sanitizedMapping: Record<string, string> = {}
				let count = 0
				for (const [key, val] of Object.entries(parsed)) {
					if (count >= 20) break // Limit mappings
					if (typeof key === 'string' && typeof val === 'string') {
						const cleanKey = key.trim().slice(0, 50)
						const cleanVal = val.trim().slice(0, 100)
						if (cleanKey && cleanVal) {
							sanitizedMapping[cleanKey] = cleanVal
							count++
						}
					}
				}
				sanitized.attributeMapping = JSON.stringify(sanitizedMapping)
			} else {
				sanitized.attributeMapping = null
			}
		} catch {
			sanitized.attributeMapping = null
		}
	}

	return sanitized
}
