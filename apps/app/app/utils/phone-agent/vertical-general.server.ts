import {
	availabilityFromSchedule,
	businessProfileFromSettings,
	describeBusiness,
	generalVertical,
} from '@repo/phone-agent'
import { type PhoneAgentServerVertical } from './vertical.server.ts'

/**
 * The neutral server vertical: no scopes, and hours and contact details from
 * `settings.business`.
 */
export const generalServerVertical: PhoneAgentServerVertical = {
	vertical: generalVertical,
	providesBusinessProfile: false,
	listScopes: async () => [],
	findScope: async () => null,
	async configParts({ organization, settings, now }) {
		const business = businessProfileFromSettings(organization.name, settings)
		return {
			ok: true,
			currency: 'USD',
			parts: {
				scopeId: null,
				business,
				availability: availabilityFromSchedule(
					{
						timezone: business.timezone,
						hours: business.hours,
						specialHours: business.specialHours,
					},
					now,
				),
				vertical: { id: generalVertical.id, data: {} },
			},
		}
	},
	faqFacts(config, now) {
		return {
			businessKind: 'a business',
			sections: [
				{
					heading: 'Business facts',
					body: describeBusiness(config.business, now),
				},
			],
		}
	},
}
