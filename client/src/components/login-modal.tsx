import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";
import { LogIn, Loader2, AlertTriangle } from "lucide-react";

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: () => void;
}

export default function LoginModal({ isOpen, onClose, onLoginSuccess }: LoginModalProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  // When no admin exists yet every login is rejected, which reads like a wrong
  // password. Ask the server up front so we can say what is actually wrong.
  const { data: authStatus } = useQuery<{ adminConfigured?: boolean }>({
    queryKey: ["/api/auth/status"],
    enabled: isOpen,
  });
  const adminConfigured = authStatus?.adminConfigured !== false;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const response = await apiRequest("POST", "/api/auth/login", { email, password });
      const data = await response.json();

      if (data.success) {
        toast({
          title: "Login Successful",
          description: "Welcome! You now have full access.",
        });
        queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
        onLoginSuccess();
        onClose();
      }
    } catch (error: any) {
      toast({
        title: "Login Failed",
        description: error.message || "Invalid credentials. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LogIn className="h-5 w-5" />
            Admin Login
          </DialogTitle>
        </DialogHeader>
        
        {!adminConfigured && (
          <div
            className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
            data-testid="alert-admin-not-configured"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="space-y-2">
                <p className="font-medium">No admin login has been set up yet.</p>
                <p>Open the shell and run this once, then restart the app:</p>
                <code className="block rounded bg-amber-100 px-2 py-1 font-mono text-xs break-all">
                  npm run set-admin -- you@example.com "your-password"
                </code>
                <p className="text-xs">
                  Your password is salted and hashed into <code>data/admin.json</code>, which is
                  never committed. Setting <code>SUPERUSER_EMAIL</code> and{" "}
                  <code>SUPERUSER_PASSWORD</code> as secrets works too.
                </p>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          
          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || !adminConfigured}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Logging in...
                </>
              ) : (
                "Login"
              )}
            </Button>
          </div>
        </form>
        
        <div className="mt-6 pt-4 border-t text-center">
          <p className="text-xs text-gray-500">Solution developed by Walid El Tayeh</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
