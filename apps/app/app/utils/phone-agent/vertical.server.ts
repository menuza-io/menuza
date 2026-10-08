import {
	type PhoneAgentRuntimeConfig,
	type PhoneAgentSettings,
	type PhoneAgentVertical,
} from '@repo/phone-agent'
import { generalServerVertical } from './vertical-general.server.ts'

/** Something owners narrow numbers, rules, and saved answers to. */
export type PhoneAgentScope = {
	id: string
	name: string
	phone: string | null
	isActive: boolean
	isDefault: boolean
}

export type ConfigOrganization = {
	id: string
	name: string
	slug: string
	siteDefaultLocale: string | null
	siteLocales: string | null
	dataRegion: string
}

export type ConfigPartsResult =
	| {
			ok: true
			parts: Pick<
				PhoneAgentRuntimeConfig,
				'scopeId' | 'business' | 'availability' | 'vertical'
			>
			currency: string
	  }
	| { ok: false; reason: 'scope_unavailable' | 'scope_not_found' }

/** Background facts the FAQ drafting prompt may answer from. */
export type FaqFacts = {
	/** How the prompt names the business, e.g. "a dental clinic". */
	businessKind: string
	sections: Array<{ heading: string; body: string }>
}

/**
 * The server half of a phone agent vertical: where its scopes and business
 * data come from. Pairs with `phoneAgentVertical` in `vertical.ts`.
 */
export type PhoneAgentServerVertical = {
	vertical: PhoneAgentVertical
	/**
	 * True when hours, phone, and address come from the vertical's own records,
	 * so Settings hides the business hours editor.
	 */
	providesBusinessProfile: boolean
	/** Active scopes, default first. Empty for verticals without scopes. */
	listScopes(organizationId: string): Promise<PhoneAgentScope[]>
	/** The org's scope with this id, active or not. */
	findScope(
		organizationId: string,
		scopeId: string,
	): Promise<PhoneAgentScope | null>
	/**
	 * The scope-dependent parts of a runtime config. With `strictScope`, a
	 * missing or inactive scope fails instead of falling back to the default.
	 */
	configParts(input: {
		organization: ConfigOrganization
		scopeId: string | null
		settings: PhoneAgentSettings
		now: Date
		strictScope: boolean
	}): Promise<ConfigPartsResult>
	faqFacts(config: PhoneAgentRuntimeConfig, now: Date): FaqFacts
	/**
	 * Data for the vertical's Advanced page section (`SettingsSection` in
	 * `vertical-ui.tsx`), from the default scope's config when there is one.
	 */
	advancedPageData?(config: PhoneAgentRuntimeConfig | null): unknown
}

/**
 * The server vertical this deployment runs. Upstream ships
 * `generalServerVertical` from `./vertical-general.server.ts`; a fork swaps
 * in its own here.
 */
export const phoneAgentServerVertical: PhoneAgentServerVertical =
	generalServerVertical
