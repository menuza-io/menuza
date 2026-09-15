import { Link } from 'react-router'

import { Icon } from './icon'
import { Button } from './ui/button'

export function NotFoundPage() {
	return (
		<section className="bg-background flex min-h-screen items-center justify-center overflow-hidden py-16 md:py-24">
			<div className="mx-auto w-full max-w-7xl grow px-4 md:px-8">
				<div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-16 text-center">
					<div className="flex flex-col items-center justify-center gap-8 md:gap-12">
						<div className="z-10 flex flex-col items-center justify-center gap-4 md:gap-6">
							<div className="relative">
								{/* Large Icon */}
								<div
									className="bg-background text-muted-foreground ring-border relative z-10 hidden size-14 shrink-0 items-center justify-center rounded-xl shadow-sm ring-1 ring-inset md:flex"
									data-featured-icon="true"
								>
									<Icon name="search" />
								</div>
								{/* Small Icon */}
								<div
									className="bg-background text-muted-foreground ring-border relative z-10 flex size-12 shrink-0 items-center justify-center rounded-lg shadow-sm ring-1 ring-inset md:hidden"
									data-featured-icon="true"
								>
									<Icon name="search" />
								</div>
								{/* Large Grid SVG */}
								<svg
									width="768"
									height="768"
									viewBox="0 0 768 768"
									fill="none"
									className="text-border pointer-events-none absolute top-1/2 left-1/2 z-0 hidden -translate-x-1/2 -translate-y-1/2 md:block"
								>
									<mask
										id="mask0_4933_393109"
										style={{ maskType: 'alpha' }}
										maskUnits="userSpaceOnUse"
										x="0"
										y="0"
										width="768"
										height="768"
									>
										<rect
											width="768"
											height="768"
											fill="url(#paint0_radial_4933_393109)"
										></rect>
									</mask>
									<g mask="url(#mask0_4933_393109)">
										<g clipPath="url(#clip0_4933_393109)">
											<g clipPath="url(#clip1_4933_393109)">
												<line
													x1="0.5"
													x2="0.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="48.5"
													x2="48.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="96.5"
													x2="96.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="144.5"
													x2="144.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="192.5"
													x2="192.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="240.5"
													x2="240.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="288.5"
													x2="288.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="336.5"
													x2="336.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="384.5"
													x2="384.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="432.5"
													x2="432.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="480.5"
													x2="480.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="528.5"
													x2="528.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="576.5"
													x2="576.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="624.5"
													x2="624.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="672.5"
													x2="672.5"
													y2="768"
													stroke="currentColor"
												></line>
												<line
													x1="720.5"
													x2="720.5"
													y2="768"
													stroke="currentColor"
												></line>
											</g>
											<rect
												x="0.5"
												y="0.5"
												width="767"
												height="767"
												stroke="currentColor"
											></rect>
											<g clipPath="url(#clip2_4933_393109)">
												<line
													y1="47.5"
													x2="768"
													y2="47.5"
													stroke="currentColor"
												></line>
												<line
													y1="95.5"
													x2="768"
													y2="95.5"
													stroke="currentColor"
												></line>
												<line
													y1="143.5"
													x2="768"
													y2="143.5"
													stroke="currentColor"
												></line>
												<line
													y1="191.5"
													x2="768"
													y2="191.5"
													stroke="currentColor"
												></line>
												<line
													y1="239.5"
													x2="768"
													y2="239.5"
													stroke="currentColor"
												></line>
												<line
													y1="287.5"
													x2="768"
													y2="287.5"
													stroke="currentColor"
												></line>
												<line
													y1="335.5"
													x2="768"
													y2="335.5"
													stroke="currentColor"
												></line>
												<line
													y1="383.5"
													x2="768"
													y2="383.5"
													stroke="currentColor"
												></line>
												<line
													y1="431.5"
													x2="768"
													y2="431.5"
													stroke="currentColor"
												></line>
												<line
													y1="479.5"
													x2="768"
													y2="479.5"
													stroke="currentColor"
												></line>
												<line
													y1="527.5"
													x2="768"
													y2="527.5"
													stroke="currentColor"
												></line>
												<line
													y1="575.5"
													x2="768"
													y2="575.5"
													stroke="currentColor"
												></line>
												<line
													y1="623.5"
													x2="623.5"
													y2="623.5"
													stroke="currentColor"
												></line>
												<line
													y1="671.5"
													x2="768"
													y2="671.5"
													stroke="currentColor"
												></line>
												<line
													y1="719.5"
													x2="768"
													y2="719.5"
													stroke="currentColor"
												></line>
												<line
													y1="767.5"
													x2="768"
													y2="767.5"
													stroke="currentColor"
												></line>
											</g>
											<rect
												x="0.5"
												y="0.5"
												width="767"
												height="767"
												stroke="currentColor"
											></rect>
										</g>
									</g>
									<defs>
										<radialGradient
											id="paint0_radial_4933_393109"
											cx="0"
											cy="0"
											r="1"
											gradientUnits="userSpaceOnUse"
											gradientTransform="translate(384 384) rotate(90) scale(384 384)"
										>
											<stop></stop>
											<stop offset="1" stopOpacity="0"></stop>
										</radialGradient>
										<clipPath id="clip0_4933_393109">
											<rect width="768" height="768"></rect>
										</clipPath>
										<clipPath id="clip1_4933_393109">
											<rect width="768" height="768"></rect>
										</clipPath>
										<clipPath id="clip2_4933_393109">
											<rect width="768" height="768"></rect>
										</clipPath>
									</defs>
								</svg>
								{/* Small Grid SVG */}
								<svg
									width="480"
									height="480"
									viewBox="0 0 480 480"
									className="text-border pointer-events-none absolute top-1/2 left-1/2 z-0 -translate-x-1/2 -translate-y-1/2 md:hidden"
									fill="none"
								>
									<mask
										id="mask0_4933_393121"
										style={{ maskType: 'alpha' }}
										maskUnits="userSpaceOnUse"
										x="0"
										y="0"
										width="480"
										height="480"
									>
										<rect
											width="480"
											height="480"
											fill="url(#paint0_radial_4933_393121)"
										></rect>
									</mask>
									<g mask="url(#mask0_4933_393121)">
										<g clipPath="url(#clip0_4933_393121)">
											<g clipPath="url(#clip1_4933_393121)">
												<line
													x1="0.5"
													x2="0.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="32.5"
													x2="32.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="64.5"
													x2="64.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="96.5"
													x2="96.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="128.5"
													x2="128.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="160.5"
													x2="160.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="192.5"
													x2="192.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="224.5"
													x2="224.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="256.5"
													x2="256.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="288.5"
													x2="288.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="320.5"
													x2="320.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="352.5"
													x2="352.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="384.5"
													x2="384.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="416.5"
													x2="416.5"
													y2="480"
													stroke="currentColor"
												></line>
												<line
													x1="448.5"
													x2="448.5"
													y2="480"
													stroke="currentColor"
												></line>
											</g>
											<rect
												x="0.5"
												y="0.5"
												width="479"
												height="479"
												stroke="currentColor"
											></rect>
											<g clipPath="url(#clip2_4933_393121)">
												<line
													y1="31.5"
													x2="480"
													y2="31.5"
													stroke="currentColor"
												></line>
												<line
													y1="63.5"
													x2="480"
													y2="63.5"
													stroke="currentColor"
												></line>
												<line
													y1="95.5"
													x2="480"
													y2="95.5"
													stroke="currentColor"
												></line>
												<line
													y1="127.5"
													x2="480"
													y2="127.5"
													stroke="currentColor"
												></line>
												<line
													y1="159.5"
													x2="480"
													y2="159.5"
													stroke="currentColor"
												></line>
												<line
													y1="191.5"
													x2="480"
													y2="191.5"
													stroke="currentColor"
												></line>
												<line
													y1="223.5"
													x2="480"
													y2="223.5"
													stroke="currentColor"
												></line>
												<line
													y1="255.5"
													x2="480"
													y2="255.5"
													stroke="currentColor"
												></line>
												<line
													y1="287.5"
													x2="480"
													y2="287.5"
													stroke="currentColor"
												></line>
												<line
													y1="319.5"
													x2="480"
													y2="319.5"
													stroke="currentColor"
												></line>
												<line
													y1="351.5"
													x2="480"
													y2="351.5"
													stroke="currentColor"
												></line>
												<line
													y1="383.5"
													x2="480"
													y2="383.5"
													stroke="currentColor"
												></line>
												<line
													y1="415.5"
													x2="480"
													y2="415.5"
													stroke="currentColor"
												></line>
												<line
													y1="447.5"
													x2="480"
													y2="447.5"
													stroke="currentColor"
												></line>
												<line
													y1="479.5"
													x2="480"
													y2="479.5"
													stroke="currentColor"
												></line>
											</g>
											<rect
												x="0.5"
												y="0.5"
												width="479"
												height="479"
												stroke="currentColor"
											></rect>
										</g>
									</g>
									<defs>
										<radialGradient
											id="paint0_radial_4933_393121"
											cx="0"
											cy="0"
											r="1"
											gradientUnits="userSpaceOnUse"
											gradientTransform="translate(240 240) rotate(90) scale(240 240)"
										>
											<stop></stop>
											<stop offset="1" stopOpacity="0"></stop>
										</radialGradient>
										<clipPath id="clip0_4933_393121">
											<rect width="480" height="480"></rect>
										</clipPath>
										<clipPath id="clip1_4933_393121">
											<rect width="480" height="480"></rect>
										</clipPath>
										<clipPath id="clip2_4933_393121">
											<rect width="480" height="480"></rect>
										</clipPath>
									</defs>
								</svg>
							</div>
							<h1 className="text-foreground z-10 text-3xl font-semibold md:text-5xl lg:text-6xl">
								Page not found
							</h1>
							<p className="text-muted-foreground z-10 text-lg md:text-xl">
								The page you are looking for doesn&apos;t exist.{' '}
								<br className="max-md:hidden" /> Here are some helpful links:
							</p>
						</div>
						<div className="z-10 flex flex-col-reverse gap-3 self-stretch md:flex-row md:self-auto">
							<Button
								variant="outline"
								size="default"
								className="bg-transparent shadow-sm"
								render={<Link to="/" />}
							>
								<span className="px-0.5">Go back</span>
							</Button>
							<Button
								render={<Link to="/" />}
								variant="default"
								size="default"
								className="shadow-sm"
							>
								<span className="px-0.5">Take me home</span>
							</Button>
						</div>
					</div>
				</div>
			</div>
		</section>
	)
}
