import { router } from 'expo-router'

jest.mock('expo-router', () => ({
	router: {
		replace: jest.fn(),
		push: jest.fn(),
		canGoBack: jest.fn(),
		back: jest.fn(),
	},
}))

// jest.setup.js mocks './lib/navigation' for every suite; this one needs the real module.
const { handleDeepLink } = jest.requireActual('../index') as {
	handleDeepLink: (url: string) => void
}

const replace = router.replace as jest.Mock

function verifyHref() {
	const href = replace.mock.calls[0]?.[0] as string
	expect(href.split('?')[0]).toBe('/(auth)/verify-code')
	return new URLSearchParams(href.split('?')[1])
}

describe('handleDeepLink redirectTo', () => {
	beforeEach(() => replace.mockClear())

	it('drops a protocol-relative redirectTo from a verify link', () => {
		handleDeepLink(
			'epic-startup://verify?type=t&target=u&code=c&redirectTo=//example.invalid',
		)
		const params = verifyHref()
		expect(params.get('code')).toBe('c')
		expect(params.has('redirectTo')).toBe(false)
	})

	it('keeps an in-app redirectTo', () => {
		handleDeepLink(
			'epic-startup://verify?type=t&target=u&code=c&redirectTo=/(dashboard)/profile',
		)
		expect(verifyHref().get('redirectTo')).toBe('/(dashboard)/profile')
	})
})
