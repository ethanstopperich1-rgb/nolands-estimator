/**
 * Layout for the /estimate route — the V3 pin-confirmed Gemini-painted
 * estimator. Wraps the page in the visionOS Liquid Glass environment
 * with a centered, bounded container.
 */
export default function EstimateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="relative z-[1] lg-env min-h-[100dvh]">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-10 py-6 sm:py-8">
        {children}
      </div>
    </main>
  );
}
