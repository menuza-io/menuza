/** Client-safe copy for menu catalog gate UI (no server imports). */

export function menuCatalogUnavailableMessage(organization: {
	slug: string
	hasProvisionedDb: boolean
	dataRegion: string | null
}) {
	if (!organization.hasProvisionedDb || organization.dataRegion !== 'us') {
		return {
			title: 'Publish your restaurant site first',
			description:
				'Menu catalog is available after your site is published with a US data region.',
		}
	}
	return {
		title: 'No location configured',
		description: 'Add a restaurant location before editing the menu.',
	}
}
