// Native modules have no implementation under Jest. These mocks behave like
// the real modules where the app depends on their behaviour (secure storage
// keeps what was written) and stay inert otherwise.

const mockSecureItems = new Map()

jest.mock('expo-secure-store', () => ({
	AFTER_FIRST_UNLOCK: 0,
	AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
	WHEN_UNLOCKED: 2,
	WHEN_UNLOCKED_THIS_DEVICE_ONLY: 3,
	getItemAsync: jest.fn(async (key) =>
		mockSecureItems.has(key) ? mockSecureItems.get(key) : null,
	),
	setItemAsync: jest.fn(async (key, value) => {
		mockSecureItems.set(key, String(value))
	}),
	deleteItemAsync: jest.fn(async (key) => {
		mockSecureItems.delete(key)
	}),
}))

jest.mock('expo-constants', () => ({
	__esModule: true,
	default: {
		expoConfig: {
			name: 'Tenant',
			extra: {
				customer: {
					useTls: false,
					appBaseUrl: 'localhost:3001',
					tenantApiUs: 'localhost:3007',
					tenantApiKsa: 'localhost:3009',
					brandDomain: 'epic-startup.test',
					site: { slug: '', host: '', origin: '' },
				},
			},
		},
	},
}))

jest.mock('expo-localization', () => ({
	getLocales: jest.fn(() => [
		{ languageTag: 'en-US', languageCode: 'en', textDirection: 'ltr' },
	]),
	getCalendars: jest.fn(() => [{ timeZone: 'UTC', uses24hourClock: false }]),
}))

jest.mock('expo-web-browser', () => ({
	openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })),
	openAuthSessionAsync: jest.fn(async () => ({ type: 'dismiss' })),
	dismissBrowser: jest.fn(),
	WebBrowserResultType: {
		CANCEL: 'cancel',
		DISMISS: 'dismiss',
		OPENED: 'opened',
		LOCKED: 'locked',
	},
}))

jest.mock('expo-linking', () => ({
	openURL: jest.fn(async () => true),
	canOpenURL: jest.fn(async () => true),
	createURL: jest.fn((path) => `tenant://${path}`),
}))

jest.mock('uniwind', () => {
	const React = require('react')
	return {
		Uniwind: {
			setTheme: jest.fn(),
			updateCSSVariables: jest.fn(),
			currentTheme: 'light',
			hasAdaptiveThemes: true,
		},
		useUniwind: jest.fn(() => ({ theme: 'light', hasAdaptiveThemes: true })),
		useCSSVariable: jest.fn(() => undefined),
		useResolveClassNames: jest.fn(() => ({})),
		withUniwind: (Component) => Component,
		LayoutDirection: ({ children }) =>
			React.createElement(React.Fragment, null, children),
		ScopedTheme: ({ children }) =>
			React.createElement(React.Fragment, null, children),
	}
})

jest.mock(
	'react-native-safe-area-context',
	() => require('react-native-safe-area-context/jest/mock').default,
)

beforeEach(() => {
	mockSecureItems.clear()
})
