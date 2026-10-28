import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";
import BrandMark from "@/components/brand-mark";
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
      <DialogContent className="gap-0 p-0 sm:max-w-[420px]">
        <div className="px-7 pb-2 pt-8 text-center">
          <BrandMark className="mx-auto mb-5 h-11 w-11 drop-shadow-[0_8px_16px_rgba(200,30,45,0.3)]" />
          <DialogHeader className="space-y-1.5 sm:text-center">
            <DialogTitle className="text-xl">{setup ? "Create the first admin account" : "Welcome back"}</DialogTitle>
            <DialogDescription>
              {setup ? "No accounts exist yet. This one becomes the admin; it can add planners and viewers afterwards." : "Sign in to plan your route-to-market."}
            </DialogDescription>
          </DialogHeader>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-7 pb-7 pt-5">
          {setup && (
            <div className="space-y-1.5">
              <Label htmlFor="name">Your name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Walid" data-testid="input-setup-name" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" data-testid="input-login-email" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" placeholder={setup ? "At least 8 characters" : "Your password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={setup ? 8 : undefined} autoComplete={setup ? "new-password" : "current-password"} data-testid="input-login-password" />
          </div>
          {setup && (
            <div className="space-y-1.5">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" data-testid="input-setup-confirm" />
            </div>
          )}
          <Button type="submit" variant="brand" className="mt-2 h-11 w-full" disabled={isLoading} data-testid="button-login-submit">
            {isLoading ? (<><Loader2 className="h-4 w-4 animate-spin" />{setup ? "Creating…" : "Signing in…"}</>) : (setup ? "Create account" : "Sign in")}
          </Button>
        </form>

        <div className="rounded-b-2xl border-t bg-muted/50 px-7 py-3.5 text-center">
          <p className="text-xs text-muted-foreground">Solution developed by Walid El Tayeh</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
