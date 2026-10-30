import Constants from 'expo-constants'
import * as Localization from 'expo-localization'
import { Platform } from 'react-native'
import { type HttpTransport } from '../api/http'
import {
	configurationFromBuild,
	resolveDevelopmentMachineHost,
	rewriteLoopbackEndpoints,
	type TenantConfiguration,
} from '../config/configuration'
import { APP_LOCALES } from '../i18n/lingui'
import { forgetAllReservationTokens } from '../reservations/token-store'
import { forgetPreviousInstall } from '../session/reinstall-guard'
import { createSecureTokenStorage } from '../session/token-storage'
import { AppStore } from '../state/app-store'
import {
	createSecurePreferences,
	type PreferencesStorage,
} from '../state/preferences'
import { createCustomerFeatures, type AppFeatures } from './features'

/** The device languages, most preferred first. */
export function deviceLanguageTags(): readonly string[] {
	return Localization.getLocales().map((locale) => locale.languageTag)
}

/** The build-time configuration shipped in the binary (`app.config.ts`). */
export function buildConfiguration(): TenantConfiguration {
	const base = configurationFromBuild(Constants.expoConfig?.extra?.customer, {
		platform: Platform.OS,
	})
	if (!__DEV__) return base
	const extra =
		Constants.expoConfig?.extra?.customer &&
		typeof Constants.expoConfig.extra.customer === 'object'
			? (Constants.expoConfig.extra.customer as Record<string, unknown>)
			: null
	const machineHost = resolveDevelopmentMachineHost({
		configuredHost:
			typeof extra?.devMachineHost === 'string' ? extra.devMachineHost : null,
		debuggerHost: Constants.expoGoConfig?.debuggerHost,
		hostUri: Constants.expoConfig?.hostUri,
		linkingUri: Constants.linkingUri,
		experienceUrl: Constants.experienceUrl,
	})
	return machineHost ? rewriteLoopbackEndpoints(base, machineHost) : base
}

export function createAppStore(options: {
	configuration?: TenantConfiguration
	preferences?: PreferencesStorage
	tokenStorage?: ReturnType<typeof createSecureTokenStorage>
	transport?: HttpTransport
	deviceLanguages?: () => readonly string[]
	prepareStorage?: () => Promise<unknown>
}): AppStore<AppFeatures> {
	let store: AppStore<AppFeatures> | null = null
	store = new AppStore<AppFeatures>({
		configuration: options.configuration ?? buildConfiguration(),
		preferences: options.preferences ?? createSecurePreferences(),
		tokenStorage: options.tokenStorage ?? createSecureTokenStorage(),
		deviceLanguages: options.deviceLanguages ?? deviceLanguageTags,
		appLocales: APP_LOCALES,
		transport: options.transport,
		prepareStorage: options.prepareStorage ?? (() => forgetPreviousInstall()),
		forgetSiteData: forgetAllReservationTokens,
		createFeatures: (context) =>
			createCustomerFeatures(context, {
				// The callback fires on a loyalty answer, never during construction.
				onSessionEnded: () => void store?.signOut(),
			}),
	})
	return store
}
