import { type LoaderFunctionArgs, redirect } from 'react-router'

/** Orders moved out of Menu: `/<org>/menu/orders` now lives at `/<org>/orders`. */
export function loader({ request, params }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	return redirect(`/${params.orgSlug || ''}/orders${url.search}`)
}
