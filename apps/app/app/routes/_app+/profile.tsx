import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { parseFormData } from '@mjackson/form-data-parser'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { requireUserId } from '@repo/auth'
import { brand } from '@repo/config/brand'
import { db, eq, User, UserImage } from '@repo/database'
import { generateSeoMeta } from '@repo/seo'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspacePage } from '@repo/ui/workspace'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	type MetaFunction,
	useLoaderData,
} from 'react-router'
import { ProfileCard } from '#app/components/settings/cards/profile-card.tsx'

import { changeEmailAction } from '../settings+/actions/email.actions'
import { photoAction } from '../settings+/actions/photo.actions'
import { profileUpdateAction } from '../settings+/actions/profile.actions'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

export const meta: MetaFunction = () => {
	// Protected routes should not be indexed by search engines
	return generateSeoMeta({
		title: `Profile Settings | ${brand.name}`,
		description: 'Manage your account settings and set e-mail preferences.',
		robots: {
			index: false,
			follow: false,
		},
	})
}

// Photo upload schema
const MAX_SIZE = 1024 * 1024 * 3 // 3MB

export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const [userRow] = await db
		.select({
			id: User.id,
			name: User.name,
			username: User.username,
			email: User.email,
		})
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	if (!userRow) throw new Response('User not found', { status: 404 })
	const [image] = await db
		.select({ objectKey: UserImage.objectKey })
		.from(UserImage)
		.where(eq(UserImage.userId, userId))
		.limit(1)
	const user = { ...userRow, image }

	return {
		user,
	}
}

export const profileUpdateActionIntent = 'update-profile'
export const changeEmailActionIntent = 'change-email'
export const uploadPhotoActionIntent = 'upload-photo'
export const deletePhotoActionIntent = 'delete-photo'

export async function action({ request }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const contentType = request.headers.get('content-type')

	let intent

	if (contentType?.includes('multipart/form-data')) {
		const formData = await parseFormData(request, { maxFileSize: MAX_SIZE })
		intent = formData.get('intent')

		if (
			intent === uploadPhotoActionIntent ||
			intent === deletePhotoActionIntent
		) {
			return photoAction({ userId, formData, request })
		}
	}

	const formData = await request.formData()
	intent = formData.get('intent')

	switch (intent) {
		case profileUpdateActionIntent: {
			return profileUpdateAction({ userId, formData })
		}
		case changeEmailActionIntent: {
			return changeEmailAction({ request, userId, formData })
		}
		default: {
			throw new Response(`Invalid intent "${intent}"`, { status: 400 })
		}
	}
}

export default function ProfileSettings() {
	const data = useLoaderData<typeof loader>()
	const { _ } = useLingui()

	return (
		<WorkspacePage className="max-w-4xl">
			<PageHeader
				title={_(t`Profile Settings`)}
				description={_(
					t`Manage your account settings and set e-mail preferences.`,
				)}
			/>
			<AnnotatedLayout>
				<AnnotatedSection>
					<ProfileCard user={data.user} />
				</AnnotatedSection>
			</AnnotatedLayout>
		</WorkspacePage>
	)
}
