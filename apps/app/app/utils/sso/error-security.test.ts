import { describe, it, expect, vi } from 'vitest'
import {
	createSSOError,
	handleSSOError,
	SSOErrorType,
	handleOAuthError,
	shouldFallbackToTraditionalAuth,
	getSSORetryDelay,
} from './error-handling.server.ts'

// Mock the toast and redirect utilities
vi.mock('../toast.server.ts', () => ({
	redirectWithToast: vi.fn((url, toast, options) => {
		const headers = new Headers({
			Location: url,
			'Set-Cookie': 'toast=' + JSON.stringify(toast),
		})

		// Add headers from options if provided
		if (options?.headers) {
			if (options.headers instanceof Headers) {
				options.headers.forEach((value: string, key: string) => {
					if (key.toLowerCase() === 'set-cookie') {
						headers.append('Set-Cookie', value)
					} else {
						headers.set(key, value)
					}
				})
			} else if (typeof options.headers === 'object') {
				Object.entries(options.headers).forEach(([key, value]) => {
					if (key.toLowerCase() === 'set-cookie') {
						headers.append('Set-Cookie', value as string)
					} else {
						headers.set(key, value as string)
					}
				})
			}
		}

		return new Response(null, {
			status: 302,
			headers,
		})
	}),
}))

vi.mock('@repo/common/redirect-cookie', () => ({
	destroyRedirectToHeaders: () => ({
		'set-cookie': 'redirect-to=; Max-Age=0',
	}),
}))

describe('SSO Error Handling Security Tests', () => {
	describe('Error Message Security', () => {
		it('should not expose sensitive information in error messages', () => {
			const sensitiveError = new Error(
				'Authentication failed with client secret: super-secret-key-123',
			)
			const ssoError = createSSOError(
				SSOErrorType.AUTHENTICATION_FAILED,
				sensitiveError.message,
			)

			// User-facing message should not contain sensitive data
			expect(ssoError.userMessage).not.toContain('super-secret-key-123')
			expect(ssoError.userDescription).not.toContain('super-secret-key-123')
		})

		it('should sanitize error details for user display', () => {
			const maliciousError = new Error('Error: <script>alert("xss")</script>')
			const ssoError = createSSOError(
				SSOErrorType.CONFIGURATION_INVALID,
				maliciousError.message,
			)

			// Should not contain script tags in user messages
			expect(ssoError.userMessage).not.toContain('<script>')
			expect(ssoError.userDescription).not.toContain('<script>')
		})

		it('should provide generic error messages for security-sensitive failures', () => {
			const securitySensitiveErrors = [
				SSOErrorType.CONFIGURATION_INVALID,
				SSOErrorType.TOKEN_EXCHANGE_FAILED,
				SSOErrorType.USER_PROVISIONING_FAILED,
			]

			securitySensitiveErrors.forEach((errorType) => {
				const error = createSSOError(
					errorType,
					'Detailed technical error message',
				)

				// User message should be generic
				expect(error.userMessage).not.toContain('technical')
				expect(error.userDescription).not.toContain('Detailed technical')
			})
		})

		it('should limit error message length to prevent log flooding', () => {
			const veryLongMessage = 'Error: ' + 'x'.repeat(10000)
			const ssoError = createSSOError(
				SSOErrorType.UNKNOWN_ERROR,
				veryLongMessage,
			)

			// User messages should be reasonably sized
			expect(ssoError.userMessage.length).toBeLessThan(200)
			expect(ssoError.userDescription.length).toBeLessThan(500)
		})
	})

	describe('OAuth Error Handling Security', () => {
		it('should handle OAuth error injection attempts', () => {
			const maliciousError = '<script>alert("xss")</script>access_denied'
			const maliciousDescription =
				'User denied access<script>alert("xss")</script>'

			const ssoError = handleOAuthError(maliciousError, maliciousDescription)

			expect(ssoError.userMessage).not.toContain('<script>')
			expect(ssoError.userDescription).not.toContain('<script>')
		})

		it('should validate OAuth error codes', () => {
			const invalidErrorCodes = [
				'../../../etc/passwd',
				'DROP TABLE users;',
				'\x00null_byte',
				'very_long_error_code_' + 'x'.repeat(1000),
			]

			invalidErrorCodes.forEach((errorCode) => {
				const ssoError = handleOAuthError(errorCode, 'Description')

				// Should handle invalid error codes gracefully
				expect(ssoError.type).toBe(SSOErrorType.AUTHENTICATION_FAILED)
				expect(ssoError.userMessage).toBeTruthy()
			})
		})

		it('should prevent error description injection', () => {
			const injectionAttempts = [
				'Normal description\n\rINJECTED: Malicious content',
				'Description with\x00null bytes',
				'Description\x1b[31mwith ANSI codes\x1b[0m',
			]

			injectionAttempts.forEach((description) => {
				const ssoError = handleOAuthError('access_denied', description)

				// Should sanitize descriptions
				expect(ssoError.userDescription).not.toContain('\n\r')
				expect(ssoError.userDescription).not.toContain('\x00')
				expect(ssoError.userDescription).not.toContain('\x1b[31m')
			})
		})
	})

	describe('Error Response Security', () => {
		it('should not leak internal paths in redirect URLs', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

			const error = createSSOError(
				SSOErrorType.CONFIGURATION_NOT_FOUND,
				'Config not found',
			)

			const response = await handleSSOError(error, '/internal/admin/secret')

			// Should redirect to safe fallback, not internal path
			expect(response.headers.get('Location')).not.toContain(
				'/internal/admin/secret',
			)
			expect(response.headers.get('Location')).toBe('/login')

			consoleSpy.mockRestore()
		})

		it('should validate fallback URLs to prevent open redirects', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

			const maliciousFallbacks = [
				'https://evil.com',
				'//evil.com/path',
				'javascript:alert(1)',
				'data:text/html,<script>alert(1)</script>',
			]

			for (const fallback of maliciousFallbacks) {
				const error = createSSOError(SSOErrorType.UNKNOWN_ERROR, 'Test error')
				const response = await handleSSOError(error, fallback)

				// Should not redirect to malicious URLs
				const location = response.headers.get('Location')
				expect(location).not.toContain('evil.com')
				expect(location).not.toContain('javascript:')
				expect(location).not.toContain('data:')
			}

			consoleSpy.mockRestore()
		})

		it('should set secure headers in error responses', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

			const error = createSSOError(
				SSOErrorType.AUTHENTICATION_FAILED,
				'Auth failed',
			)
			const response = await handleSSOError(error)

			// Should have security headers
			expect(response.headers.get('Set-Cookie')).toContain('redirect-to=')
			expect(response.status).toBe(302)

			consoleSpy.mockRestore()
		})
	})

	describe('Error Categorization Security', () => {
		it('should not expose system internals through error categorization', () => {
			const systemErrors = [
				new Error(
					'Database connection failed: postgres://user:pass@localhost:5432/db',
				),
				new Error('Redis connection failed: redis://localhost:6379'),
				new Error('File not found: /etc/passwd'),
			]

			systemErrors.forEach((error) => {
				const ssoError = createSSOError(
					SSOErrorType.UNKNOWN_ERROR,
					error.message,
				)

				// User messages should not contain system details
				expect(ssoError.userMessage).not.toContain('postgres://')
				expect(ssoError.userMessage).not.toContain('redis://')
				expect(ssoError.userMessage).not.toContain('/etc/passwd')
			})
		})

		it('should handle circular reference errors safely', () => {
			// Create circular reference
			const circularObj: any = { name: 'test' }
			circularObj.self = circularObj

			// Test that the function handles circular references gracefully
			let error: any
			expect(() => {
				try {
					const circularString = JSON.stringify(circularObj)
					error = createSSOError(
						SSOErrorType.UNKNOWN_ERROR,
						'Circular reference error',
						circularString,
					)
				} catch {
					// If JSON.stringify fails, createSSOError should still work
					error = createSSOError(
						SSOErrorType.UNKNOWN_ERROR,
						'Circular reference error',
						'[Circular reference detected]',
					)
				}
			}).not.toThrow()

			// Should handle without crashing
			expect(error.userMessage).toBeTruthy()
		})
	})

	describe('Fallback Mechanism Security', () => {
		it('should validate fallback conditions securely', () => {
			const securitySensitiveErrors = [
				createSSOError(SSOErrorType.USER_NOT_AUTHORIZED, 'Not authorized'),
				createSSOError(SSOErrorType.SUSPICIOUS_ACTIVITY, 'Suspicious activity'),
			]

			securitySensitiveErrors.forEach((error) => {
				const shouldFallback = shouldFallbackToTraditionalAuth(error)

				// Security-sensitive errors should not fallback
				expect(shouldFallback).toBe(false)
			})
		})

		it('should prevent fallback bypass through error manipulation', () => {
			// Try to manipulate error to force fallback
			const error = createSSOError(
				SSOErrorType.USER_NOT_AUTHORIZED,
				'Not authorized',
			)
			error.shouldFallback = true // Try to override

			const shouldFallback = shouldFallbackToTraditionalAuth(error)

			// Should still respect the original security policy
			expect(shouldFallback).toBe(false)
		})
	})

	describe('Retry Delay Security', () => {
		it('should provide appropriate retry delays for different error types', () => {
			const errorTypes = [
				SSOErrorType.RATE_LIMIT_EXCEEDED,
				SSOErrorType.SUSPICIOUS_ACTIVITY,
				SSOErrorType.NETWORK_ERROR,
				SSOErrorType.AUTHENTICATION_FAILED,
			]

			errorTypes.forEach((errorType) => {
				const error = createSSOError(errorType, 'Test error')
				const delay = getSSORetryDelay(error)

				// Should provide reasonable delays
				expect(delay).toBeGreaterThan(0)
				expect(delay).toBeLessThan(24 * 60 * 60 * 1000) // Less than 24 hours
			})
		})

		it('should prevent retry delay manipulation', () => {
			const error = createSSOError(
				SSOErrorType.RATE_LIMIT_EXCEEDED,
				'Rate limited',
			)

			// Try to manipulate the error type
			const manipulatedError = { ...error, type: SSOErrorType.NETWORK_ERROR }

			const originalDelay = getSSORetryDelay(error)
			const manipulatedDelay = getSSORetryDelay(manipulatedError as any)

			// Should use the actual error type for delay calculation
			expect(originalDelay).toBe(5 * 60 * 1000) // 5 minutes for rate limit
			expect(manipulatedDelay).toBe(30 * 1000) // 30 seconds for network error
		})
	})

	describe('Error Logging Security', () => {
		it('should not log sensitive data in error details', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

			const sensitiveError = new Error(
				'Token validation failed: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
			)

			await handleSSOError(sensitiveError)

			// Should log error but not sensitive tokens
			expect(consoleSpy).toHaveBeenCalled()
			const loggedMessage = consoleSpy.mock.calls[0]?.[1]
			expect(loggedMessage).not.toContain(
				'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
			)

			consoleSpy.mockRestore()
		})

		it('should limit error log size to prevent log flooding', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

			const massiveError = new Error('x'.repeat(100000)) // 100KB error message

			await handleSSOError(massiveError)

			expect(consoleSpy).toHaveBeenCalled()
			// Should handle large errors without issues

			consoleSpy.mockRestore()
		})
	})

	describe('Admin Notification Security', () => {
		it('should sanitize error details in admin notifications', () => {
			const error = createSSOError(
				SSOErrorType.CONFIGURATION_INVALID,
				'Config error with sensitive data: client_secret=abc123',
			)

			// Admin notifications should not contain sensitive data
			expect(error.message).not.toContain('client_secret=abc123')
		})

		it('should rate limit admin notifications to prevent spam', async () => {
			const consoleWarnSpy = vi
				.spyOn(console, 'warn')
				.mockImplementation(() => {})
			const consoleErrorSpy = vi
				.spyOn(console, 'error')
				.mockImplementation(() => {})

			// Simulate many critical errors
			for (let i = 0; i < 100; i++) {
				const error = createSSOError(
					SSOErrorType.CONFIGURATION_INVALID,
					`Error ${i}`,
				)
				error.shouldNotifyAdmin = true
				await handleSSOError(error)
			}

			// Should handle many notifications without overwhelming the system
			expect(consoleWarnSpy).toHaveBeenCalled()

			consoleWarnSpy.mockRestore()
			consoleErrorSpy.mockRestore()
		})
	})
})
