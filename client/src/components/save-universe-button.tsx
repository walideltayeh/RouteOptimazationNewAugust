import { Save } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useSaveUniverse, useUniverse } from "@/hooks/use-universe";

/**
 * Saves the outlet universe as it stands after lasso deletes and moves, as
 * "<file> Universe Edited v.N.xlsx". The badge counts the outlets deleted or
 * moved since the last save; the tooltip names the file that will be made.
 * Hidden for view-only accounts.
 */
export default function SaveUniverseButton({ label = "Save edited universe", showName = false, ...props }: ButtonProps & { label?: string; showName?: boolean }) {
  const { canEdit } = useAuth();
  const { data: universe } = useUniverse(canEdit);
  const save = useSaveUniverse();
  if (!canEdit || !universe || universe.outlets === 0) return null;
  const edits = universe.editsSinceSave;
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-9"
      disabled={save.isPending}
      onClick={() => save.mutate(universe.nextFileName)}
      title={`Save as "${universe.nextFileName}"`}
      data-testid="button-save-universe"
      {...props}
    >
      <Save className="h-4 w-4" />
      {save.isPending ? "Saving…" : showName ? `Save as ${universe.nextFileName.replace(/\.xlsx$/, "")}` : label}
      {edits > 0 && !save.isPending && (
        <span className={`ml-0.5 rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums leading-4 ${props.variant === "brand" ? "bg-white/25 text-white" : "bg-primary text-primary-foreground"}`} data-testid="badge-unsaved-edits" title={`${edits} outlet edit${edits === 1 ? "" : "s"} not saved yet`}>
          {edits.toLocaleString()}
        </span>
      )}
    </Button>
  );
}
