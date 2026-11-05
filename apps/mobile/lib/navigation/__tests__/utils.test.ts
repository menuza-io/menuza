import { isValidRedirectPath, parseDeepLink, createDeepLink } from '../utils'

// Mock expo-router
jest.mock('expo-router', () => ({
	router: {
		replace: jest.fn(),
		push: jest.fn(),
	},
}))

// Mock expo-linking
jest.mock('expo-linking', () => ({
	parse: jest.fn(),
}))

describe('Navigation Utils', () => {
	describe('isValidRedirectPath', () => {
		it('should allow dashboard routes', () => {
			expect(isValidRedirectPath('/(dashboard)')).toBe(true)
			expect(isValidRedirectPath('/(dashboard)/profile')).toBe(true)
		})

		it('should disallow auth routes', () => {
			expect(isValidRedirectPath('/(auth)/sign-in')).toBe(false)
			expect(isValidRedirectPath('/(auth)/sign-up')).toBe(false)
		})

		it('should disallow callback routes', () => {
			expect(isValidRedirectPath('/auth/callback')).toBe(false)
		})

		it('should disallow paths not starting with /', () => {
			expect(isValidRedirectPath('dashboard')).toBe(false)
			expect(isValidRedirectPath('auth/sign-in')).toBe(false)
		})

		it('should allow other valid routes', () => {
			expect(isValidRedirectPath('/profile')).toBe(true)
			expect(isValidRedirectPath('/settings')).toBe(true)
		})

		it('should disallow protocol-relative and backslash paths', () => {
			expect(isValidRedirectPath('//example.invalid')).toBe(false)
			expect(isValidRedirectPath('//example.invalid/path')).toBe(false)
			expect(isValidRedirectPath('/\\example.invalid')).toBe(false)
			expect(isValidRedirectPath('/\t/example.invalid')).toBe(false)
		})
	})

	describe('parseDeepLink', () => {
		const mockParse = require('expo-linking').parse

		beforeEach(() => {
			mockParse.mockClear()
		})

		it('should parse deep link successfully', () => {
			mockParse.mockReturnValue({
				path: 'sign-in',
				queryParams: { redirectTo: '/dashboard' },
			})

			const result = parseDeepLink('epicnotes://sign-in?redirectTo=/dashboard')

			expect(result).toEqual({
				pathname: 'sign-in',
				params: { redirectTo: '/dashboard' },
			})
		})

		it('should handle parsing errors', () => {
			mockParse.mockImplementation(() => {
				throw new Error('Invalid URL')
			})

			const result = parseDeepLink('invalid-url')

			expect(result).toEqual({})
		})

		it('should handle missing path and params', () => {
			mockParse.mockReturnValue({})

			const result = parseDeepLink('epicnotes://')

			expect(result).toEqual({
				pathname: undefined,
				params: undefined,
			})
		})
	})

	describe('createDeepLink', () => {
		it('should create deep link with pathname only', () => {
			const result = createDeepLink('sign-in')
			expect(result).toBe('epicnotes://sign-in')
		})

		it('should create deep link with pathname and params', () => {
			const result = createDeepLink('sign-in', { redirectTo: '/dashboard' })
			expect(result).toBe('epicnotes://sign-in?redirectTo=%2Fdashboard')
		})

		it('should handle pathname with leading slash', () => {
			const result = createDeepLink('/sign-in')
			expect(result).toBe('epicnotes://sign-in')
		})

		it('should handle empty params', () => {
			const result = createDeepLink('sign-in', {})
			expect(result).toBe('epicnotes://sign-in')
		})

		it('should filter out undefined param values', () => {
			const result = createDeepLink('sign-in', {
				redirectTo: '/dashboard',
				email: 'test@example.com',
			})
			expect(result).toBe(
				'epicnotes://sign-in?redirectTo=%2Fdashboard&email=test%40example.com',
			)
		})
	})
})
