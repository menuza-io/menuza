import { redirect, type LoaderFunctionArgs } from 'react-router'

export async function loader({ params }: LoaderFunctionArgs) {
	return redirect(`/${params.orgSlug}/menu/items`)
}
