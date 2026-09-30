import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useAuth, type AuthUser, type Role } from "@/hooks/use-auth";
import { UserPlus, KeyRound, Trash2, ShieldCheck, Pencil, Eye } from "lucide-react";

const ROLE_INFO: Record<Role, { label: string; blurb: string; icon: any }> = {
  admin: { label: "Admin", blurb: "Everything, including accounts", icon: ShieldCheck },
  planner: { label: "Planner", blurb: "Upload, optimize, edit plans, export", icon: Pencil },
  viewer: { label: "Viewer", blurb: "Maps, schedules and exports, read-only", icon: Eye },
};

const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never";

export default function UsersPage() {
  const { user: me, isAdmin } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: users = [], isLoading } = useQuery<AuthUser[]>({ queryKey: ["/api/users"], enabled: isAdmin });

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("planner");
  const [password, setPassword] = useState("");

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/users"] });
  const fail = (title: string) => (e: Error) => toast({ title, description: e.message, variant: "destructive" });

  const create = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/users", { email, name, role, password })).json(),
    onSuccess: (u: AuthUser) => { refresh(); setEmail(""); setName(""); setPassword(""); toast({ title: "Account created", description: `${u.name} (${ROLE_INFO[u.role].label}) will be asked to choose a new password at first sign-in.` }); },
    onError: fail("Could not create the account"),
  });
  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Pick<AuthUser, "name" | "role" | "isActive">> & { password?: string } }) => (await apiRequest("PATCH", `/api/users/${id}`, patch)).json(),
    onSuccess: () => refresh(),
    onError: fail("Could not update the account"),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await apiRequest("DELETE", `/api/users/${id}`)).json(),
    onSuccess: () => { refresh(); toast({ title: "Account deleted" }); },
    onError: fail("Could not delete the account"),
  });

  const resetPassword = (u: AuthUser) => {
    const p = window.prompt(`New temporary password for ${u.name} (at least 8 characters). They will be asked to change it at sign-in.`);
    if (!p) return;
    update.mutate({ id: u.id, patch: { password: p } }, { onSuccess: () => toast({ title: "Password reset", description: `${u.name} was signed out everywhere.` }) });
  };

  if (!isAdmin) {
    return (
      <div className="p-4 md:p-6"><div className="mx-auto max-w-3xl rounded-2xl border border-[#e5e5e5] bg-white p-6 text-sm text-[#6e6e73]">Only an admin can manage accounts.</div></div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <p className="text-sm text-[#6e6e73] dark:text-[#98989d]">Who can sign in, and what they may do. Admins manage accounts, planners change the plan, viewers only look.</p>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {(Object.keys(ROLE_INFO) as Role[]).map(r => { const I = ROLE_INFO[r].icon; return (
            <div key={r} className="flex items-start gap-3 rounded-2xl border border-[#e5e5e5] bg-white p-4 dark:border-[#38383a] dark:bg-[#1c1c1e]">
              <I className="mt-0.5 h-5 w-5 text-[#8B0000]" />
              <div><div className="text-sm font-semibold">{ROLE_INFO[r].label}</div><div className="text-xs text-[#6e6e73]">{ROLE_INFO[r].blurb}</div></div>
            </div>
          ); })}
        </div>

        <Card>
          <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><UserPlus className="h-4 w-4" /> Add an account</CardTitle></CardHeader>
          <CardContent>
            <form className="grid grid-cols-1 items-end gap-3 md:grid-cols-5" onSubmit={e => { e.preventDefault(); create.mutate(); }}>
              <div><Label htmlFor="u-name">Name</Label><Input id="u-name" value={name} onChange={e => setName(e.target.value)} placeholder="Full name" className="mt-1" data-testid="input-user-name" /></div>
              <div><Label htmlFor="u-email">Email</Label><Input id="u-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.com" required className="mt-1" data-testid="input-user-email" /></div>
              <div><Label>Role</Label>
                <Select value={role} onValueChange={v => setRole(v as Role)}>
                  <SelectTrigger className="mt-1" data-testid="select-user-role"><SelectValue /></SelectTrigger>
                  <SelectContent>{(Object.keys(ROLE_INFO) as Role[]).map(r => <SelectItem key={r} value={r}>{ROLE_INFO[r].label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label htmlFor="u-pass">Temporary password</Label><Input id="u-pass" type="text" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8} className="mt-1" data-testid="input-user-password" /></div>
              <Button type="submit" disabled={create.isPending} data-testid="button-create-user">{create.isPending ? "Adding…" : "Add account"}</Button>
            </form>
            <p className="mt-2 text-xs text-[#6e6e73]">Share the temporary password with them; they must choose their own at first sign-in.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Accounts</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-users">
                <thead className="border-b border-[#e5e5e5] text-left text-xs uppercase tracking-wide text-[#86868b]">
                  <tr><th className="px-4 py-2">Name</th><th className="px-4 py-2">Email</th><th className="px-4 py-2">Role</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Last sign-in</th><th className="px-4 py-2 text-right">Actions</th></tr>
                </thead>
                <tbody>
                  {isLoading && <tr><td className="px-4 py-3 text-[#6e6e73]" colSpan={6}>Loading…</td></tr>}
                  {users.map(u => {
                    const self = u.id === me?.id;
                    return (
                      <tr key={u.id} className="border-b border-[#f0f0f0] last:border-0 dark:border-[#2c2c2e]" data-testid={`row-user-${u.email}`}>
                        <td className="px-4 py-2.5 font-medium">{u.name}{self && <span className="ml-2 text-xs text-[#86868b]">(you)</span>}</td>
                        <td className="px-4 py-2.5 text-[#6e6e73]">{u.email}</td>
                        <td className="px-4 py-2.5">
                          <Select value={u.role} onValueChange={v => update.mutate({ id: u.id, patch: { role: v as Role } })} disabled={self}>
                            <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>{(Object.keys(ROLE_INFO) as Role[]).map(r => <SelectItem key={r} value={r}>{ROLE_INFO[r].label}</SelectItem>)}</SelectContent>
                          </Select>
                        </td>
                        <td className="px-4 py-2.5">
                          {u.isActive ? <Badge variant="outline" className="border-green-200 bg-green-50 text-green-700">Active</Badge> : <Badge variant="outline" className="border-gray-200 bg-gray-50 text-gray-500">Deactivated</Badge>}
                          {u.mustChangePassword && <span className="ml-2 text-xs text-amber-700">password reset pending</span>}
                        </td>
                        <td className="px-4 py-2.5 text-[#6e6e73]">{fmt(u.lastLoginAt)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" className="h-8" onClick={() => resetPassword(u)} title="Reset password"><KeyRound className="h-4 w-4" /></Button>
                            <Button size="sm" variant="ghost" className="h-8" disabled={self} onClick={() => update.mutate({ id: u.id, patch: { isActive: !u.isActive } })} title={u.isActive ? "Deactivate" : "Reactivate"}>{u.isActive ? "Deactivate" : "Reactivate"}</Button>
                            <Button size="sm" variant="ghost" className="h-8 text-red-600 hover:text-red-700" disabled={self} onClick={() => { if (window.confirm(`Delete ${u.name}'s account? This cannot be undone.`)) remove.mutate(u.id); }} title="Delete"><Trash2 className="h-4 w-4" /></Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
