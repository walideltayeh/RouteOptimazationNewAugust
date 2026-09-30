import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { KeyRound, Loader2 } from "lucide-react";

/** Change your own password. With `required`, it cannot be dismissed. */
export default function ChangePasswordDialog({ isOpen, onClose, required }: { isOpen: boolean; onClose: () => void; required?: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) { toast({ title: "Passwords differ", description: "Type the new password twice.", variant: "destructive" }); return; }
    setBusy(true);
    try {
      await apiRequest("POST", "/api/auth/change-password", { currentPassword: current, newPassword: next });
      toast({ title: "Password changed" });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
      setCurrent(""); setNext(""); setConfirm("");
      onClose();
    } catch (err: any) {
      toast({ title: "Could not change the password", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !required) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" /> {required ? "Choose a new password" : "Change password"}</DialogTitle>
        </DialogHeader>
        {required && <p className="text-sm text-[#6e6e73]">Your password was set by an admin. Pick your own before you carry on.</p>}
        <form onSubmit={submit} className="space-y-4 mt-2">
          <div className="space-y-2"><Label htmlFor="cur">Current password</Label><Input id="cur" type="password" value={current} onChange={e => setCurrent(e.target.value)} required autoComplete="current-password" data-testid="input-current-password" /></div>
          <div className="space-y-2"><Label htmlFor="new">New password</Label><Input id="new" type="password" value={next} onChange={e => setNext(e.target.value)} required minLength={8} autoComplete="new-password" data-testid="input-new-password" /></div>
          <div className="space-y-2"><Label htmlFor="conf">Confirm new password</Label><Input id="conf" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" data-testid="input-confirm-password" /></div>
          <div className="flex justify-end gap-2 pt-2">
            {!required && <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>}
            <Button type="submit" disabled={busy} data-testid="button-change-password">{busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : "Save"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
