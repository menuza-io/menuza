/**
 * SSRF Protection: URL validation utilities
 * Prevents Server-Side Request Forgery attacks by blocking dangerous URLs
 */

import { ENV } from './env.js'

/**
 * Check if an IP address is private (RFC1918) or localhost
 */
function isPrivateIP(ip: string): boolean {
	// Remove IPv6 brackets if present
	const cleanIP = ip.replace(/^\[|\]$/g, '')

	// IPv4 private ranges
	const ipv4PrivateRanges = [
		/^127\./, // Loopback (127.0.0.0/8)
		/^10\./, // Private network (10.0.0.0/8)
		/^172\.(1[6-9]|2\d|3[01])\./, // Private network (172.16.0.0/12)
		/^192\.168\./, // Private network (192.168.0.0/16)
		/^169\.254\./, // Link-local (169.254.0.0/16)
		/^0\./, // Current network (0.0.0.0/8)
	]

	// IPv6 private/special ranges
	const ipv6PrivateRanges = [
		/^::1$/, // Loopback
		/^::/, // Unspecified
		/^fe80:/i, // Link-local
		/^fc00:/i, // Unique local
		/^fd00:/i, // Unique local
	]

	// Check IPv4
	for (const range of ipv4PrivateRanges) {
		if (range.test(cleanIP)) {
			return true
		}
	}

	// Check IPv6
	for (const range of ipv6PrivateRanges) {
		if (range.test(cleanIP)) {
			return true
		}
	}

	return false
}

/**
 * Validate URL to prevent SSRF attacks
 * @param urlString - The URL to validate
 * @param allowedProtocols - Allowed protocols (default: ['https'])
 * @returns Validation result with details
 */
export function validateUrlAgainstSSRF(
	urlString: string,
	options: {
		allowedProtocols?: string[]
		allowHttp?: boolean
		allowLocalhost?: boolean
		allowPrivateIPs?: boolean
	} = {},
): { valid: boolean; error?: string; url?: URL } {
	const {
		allowedProtocols = ['https'],
		allowHttp = false,
		allowLocalhost = false,
		allowPrivateIPs = false,
	} = options

	try {
		const url = new URL(urlString)

		// Check protocol
		const protocol = url.protocol.replace(':', '')
		const validProtocols = allowHttp
			? [...allowedProtocols, 'http']
			: allowedProtocols

		if (!validProtocols.includes(protocol)) {
			return {
				valid: false,
				error: `Protocol ${protocol} is not allowed. Allowed protocols: ${validProtocols.join(', ')}`,
			}
		}

		// Block file:// protocol
		if (protocol === 'file') {
			return {
				valid: false,
				error: 'File protocol is not allowed',
			}
		}

		// Block data:// protocol
		if (protocol === 'data') {
			return {
				valid: false,
				error: 'Data protocol is not allowed',
			}
		}

		// Block javascript:// protocol
		if (protocol === 'javascript') {
			return {
				valid: false,
				error: 'JavaScript protocol is not allowed',
			}
		}

		// Extract hostname
		const hostname = url.hostname.toLowerCase()

		// Check for localhost
		if (!allowLocalhost) {
			if (
				hostname === 'localhost' ||
				hostname === '127.0.0.1' ||
				hostname === '::1' ||
				hostname === '0.0.0.0'
			) {
				return {
					valid: false,
					error: 'Localhost URLs are not allowed',
				}
			}
		}

		// Check for private IPs
		if (!allowPrivateIPs && isPrivateIP(hostname)) {
			return {
				valid: false,
				error: 'Private IP addresses are not allowed',
			}
		}

		// Block metadata service IPs (cloud providers)
		const metadataIPs = [
			'169.254.169.254', // AWS, Azure, Google Cloud metadata service
			'169.254.170.2', // AWS ECS metadata service
			'fd00:ec2::254', // AWS IPv6 metadata service
		]

		if (metadataIPs.includes(hostname)) {
			return {
				valid: false,
				error: 'Cloud metadata service URLs are not allowed',
			}
		}

		// Block internal domain patterns
		const internalDomainPatterns = [
			/^internal\./i,
			/\.internal$/i,
			/^local\./i,
			/\.local$/i,
			/^localhost\./i,
		]

		for (const pattern of internalDomainPatterns) {
			if (pattern.test(hostname)) {
				return {
					valid: false,
					error: 'Internal domain names are not allowed',
				}
			}
		}

		return {
			valid: true,
			url,
		}
	} catch (error) {
		return {
			valid: false,
			error: `Invalid URL format: ${error instanceof Error ? error.message : 'Unknown error'}`,
		}
	}
}

/**
 * Validate URLs specifically for OIDC/OAuth issuer endpoints
 * More strict validation for security-critical endpoints
 */
export function validateOIDCIssuerUrl(issuerUrl: string): {
	valid: boolean
	error?: string
	normalizedUrl?: string
} {
	// Normalize URL
	let normalized = issuerUrl.trim()

	// Add https:// if no protocol specified (only for production)
	// Check if URL has a protocol (look for ://)
	if (!normalized.includes('://')) {
		normalized = `https://${normalized}`
	}

	// Remove trailing slash
	normalized = normalized.replace(/\/$/, '')

	// Validate against SSRF
	const validation = validateUrlAgainstSSRF(normalized, {
		allowHttp: ENV.NODE_ENV === 'development', // Only allow HTTP in development
		allowLocalhost: ENV.NODE_ENV === 'development', // Only allow localhost in development
		allowPrivateIPs: false, // Never allow private IPs for OIDC
		allowedProtocols: ['https'],
	})

	if (!validation.valid) {
		return {
			valid: false,
			error: validation.error,
		}
	}

	// Additional OIDC-specific validation
	if (validation.url) {
		const hostname = validation.url.hostname

		// Ensure hostname is not an IP address in production
		if (ENV.NODE_ENV === 'production') {
			const isIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
			const isIPv6 = hostname.includes(':')

			if (isIPv4 || isIPv6) {
				return {
					valid: false,
					error:
						'IP addresses are not allowed for OIDC issuer URLs in production',
				}
			}
		}

		// Ensure hostname has a TLD in production
		if (ENV.NODE_ENV === 'production') {
			const parts = hostname.split('.')
			if (parts.length < 2) {
				return {
					valid: false,
					error: 'OIDC issuer URL must have a valid domain with TLD',
				}
			}
		}
	}

	return {
		valid: true,
		normalizedUrl: normalized,
	}
}

/**
 * Validate endpoint URL before making HTTP requests
 */
export function validateEndpointUrl(endpointUrl: string): {
	valid: boolean
	error?: string
} {
	return validateUrlAgainstSSRF(endpointUrl, {
		allowHttp: ENV.NODE_ENV === 'development',
		allowLocalhost: ENV.NODE_ENV === 'development',
		allowPrivateIPs: false,
		allowedProtocols: ['https'],
	})
}
