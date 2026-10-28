/** The number of a step in the detailed planning flow, beside its title. */
export default function StepBadge({ n }: { n: number }) {
  return (
    <span className="mr-2.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold tabular-nums text-primary ring-1 ring-inset ring-primary/15">
      {n}
    </span>
  );
}
