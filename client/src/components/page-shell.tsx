import type { ReactNode } from "react";

/**
 * The frame every page sits in: the same gutters, the same width, and one
 * optional row for a description and the page's actions. The page title
 * itself lives in the app header, so nothing is said twice.
 */
export default function PageShell({ description, actions, children, wide, flush }: { description?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean; flush?: boolean }) {
  return (
    <div className={flush ? "h-full" : "p-4 md:p-6"}>
      <div className={`${wide ? "max-w-[1600px]" : "max-w-7xl"} mx-auto ${flush ? "h-full" : ""}`}>
        {(description || actions) && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            {description ? <p className="text-sm text-[#6e6e73] dark:text-[#98989d]">{description}</p> : <span />}
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
