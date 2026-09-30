/**
 * Unit tests for token encryption service
 */

import { webcrypto as crypto } from 'node:crypto'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
	IntegrationEncryptionService,
	integrationEncryption,
	isEncryptionConfigured,
	generateNewEncryptionKey,
	encryptToken,
	decryptToken,
} from '../../src/encryption'
import type { TokenData, EncryptedTokenData } from '../../src/types'

// Mock environment variables
const mockEncryptionKey =
	'1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' // 64 hex chars

describe('IntegrationEncryptionService', () => {
	let encryptionService: IntegrationEncryptionService

	beforeEach(() => {
		encryptionService = new IntegrationEncryptionService()
		vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', mockEncryptionKey)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	describe('encryptTokenData', () => {
		it('should encrypt token data successfully', async () => {
			const tokenData: TokenData = {
				accessToken: 'access-token-123',
				refreshToken: 'refresh-token-456',
				expiresAt: new Date('2024-12-31T23:59:59Z'),
				scope: 'read write',
			}

			const encrypted = await encryptionService.encryptTokenData(tokenData)

			expect(encrypted).toBeDefined()
			expect(encrypted.encryptedAccessToken).toBeDefined()
			expect(encrypted.encryptedRefreshToken).toBeDefined()
			expect(encrypted.expiresAt).toEqual(tokenData.expiresAt)
			expect(encrypted.scope).toBe(tokenData.scope)
			expect(encrypted.iv).toBeDefined()
			expect(typeof encrypted.iv).toBe('string')
		})

		it('should encrypt token data without refresh token', async () => {
			const tokenData: TokenData = {
				accessToken: 'access-token-123',
				expiresAt: new Date('2024-12-31T23:59:59Z'),
				scope: 'read',
			}

			const encrypted = await encryptionService.encryptTokenData(tokenData)

			expect(encrypted.encryptedAccessToken).toBeDefined()
			expect(encrypted.encryptedRefreshToken).toBeUndefined()
			expect(encrypted.expiresAt).toEqual(tokenData.expiresAt)
			expect(encrypted.scope).toBe(tokenData.scope)
		})

		it('should throw error when access token is missing', async () => {
			const tokenData: TokenData = {
				accessToken: '',
				refreshToken: 'refresh-token-456',
			}

			await expect(
				encryptionService.encryptTokenData(tokenData),
			).rejects.toThrow('Access token is required for encryption')
		})

		it('should throw error when encryption key is missing', async () => {
			vi.unstubAllEnvs()
			vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '')

			const tokenData: TokenData = {
				accessToken: 'access-token-123',
			}

			await expect(
				encryptionService.encryptTokenData(tokenData),
			).rejects.toThrow(/INTEGRATION_ENCRYPTION_KEY environment variable/)
		})

		it('should throw error when encryption key is wrong length', async () => {
			vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', 'short-key')

			const tokenData: TokenData = {
				accessToken: 'access-token-123',
			}

			await expect(
				encryptionService.encryptTokenData(tokenData),
			).rejects.toThrow(/INTEGRATION_ENCRYPTION_KEY.*valid.*encryption key/)
		})

		it('should throw error when encryption key is whitespace-only', async () => {
			vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '   ')

			const tokenData: TokenData = {
				accessToken: 'access-token-123',
			}

			await expect(
				encryptionService.encryptTokenData(tokenData),
			).rejects.toThrow(/INTEGRATION_ENCRYPTION_KEY.*valid.*encryption key/)
		})

		it('should handle encryption key with surrounding whitespace', async () => {
			// Key with spaces around it should fail validation (whitespace is not allowed)
			const validKey =
				'1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
			vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', `  ${validKey}  `)

			const tokenData: TokenData = {
				accessToken: 'access-token-123',
			}

			await expect(
				encryptionService.encryptTokenData(tokenData),
			).rejects.toThrow(/INTEGRATION_ENCRYPTION_KEY.*valid.*encryption key/)
		})
	})

	describe('decryptTokenData', () => {
		it('should decrypt token data successfully', async () => {
			const originalTokenData: TokenData = {
				accessToken: 'access-token-123',
				refreshToken: 'refresh-token-456',
				expiresAt: new Date('2024-12-31T23:59:59Z'),
				scope: 'read write',
			}

			const encrypted =
				await encryptionService.encryptTokenData(originalTokenData)
			const decrypted = await encryptionService.decryptTokenData(encrypted)

			expect(decrypted.accessToken).toBe(originalTokenData.accessToken)
			expect(decrypted.refreshToken).toBe(originalTokenData.refreshToken)
			expect(decrypted.expiresAt).toEqual(originalTokenData.expiresAt)
			expect(decrypted.scope).toBe(originalTokenData.scope)
		})

		it('should decrypt token data without refresh token', async () => {
			const originalTokenData: TokenData = {
				accessToken: 'access-token-123',
				expiresAt: new Date('2024-12-31T23:59:59Z'),
				scope: 'read',
			}

			const encrypted =
				await encryptionService.encryptTokenData(originalTokenData)
			const decrypted = await encryptionService.decryptTokenData(encrypted)

			expect(decrypted.accessToken).toBe(originalTokenData.accessToken)
			expect(decrypted.refreshToken).toBeUndefined()
			expect(decrypted.expiresAt).toEqual(originalTokenData.expiresAt)
			expect(decrypted.scope).toBe(originalTokenData.scope)
		})

		it('should throw error when decryption fails with wrong key', async () => {
			const tokenData: TokenData = {
				accessToken: 'access-token-123',
			}

			const encrypted = await encryptionService.encryptTokenData(tokenData)

			// Create a new encryption service with a different key
			vi.unstubAllEnvs()
			vi.stubEnv(
				'INTEGRATION_ENCRYPTION_KEY',
				'fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321',
			)
			const newEncryptionService = new IntegrationEncryptionService()

			await expect(
				newEncryptionService.decryptTokenData(encrypted),
			).rejects.toThrow(/Decryption failed/)
		})

		it('should throw error when encrypted data is corrupted', async () => {
			const corruptedData: EncryptedTokenData = {
				encryptedAccessToken: 'corrupted-data',
				iv: 'invalid-iv',
			}

			await expect(
				encryptionService.decryptTokenData(corruptedData),
			).rejects.toThrow(/Decryption failed/)
		})
	})

	describe('validateToken', () => {
		it('should validate token without expiry as valid', () => {
			const tokenData: TokenData = {
				accessToken: 'access-token-123',
			}

			const result = encryptionService.validateToken(tokenData)

			expect(result.isValid).toBe(true)
			expect(result.isExpired).toBe(false)
			expect(result.needsRefresh).toBe(false)
			expect(result.expiresIn).toBeUndefined()
		})

		it('should validate non-expired token', () => {
			const tokenData: TokenData = {
				accessToken: 'access-token-123',
				expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
			}

			const result = encryptionService.validateToken(tokenData)

			expect(result.isValid).toBe(true)
			expect(result.isExpired).toBe(false)
			expect(result.needsRefresh).toBe(false)
			expect(result.expiresIn).toBeGreaterThan(3000) // More than 50 minutes
		})

		it('should identify token that needs refresh', () => {
			const tokenData: TokenData = {
				accessToken: 'access-token-123',
				expiresAt: new Date(Date.now() + 200000), // 3.33 minutes from now
			}

			const result = encryptionService.validateToken(tokenData)

			expect(result.isValid).toBe(true)
			expect(result.isExpired).toBe(false)
			expect(result.needsRefresh).toBe(true)
			expect(result.expiresIn).toBeLessThanOrEqual(300) // Less than 5 minutes
		})

		it('treats corrupt legacy expiry timestamps as expired', () => {
			const tokenData: TokenData = {
				accessToken: 'access-token-123',
				expiresAt: new Date(4_102_444_800),
			}

			const result = encryptionService.validateToken(tokenData)

			expect(result.isValid).toBe(false)
			expect(result.isExpired).toBe(true)
		})

		it('should identify expired token', () => {
			const tokenData: TokenData = {
				accessToken: 'access-token-123',
				expiresAt: new Date(Date.now() - 1000), // 1 second ago
			}

			const result = encryptionService.validateToken(tokenData)

			expect(result.isValid).toBe(false)
			expect(result.isExpired).toBe(true)
			expect(result.needsRefresh).toBe(false)
			expect(result.expiresIn).toBe(0)
		})

		it('should work with encrypted token data', async () => {
			const tokenData: TokenData = {
				accessToken: 'access-token-123',
				expiresAt: new Date(Date.now() + 3600000),
			}

			const encrypted = await encryptionService.encryptTokenData(tokenData)
			const result = encryptionService.validateToken(encrypted)

			expect(result.isValid).toBe(true)
			expect(result.isExpired).toBe(false)
		})
	})

	describe('generateOAuthState', () => {
		it('should generate OAuth state', () => {
			const organizationId = 'org-123'
			const providerName = 'slack'

			const state = encryptionService.generateOAuthState(
				organizationId,
				providerName,
			)

			expect(state).toBeDefined()
			expect(typeof state).toBe('string')
			expect(state.length).toBeGreaterThan(0)
		})

		it('should generate unique states', () => {
			const organizationId = 'org-123'
			const providerName = 'slack'

			const state1 = encryptionService.generateOAuthState(
				organizationId,
				providerName,
			)
			const state2 = encryptionService.generateOAuthState(
				organizationId,
				providerName,
			)

			expect(state1).not.toBe(state2)
		})
	})

	describe('validateOAuthState', () => {
		it('should validate valid OAuth state', () => {
			const organizationId = 'org-123'
			const providerName = 'slack'

			const state = encryptionService.generateOAuthState(
				organizationId,
				providerName,
			)
			const result = encryptionService.validateOAuthState(state)

			expect(result.organizationId).toBe(organizationId)
			expect(result.providerName).toBe(providerName)
		})

		it('should throw error for invalid state format', () => {
			expect(() => {
				encryptionService.validateOAuthState('invalid-state')
			}).toThrow('Invalid or expired OAuth state')
		})

		it('should throw error for expired state', async () => {
			const organizationId = 'org-123'
			const providerName = 'slack'

			const state = encryptionService.generateOAuthState(
				organizationId,
				providerName,
			)

			// Wait a bit to ensure the state is expired
			await new Promise((resolve) => setTimeout(resolve, 10))

			// Test with very short max age
			expect(() => {
				encryptionService.validateOAuthState(state, 1) // 1ms max age
			}).toThrow('Invalid or expired OAuth state')
		})

		it('should accept custom max age', () => {
			const organizationId = 'org-123'
			const providerName = 'slack'

			const state = encryptionService.generateOAuthState(
				organizationId,
				providerName,
			)
			const result = encryptionService.validateOAuthState(state, 60000) // 1 minute

			expect(result.organizationId).toBe(organizationId)
			expect(result.providerName).toBe(providerName)
		})

		it('should reject state with future timestamp', () => {
			const futureTimestamp = Date.now() + 1000 * 60 * 60 * 24 * 365 * 100 // 100 years in future
			const maliciousStateData = {
				organizationId: 'org-malicious',
				providerName: 'slack',
				timestamp: futureTimestamp,
				nonce: crypto.randomUUID(),
			}

			const maliciousState = Buffer.from(
				JSON.stringify(maliciousStateData),
			).toString('base64url')

			expect(() => {
				encryptionService.validateOAuthState(maliciousState)
			}).toThrow('Invalid or expired OAuth state')
		})

		it('should reject state with slightly future timestamp', () => {
			const futureTimestamp = Date.now() + 10000 // 10 seconds in the future
			const stateData = {
				organizationId: 'org-test',
				providerName: 'github',
				timestamp: futureTimestamp,
				nonce: crypto.randomUUID(),
			}

			const state = Buffer.from(JSON.stringify(stateData)).toString('base64url')

			expect(() => {
				encryptionService.validateOAuthState(state)
			}).toThrow('Invalid or expired OAuth state')
		})
	})

	describe('secureCompare', () => {
		it('should return true for identical strings', () => {
			const str1 = 'test-string'
			const str2 = 'test-string'

			const result = encryptionService.secureCompare(str1, str2)

			expect(result).toBe(true)
		})

		it('should return false for different strings', () => {
			const str1 = 'test-string'
			const str2 = 'different-string'

			const result = encryptionService.secureCompare(str1, str2)

			expect(result).toBe(false)
		})

		it('should return false for strings of different lengths', () => {
			const str1 = 'short'
			const str2 = 'much-longer-string'

			const result = encryptionService.secureCompare(str1, str2)

			expect(result).toBe(false)
		})

		it('should return false for empty vs non-empty strings', () => {
			const str1 = ''
			const str2 = 'non-empty'

			const result = encryptionService.secureCompare(str1, str2)

			expect(result).toBe(false)
		})
	})
})

describe('Static methods', () => {
	describe('generateEncryptionKey', () => {
		it('should generate a valid encryption key', () => {
			const key = IntegrationEncryptionService.generateEncryptionKey()

			expect(key).toBeDefined()
			expect(typeof key).toBe('string')
			expect(key.length).toBe(64) // 32 bytes = 64 hex characters
			expect(/^[0-9a-f]+$/i.test(key)).toBe(true) // Valid hex string
		})

		it('should generate unique keys', () => {
			const key1 = IntegrationEncryptionService.generateEncryptionKey()
			const key2 = IntegrationEncryptionService.generateEncryptionKey()

			expect(key1).not.toBe(key2)
		})
	})
})

describe('Utility functions', () => {
	beforeEach(() => {
		vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', mockEncryptionKey)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	describe('isEncryptionConfigured', () => {
		it('should return true when encryption key is configured', () => {
			const result = isEncryptionConfigured()
			expect(result).toBe(true)
		})

		it('should return false when encryption key is not configured', () => {
			vi.unstubAllEnvs()
			vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '')
			const result = isEncryptionConfigured()
			expect(result).toBe(false)
		})

		it('should return false when encryption key is whitespace-only', () => {
			vi.unstubAllEnvs()
			vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '   ')
			const result = isEncryptionConfigured()
			expect(result).toBe(false)
		})

		it('should return false when encryption key has wrong length', () => {
			vi.unstubAllEnvs()
			vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', 'short-key')
			const result = isEncryptionConfigured()
			expect(result).toBe(false)
		})

		it('should return false when encryption key is not valid hex', () => {
			vi.unstubAllEnvs()
			// 64 characters but not valid hex
			vi.stubEnv(
				'INTEGRATION_ENCRYPTION_KEY',
				'gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg',
			)
			const result = isEncryptionConfigured()
			expect(result).toBe(false)
		})

		it('should return true when encryption key is valid with surrounding whitespace', () => {
			vi.unstubAllEnvs()
			const validKey =
				'1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
			vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', `  ${validKey}  `)
			const result = isEncryptionConfigured()
			expect(result).toBe(true)
		})
	})

	describe('generateNewEncryptionKey', () => {
		it('should generate a new encryption key', () => {
			const key = generateNewEncryptionKey()

			expect(key).toBeDefined()
			expect(typeof key).toBe('string')
			expect(key.length).toBe(64)
		})
	})

	describe('encryptToken and decryptToken', () => {
		it('should encrypt and decrypt a simple token', async () => {
			const originalToken = 'simple-access-token'

			const encrypted = await encryptToken(originalToken)
			const decrypted = await decryptToken(encrypted)

			expect(decrypted).toBe(originalToken)
		})

		it('should throw error when decrypting with wrong key', async () => {
			const originalToken = 'simple-access-token'
			const encrypted = await encryptToken(originalToken)

			// Create corrupted encrypted data to simulate wrong key scenario
			const corruptedEncrypted = encrypted.slice(0, -10) + '0000000000'

			await expect(decryptToken(corruptedEncrypted)).rejects.toThrow(
				/Decryption failed/,
			)
		})

		it('should throw error when decrypting corrupted data', async () => {
			await expect(decryptToken('corrupted-encrypted-data')).rejects.toThrow(
				/Decryption failed/,
			)
		})
	})
})

describe('Singleton instance', () => {
	beforeEach(() => {
		vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', mockEncryptionKey)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('should work with singleton instance', async () => {
		const tokenData: TokenData = {
			accessToken: 'access-token-123',
			refreshToken: 'refresh-token-456',
		}

		const encrypted = await integrationEncryption.encryptTokenData(tokenData)
		const decrypted = await integrationEncryption.decryptTokenData(encrypted)

		expect(decrypted.accessToken).toBe(tokenData.accessToken)
		expect(decrypted.refreshToken).toBe(tokenData.refreshToken)
	})
})
