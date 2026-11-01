import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useActionData,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { DiscountForm } from '#app/components/discounts/discount-form.tsx'
import { requireDiscountsAccess } from '#app/utils/discounts/access.server.ts'
import { loadDiscountEditorData } from '#app/utils/discounts/editor-data.server.ts'
import { emptyEditorState } from '#app/utils/discounts/editor-model.ts'
import {
	type DiscountEditorActionData,
	saveDiscountEditor,
} from '#app/utils/discounts/save.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireDiscountsAccess(request, params.orgSlug)
	const editor = await loadDiscountEditorData(access.organization.id)
	const application = access.features.automatic
		? 'automatic'
		: access.features.coupons
			? 'code'
			: 'manual'
	return {
		orgSlug: access.organization.slug,
		currency: access.currency,
		features: access.features,
		canWrite: access.canWrite,
		editor,
		initial: emptyEditorState(application),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const access = await requireDiscountsAccess(request, params.orgSlug, {
		write: true,
	})
	return saveDiscountEditor({ request, params, access })
}

export default function NewDiscountRoute() {
	const data = useLoaderData<typeof loader>()
	const actionData = useActionData<DiscountEditorActionData>()
	const navigation = useNavigation()
	return (
		<DiscountForm
			mode="new"
			orgSlug={data.orgSlug}
			currency={data.currency}
			features={data.features}
			catalog={data.editor.catalog}
			locations={data.editor.locations}
			choices={data.editor.choices}
			initial={data.initial}
			version={null}
			status="paused"
			canWrite={data.canWrite}
			errors={actionData?.errors ?? {}}
			stale={actionData?.stale === true}
			formError={actionData?.formError !== undefined}
			limit={actionData?.limit ?? null}
			isSubmitting={navigation.state === 'submitting'}
		/>
	)
}
