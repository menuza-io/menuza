import { type LoaderFunctionArgs, redirect } from 'react-router'

export function loader({ params }: LoaderFunctionArgs) {
	return redirect(`/${params.orgSlug}/settings/terminals`)
}
