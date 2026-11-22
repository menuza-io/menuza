// Setup React Native testing environment
import '@testing-library/jest-native/extend-expect'

// Mock Expo modules
jest.mock('expo-secure-store', () => ({
	setItemAsync: jest.fn(),
	getItemAsync: jest.fn(),
	deleteItemAsync: jest.fn(),
}))

jest.mock('expo-auth-session', () => ({
	makeRedirectUri: jest.fn(),
	useAuthRequest: jest.fn(),
	AuthRequest: jest.fn(),
}))

jest.mock('expo-linking', () => ({
	createURL: jest.fn(),
	addEventListener: jest.fn(),
	removeEventListener: jest.fn(),
}))

jest.mock('expo-router', () => ({
	useRouter: jest.fn(() => ({
		replace: jest.fn(),
		push: jest.fn(),
		back: jest.fn(),
	})),
}))

jest.mock('expo-haptics', () => ({
	impactAsync: jest.fn(),
	notificationAsync: jest.fn(),
	selectionAsync: jest.fn(),
	ImpactFeedbackStyle: {
		Light: 'light',
		Medium: 'medium',
		Heavy: 'heavy',
	},
	NotificationFeedbackType: {
		Success: 'success',
		Warning: 'warning',
		Error: 'error',
	},
}))

jest.mock('expo-constants', () => ({
	default: {
		expoConfig: {
			name: 'test-app',
			extra: {
				EXPO_PUBLIC_GITHUB_CLIENT_ID: 'test-github-client-id',
				EXPO_PUBLIC_GOOGLE_CLIENT_ID: 'test-google-client-id',
			},
		},
	},
}))

jest.mock('@expo/vector-icons', () => ({
	Ionicons: 'Ionicons',
	MaterialIcons: 'MaterialIcons',
	FontAwesome: 'FontAwesome',
	AntDesign: 'AntDesign',
	Entypo: 'Entypo',
	EvilIcons: 'EvilIcons',
	Feather: 'Feather',
	Foundation: 'Foundation',
	MaterialCommunityIcons: 'MaterialCommunityIcons',
	Octicons: 'Octicons',
	SimpleLineIcons: 'SimpleLineIcons',
	Zocial: 'Zocial',
}))

jest.mock('react-native-safe-area-context', () => ({
	SafeAreaView: 'SafeAreaView',
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

// Dish photos (#222). These native modules are mocked virtually so tests run
// without the native packages being resolvable.
jest.mock(
	'expo-camera',
	() => ({
		CameraView: 'CameraView',
		useCameraPermissions: jest.fn(() => [
			{ granted: true, canAskAgain: true, status: 'granted' },
			jest.fn(async () => ({ granted: true })),
		]),
	}),
	{ virtual: true },
)

jest.mock(
	'expo-image-picker',
	() => ({
		launchImageLibraryAsync: jest.fn(async () => ({
			canceled: true,
			assets: null,
		})),
		launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: null })),
		requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
		requestMediaLibraryPermissionsAsync: jest.fn(async () => ({
			granted: true,
		})),
	}),
	{ virtual: true },
)

jest.mock(
	'expo-image-manipulator',
	() => ({
		ImageManipulator: {
			manipulate: jest.fn(() => ({
				resize: jest.fn().mockReturnThis(),
				renderAsync: jest.fn(async () => ({
					saveAsync: jest.fn(async () => ({
						uri: 'file:///cache/manipulated.jpg',
						width: 2000,
						height: 1500,
					})),
				})),
			})),
		},
		SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
	}),
	{ virtual: true },
)

jest.mock(
	'@react-native-community/netinfo',
	() => ({
		__esModule: true,
		default: {
			fetch: jest.fn(async () => ({
				isConnected: true,
				isInternetReachable: true,
			})),
			addEventListener: jest.fn(() => jest.fn()),
		},
	}),
	{ virtual: true },
)

jest.mock(
	'@react-native-async-storage/async-storage',
	() => {
		const store = new Map()
		return {
			__esModule: true,
			default: {
				getItem: jest.fn(async (key) => store.get(key) ?? null),
				setItem: jest.fn(async (key, value) => {
					store.set(key, value)
				}),
				removeItem: jest.fn(async (key) => {
					store.delete(key)
				}),
			},
		}
	},
	{ virtual: true },
)

jest.mock('expo-file-system', () => {
	class File {
		constructor(...parts) {
			this.uri = parts
				.map((part) => (typeof part === 'string' ? part : part.uri))
				.join('/')
			this.exists = true
		}
		copy() {}
		delete() {}
	}
	class Directory {
		constructor(...parts) {
			this.uri = parts
				.map((part) => (typeof part === 'string' ? part : part.uri))
				.join('/')
			this.exists = true
		}
		create() {}
	}
	return {
		File,
		Directory,
		Paths: { document: new Directory('file:///documents') },
	}
})

// Mock Alert globally
global.Alert = {
	alert: jest.fn(),
}

// Mock the auth context and hooks
jest.mock('./lib/auth/hooks/use-auth', () => ({
	useAuth: jest.fn(() => ({
		user: null,
		tokens: null,
		isLoading: false,
		error: null,
		isAuthenticated: false,
		login: jest.fn(),
		signup: jest.fn(),
		socialLogin: jest.fn(),
		logout: jest.fn(),
		refreshTokens: jest.fn(),
		clearError: jest.fn(),
		verify: jest.fn(),
		onboarding: jest.fn(),
	})),
}))

// Mock auth actions hooks
jest.mock('./lib/auth/hooks/use-auth-actions', () => ({
	useSignup: jest.fn(() => ({
		signup: jest.fn(),
		isLoading: false,
		error: null,
		clearError: jest.fn(),
	})),
	useSocialLogin: jest.fn(() => ({
		socialLogin: jest.fn(),
		isLoading: false,
		error: null,
		clearError: jest.fn(),
	})),
	useLogin: jest.fn(() => ({
		login: jest.fn(),
		isLoading: false,
		error: null,
		clearError: jest.fn(),
	})),
	useAuthActions: jest.fn(() => ({
		login: jest.fn(),
		signup: jest.fn(),
		socialLogin: jest.fn(),
		logout: jest.fn(),
		refreshTokens: jest.fn(),
		clearError: jest.fn(),
	})),
	useAuthState: jest.fn(() => ({
		user: null,
		tokens: null,
		isLoading: false,
		error: null,
		isAuthenticated: false,
	})),
}))

// Mock OAuth hooks
jest.mock('./lib/auth/hooks/use-oauth', () => ({
	useOAuthProviders: jest.fn(() => ({
		configuredProviders: ['github', 'google'],
		availableProviders: ['github', 'google'],
		getProviderInfo: jest.fn(),
		isProviderConfigured: jest.fn(() => true),
	})),
	useOAuth: jest.fn(() => ({
		authenticate: jest.fn(),
		isLoading: false,
		error: null,
		clearError: jest.fn(),
		availableProviders: ['github', 'google'],
		isProviderConfigured: jest.fn(() => true),
	})),
}))

// Mock navigation utilities
jest.mock('./lib/navigation', () => ({
	navigateToSignIn: jest.fn(),
	navigateAfterAuth: jest.fn(),
}))

// Mock keyboard utilities
jest.mock('./lib/keyboard', () => ({
	dismissKeyboard: jest.fn(),
}))

// Mock haptics utilities
jest.mock('./lib/haptics', () => ({
	triggerSuccessHaptic: jest.fn(),
	triggerErrorHaptic: jest.fn(),
}))

// Mock keyboard utilities
jest.mock('./lib/keyboard', () => ({
	getKeyboardConfig: jest.fn((inputType) => {
		switch (inputType) {
			case 'email':
				return {
					keyboardType: 'email-address',
					returnKeyType: 'next',
					autoCapitalize: 'none',
					autoCorrect: false,
				}
			case 'password':
				return {
					keyboardType: 'default',
					returnKeyType: 'done',
					autoCapitalize: 'none',
					autoCorrect: false,
					secureTextEntry: true,
				}
			case 'username':
				return {
					keyboardType: 'default',
					returnKeyType: 'next',
					autoCapitalize: 'none',
					autoCorrect: false,
				}
			default:
				return {
					keyboardType: 'default',
					returnKeyType: 'done',
					autoCapitalize: 'none',
					autoCorrect: false,
				}
		}
	}),
}))

// Mock UI components
jest.mock('./components/ui', () => ({
	Screen: 'Screen',
	Card: 'Card',
	CardHeader: 'CardHeader',
	CardContent: 'CardContent',
	CardFooter: 'CardFooter',
	Input: 'Input',
	Button: 'Button',
	ErrorText: 'ErrorText',
	Divider: 'Divider',
	SocialButton: 'SocialButton',
	LoadingOverlay: 'LoadingOverlay',
	SuccessAnimation: 'SuccessAnimation',
}))
