import { createSecurePreferences } from './preferences'

describe('createSecurePreferences', () => {
	it('round-trips the site address and the language', async () => {
		const preferences = createSecurePreferences()

		expect(await preferences.loadSiteAddress()).toBeNull()
		expect(await preferences.loadLanguageOverride()).toBeNull()

		await preferences.saveSiteAddress({
			slug: 'acme',
			host: null,
			origin: 'https://acme.epic-startup.com',
		})
		await preferences.saveLanguageOverride('ar')

		expect(await preferences.loadSiteAddress()).toEqual({
			slug: 'acme',
			host: null,
			origin: 'https://acme.epic-startup.com',
		})
		expect(await preferences.loadLanguageOverride()).toBe('ar')

		await preferences.saveSiteAddress(null)
		await preferences.saveLanguageOverride(null)
		expect(await preferences.loadSiteAddress()).toBeNull()
		expect(await preferences.loadLanguageOverride()).toBeNull()
	})

	it('ignores a stored address that binds nothing', async () => {
		const preferences = createSecurePreferences()
		await preferences.saveSiteAddress({
			slug: null,
			host: null,
			origin: 'https://x.com',
		})
		expect(await preferences.loadSiteAddress()).toBeNull()
	})
})
