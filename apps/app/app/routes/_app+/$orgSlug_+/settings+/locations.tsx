import { redirect, type LoaderFunctionArgs } from 'react-router'

export async function loader({ params }: LoaderFunctionArgs) {
	const slug = params.orgSlug
	if (!slug) throw new Response('Not Found', { status: 404 })
	throw redirect(`/${slug}/locations`)
}
