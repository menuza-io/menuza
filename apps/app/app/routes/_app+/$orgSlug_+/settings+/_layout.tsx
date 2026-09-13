import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'

import { PageTitle } from '@repo/ui/page-title'
import { Outlet } from 'react-router'

export default function SettingsLayout() {
	const { _ } = useLingui()

	return (
		<div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 py-8 md:px-6 lg:px-8">
			<div className="mb-4">
				<PageTitle
					title={_(t`Settings`)}
					description={_(t`Manage your organization settings and preferences.`)}
				/>
			</div>
			<Outlet />
		</div>
	)
}
