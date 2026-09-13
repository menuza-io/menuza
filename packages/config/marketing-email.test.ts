import { describe, expect, it } from 'vitest'
import {
	buildPlatformMarketingResendTags,
	getMarketingEmailHeaderPrefix,
	getMarketingEmailHeaders,
	getMarketingEmailTagNamespace,
	getMarketingEmailTags,
	getMarketingEmailTagValue,
	getMarketingEmailHeaderValue,
	isPlatformMarketingEmailScope,
	LEGACY_MARKETING_EMAIL_HEADERS,
	LEGACY_MARKETING_EMAIL_TAGS,
	MARKETING_EMAIL_PLATFORM_SCOPE,
} from './marketing-email.js'

describe('marketing-email', () => {
	it('derives tag and header names from brand.slug', () => {
		expect(getMarketingEmailTagNamespace()).toBe('menuza')
		expect(getMarketingEmailHeaderPrefix()).toBe('Menuza')
		expect(getMarketingEmailTags()).toEqual({
			scope: 'menuza_scope',
			messageId: 'menuza_message_id',
			campaignId: 'menuza_campaign_id',
		})
		expect(getMarketingEmailHeaders().orgId).toBe('X-Menuza-Org-Id')
	})

	it('builds platform Resend tags', () => {
		expect(buildPlatformMarketingResendTags('msg-1', 'camp-1')).toEqual({
			menuza_scope: MARKETING_EMAIL_PLATFORM_SCOPE,
			menuza_message_id: 'msg-1',
			menuza_campaign_id: 'camp-1',
		})
	})

	it('reads current and legacy Resend tags', () => {
		expect(
			isPlatformMarketingEmailScope({
				[LEGACY_MARKETING_EMAIL_TAGS.scope]: MARKETING_EMAIL_PLATFORM_SCOPE,
			}),
		).toBe(true)
		expect(
			getMarketingEmailTagValue({ menuza_message_id: 'msg-2' }, 'messageId'),
		).toBe('msg-2')
		expect(
			getMarketingEmailTagValue({ epic_message_id: 'legacy-msg' }, 'messageId'),
		).toBe('legacy-msg')
	})

	it('reads current and legacy OCI headers', () => {
		expect(
			getMarketingEmailHeaderValue(
				{ [LEGACY_MARKETING_EMAIL_HEADERS.messageId]: 'legacy' },
				'messageId',
			),
		).toBe('legacy')
		expect(
			getMarketingEmailHeaderValue(
				{ 'X-Menuza-Message-Id': 'current' },
				'messageId',
			),
		).toBe('current')
	})
})
