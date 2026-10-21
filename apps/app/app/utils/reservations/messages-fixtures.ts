/** Raw GET /setup/message-texts body, as tenant-api returns it. */
export function makeSettingsResponse(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		ok: true,
		orgId: 'org_1',
		locationId: 'loc_1',
		version: 3,
		messaging: {
			kinds: { confirmation: true, reminder: true, reconfirm_request: false },
			reminderHours: 24,
			reconfirmEnabled: false,
			reconfirmHours: 48,
			quietHours: { startMin: 1260, endMin: 480 },
			smsEnabled: true,
		},
		kinds: [
			{
				kind: 'confirmation',
				enabled: true,
				waitlist: false,
				notes: { en: 'See you soon' },
			},
			{
				kind: 'reminder',
				enabled: true,
				waitlist: false,
				notes: {},
			},
			{
				kind: 'reconfirm_request',
				enabled: false,
				waitlist: false,
				notes: {},
			},
			{
				kind: 'waitlist_joined',
				enabled: true,
				waitlist: true,
				notes: {},
			},
		],
		texts: [],
		noteMaxLength: 500,
		...overrides,
	}
}
