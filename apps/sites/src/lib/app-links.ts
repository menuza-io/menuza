import {
	buildAppleAppSiteAssociation,
	buildAssetLinks,
} from '@repo/common/links'
import { type PublicCustomerApp } from '~/lib/customer-app-types'

/**
 * The app-association files of one site (#195), built from the restaurant's
 * own app binding. A site with no app, or an app without the signing data the
 * platform needs, answers 404: nothing is claimed. The files hold the app's
 * identifiers and the link paths only: never a fragment, a token or a visitor.
 * The shared (un-branded) app claims no restaurant domain, so there is nothing
 * to serve for it.
 */
export function appleAssociationFor(
	app: PublicCustomerApp | null | undefined,
): object | null {
	return app ? buildAppleAppSiteAssociation(app.binding) : null
}

export function assetLinksFor(
	app: PublicCustomerApp | null | undefined,
): object | null {
	return app ? buildAssetLinks(app.binding) : null
}

export function associationResponse(body: object | null): Response {
	if (!body) {
		return new Response('Not Found', {
			status: 404,
			headers: { 'Cache-Control': 'no-store' },
		})
	}
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {
			// Apple wants the file served as it is, with no redirect.
			'Content-Type': 'application/json',
			'Cache-Control': 'public, max-age=300, s-maxage=300',
		},
	})
}
