import { describe, expect, it } from 'vitest'
import {
	appleAssociationFor,
	assetLinksFor,
	associationResponse,
} from './app-links'

const app = {
	displayName: 'Acme',
	binding: {
		appleTeamId: 'TEAM123456',
		iosBundleId: 'com.acme.app',
		androidPackage: 'com.acme.app',
		androidSha256: ['AA:'.repeat(31) + 'AA'],
	},
	stores: {},
	invite: { banner: true, confirmation: true, footer: true, bannerText: '' },
}

describe('app-association files (#195)', () => {
	it('names only this site’s own app and its link paths', async () => {
		const response = associationResponse(appleAssociationFor(app))
		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe('application/json')
		const body = (await response.json()) as {
			applinks: { details: Array<{ appIDs: string[] }> }
		}
		expect(body.applinks.details[0]!.appIDs).toEqual([
			'TEAM123456.com.acme.app',
		])
		const android = await associationResponse(assetLinksFor(app)).json()
		expect(JSON.stringify(android)).toContain('com.acme.app')
	})

	it('is a 404 with no app, no team id or no signing fingerprint: nothing is claimed', () => {
		expect(associationResponse(appleAssociationFor(null)).status).toBe(404)
		expect(associationResponse(assetLinksFor(undefined)).status).toBe(404)
		expect(
			associationResponse(
				appleAssociationFor({
					...app,
					binding: { ...app.binding, appleTeamId: null },
				}),
			).status,
		).toBe(404)
		expect(
			associationResponse(
				assetLinksFor({
					...app,
					binding: { ...app.binding, androidSha256: [] },
				}),
			).status,
		).toBe(404)
	})

	it('carries no fragment, token or visitor data', async () => {
		const text = await associationResponse(appleAssociationFor(app)).text()
		expect(text).not.toMatch(/#|link=|token|\bt=/)
	})
})
