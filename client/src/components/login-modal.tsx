import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { LogIn, Loader2, UserPlus } from "lucide-react";
import type { AuthStatus } from "@/hooks/use-auth";

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: () => void;
}

/**
 * Sign in, or, on a fresh install with no accounts at all, create the first
 * admin right here. The old flow needed a shell command and a restart.
 */
export default function LoginModal({ isOpen, onClose, onLoginSuccess }: LoginModalProps) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const { data: authStatus } = useQuery<AuthStatus>({ queryKey: ["/api/auth/status"], enabled: isOpen });
  const setup = !!authStatus?.setupRequired;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (setup && password !== confirm) {
      toast({ title: "Passwords differ", description: "Type the same password twice.", variant: "destructive" });
      return;
    }
    setIsLoading(true);
    try {
      const response = setup
        ? await apiRequest("POST", "/api/auth/setup", { email, name, password })
        : await apiRequest("POST", "/api/auth/login", { email, password });
      const data = await response.json();
      if (data.success) {
        toast({ title: setup ? "Admin account created" : "Signed in", description: `Welcome, ${data.user?.name || email}.` });
        queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
        onLoginSuccess();
        onClose();
      }
    } catch (error: any) {
      toast({ title: setup ? "Could not create the account" : "Sign-in failed", description: error.message || "Please try again.", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {setup ? <UserPlus className="h-5 w-5" /> : <LogIn className="h-5 w-5" />}
            {setup ? "Create the first admin account" : "Sign in"}
          </DialogTitle>
        </DialogHeader>

        {setup && (
          <p className="text-sm text-[#6e6e73]" data-testid="text-setup-intro">
            No accounts exist yet. This one becomes the admin; it can add planners and viewers afterwards.
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          {setup && (
            <div className="space-y-2">
              <Label htmlFor="name">Your name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Walid" data-testid="input-setup-name" />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" data-testid="input-login-email" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" placeholder={setup ? "At least 8 characters" : "Your password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={setup ? 8 : undefined} autoComplete={setup ? "new-password" : "current-password"} data-testid="input-login-password" />
          </div>
          {setup && (
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" data-testid="input-setup-confirm" />
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={isLoading} data-testid="button-login-submit">
              {isLoading ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />{setup ? "Creating…" : "Signing in…"}</>) : (setup ? "Create account" : "Sign in")}
            </Button>
          </div>
        </form>

        <div className="mt-4 pt-4 border-t text-center">
          <p className="text-xs text-gray-500">Solution developed by Walid El Tayeh</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
