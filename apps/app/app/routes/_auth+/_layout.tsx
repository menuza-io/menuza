import { Trans } from '@lingui/macro'
import { Outlet } from 'react-router'
import authBackground from '#app/assets/images/background_1.webp'

export default function AuthLayout() {
	return (
		<main
			className="flex min-h-screen items-center justify-center bg-gradient-to-br from-purple-400 via-pink-500 to-red-500 p-4"
			style={{
				backgroundImage: `url(${authBackground})`,
				backgroundSize: 'cover',
				backgroundPosition: 'center',
				backgroundRepeat: 'no-repeat',
			}}
		>
			<div className="w-full max-w-md">
				<div className="flex flex-col gap-6">
					<Outlet />
					<div className="text-center text-xs text-balance text-white/80 *:[a]:underline *:[a]:underline-offset-4 *:[a]:hover:text-white">
						<Trans>
							By continuing, you agree to our{' '}
							<a href="/tos">Terms of Service</a> and{' '}
							<a href="/privacy">Privacy Policy</a>.
						</Trans>
					</div>
				</div>
			</div>
		</main>
	)
}
