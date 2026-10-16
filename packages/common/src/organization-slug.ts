import { z } from 'zod'

export const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const organizationSlugSchema = z
	.string()
	.min(1, 'Slug is required')
	.regex(ORGANIZATION_SLUG_PATTERN, {
		message:
			'Slug can only contain lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen',
	})
