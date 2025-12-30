import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Users, Plus, Trash2, Save, ArrowDown, RefreshCw, Calendar, Loader2 } from "lucide-react";
import type { Rep, RoleHierarchy } from "@shared/schema";

interface RoleConfig {
  role: string;
  roleName: string;
  offsetDays: number;
  colorHex: string;
  isActive: boolean;
}

const DEFAULT_PRESETS: RoleConfig[] = [
  { role: 'rep', roleName: 'Sales Rep', offsetDays: 0, colorHex: '#3B82F6', isActive: true },
  { role: 'merchandiser', roleName: 'Merchandiser', offsetDays: 1, colorHex: '#10B981', isActive: true },
  { role: 'collection_agent', roleName: 'Collection Agent', offsetDays: 2, colorHex: '#F59E0B', isActive: true },
];

export default function RoleHierarchyPage() {
  const { toast } = useToast();
  const [selectedRepId, setSelectedRepId] = useState<string>("");
  const [roles, setRoles] = useState<RoleConfig[]>([...DEFAULT_PRESETS]);

  const { data: reps = [], isLoading: repsLoading } = useQuery<Rep[]>({
    queryKey: ['/api/reps'],
  });

  const { data: existingHierarchies = [], isLoading: hierarchiesLoading } = useQuery<RoleHierarchy[]>({
    queryKey: ['/api/reps', selectedRepId, 'hierarchies'],
    enabled: !!selectedRepId,
  });

  useEffect(() => {
    if (existingHierarchies.length > 0) {
      setRoles(existingHierarchies.map(h => ({
        role: h.role,
        roleName: h.roleName,
        offsetDays: h.offsetDays,
        colorHex: h.colorHex,
        isActive: h.isActive
      })));
    } else if (selectedRepId) {
      setRoles([...DEFAULT_PRESETS]);
    }
  }, [existingHierarchies, selectedRepId]);

  const saveHierarchyMutation = useMutation({
    mutationFn: async (data: { repId: string; roles: RoleConfig[] }) => {
      return apiRequest('POST', `/api/reps/${data.repId}/hierarchies`, { roles: data.roles });
    },
    onSuccess: (_, variables) => {
      toast({
        title: "Hierarchy Saved",
        description: "Role hierarchy has been saved and schedules generated.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/reps', variables.repId, 'hierarchies'] });
      queryClient.invalidateQueries({ queryKey: ['/api/role-schedules'] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to save hierarchy",
        variant: "destructive",
      });
    },
  });

  const regenerateSchedulesMutation = useMutation({
    mutationFn: async (repId: string) => {
      return apiRequest('POST', `/api/reps/${repId}/regenerate-role-schedules`);
    },
    onSuccess: (_, repId) => {
      toast({
        title: "Schedules Regenerated",
        description: "Role schedules have been regenerated based on the current hierarchy.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/reps', repId, 'role-schedules'] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to regenerate schedules",
        variant: "destructive",
      });
    },
  });

  const handleAddRole = () => {
    const newRole: RoleConfig = {
      role: `custom_role_${Date.now()}`,
      roleName: 'Custom Role',
      offsetDays: roles.length,
      colorHex: '#9333EA',
      isActive: true
    };
    setRoles([...roles, newRole]);
  };

  const handleRemoveRole = (index: number) => {
    if (roles[index].role === 'rep') {
      toast({
        title: "Cannot Remove",
        description: "Sales Rep is the base role and cannot be removed.",
        variant: "destructive",
      });
      return;
    }
    setRoles(roles.filter((_, i) => i !== index));
  };

  const handleRoleChange = (index: number, field: keyof RoleConfig, value: string | number | boolean) => {
    const updated = [...roles];
    updated[index] = { ...updated[index], [field]: value };
    setRoles(updated);
  };

  const handleSave = () => {
    if (!selectedRepId) {
      toast({
        title: "Select a Rep",
        description: "Please select a Sales Rep to configure the hierarchy for.",
        variant: "destructive",
      });
      return;
    }
    saveHierarchyMutation.mutate({ repId: selectedRepId, roles });
  };

  const handleResetToDefaults = () => {
    setRoles([...DEFAULT_PRESETS]);
  };

  const selectedRep = reps.find(r => r.id === selectedRepId);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
            <Users className="h-8 w-8 text-primary" />
            Role Hierarchy Configuration
          </h1>
          <p className="text-gray-600 mt-1">
            Configure follow-up roles that visit the same outlets after the Sales Rep
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Select Sales Rep</CardTitle>
            <CardDescription>
              Choose a Sales Rep to configure their role hierarchy
            </CardDescription>
          </CardHeader>
          <CardContent>
            {repsLoading ? (
              <div className="flex items-center gap-2 text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading reps...
              </div>
            ) : reps.length === 0 ? (
              <p className="text-gray-500">No Sales Reps found. Please create reps first from the Territory Map.</p>
            ) : (
              <Select value={selectedRepId} onValueChange={setSelectedRepId}>
                <SelectTrigger data-testid="select-rep">
                  <SelectValue placeholder="Select a Sales Rep..." />
                </SelectTrigger>
                <SelectContent>
                  {reps.map(rep => (
                    <SelectItem key={rep.id} value={rep.id} data-testid={`rep-option-${rep.id}`}>
                      {rep.name} ({rep.code}) - {rep.territory}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How It Works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-gray-600">
            <div className="flex items-start gap-2">
              <Badge variant="outline" className="shrink-0">1</Badge>
              <span>Sales Rep visits outlets on Day X</span>
            </div>
            <div className="flex items-start gap-2">
              <Badge variant="outline" className="shrink-0">2</Badge>
              <span>Merchandiser follows on Day X + 1</span>
            </div>
            <div className="flex items-start gap-2">
              <Badge variant="outline" className="shrink-0">3</Badge>
              <span>Collection Agent follows on Day X + 2</span>
            </div>
            <p className="text-xs text-gray-500 mt-4">
              All roles follow the same route order and outlet sequence as the Sales Rep.
            </p>
          </CardContent>
        </Card>
      </div>

      {selectedRepId && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Role Hierarchy for {selectedRep?.name}</CardTitle>
              <CardDescription>
                Define roles and their day offsets from the Sales Rep's visit
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleResetToDefaults} data-testid="btn-reset-defaults">
                <RefreshCw className="h-4 w-4 mr-2" />
                Reset to Defaults
              </Button>
              <Button variant="outline" size="sm" onClick={handleAddRole} data-testid="btn-add-role">
                <Plus className="h-4 w-4 mr-2" />
                Add Role
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {hierarchiesLoading ? (
              <div className="flex items-center gap-2 text-gray-500 py-8 justify-center">
                <Loader2 className="h-5 w-5 animate-spin" />
                Loading hierarchy...
              </div>
            ) : (
              <div className="space-y-4">
                {roles.map((role, index) => (
                  <div key={index}>
                    <div
                      className="flex items-center gap-4 p-4 rounded-lg border"
                      style={{ borderLeftColor: role.colorHex, borderLeftWidth: '4px' }}
                    >
                      <div className="flex-1 grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div>
                          <Label className="text-xs text-gray-500">Role Name</Label>
                          <Input
                            value={role.roleName}
                            onChange={(e) => handleRoleChange(index, 'roleName', e.target.value)}
                            disabled={role.role === 'rep'}
                            data-testid={`input-role-name-${index}`}
                          />
                        </div>
                        <div>
                          <Label className="text-xs text-gray-500">Day Offset</Label>
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              value={role.offsetDays}
                              onChange={(e) => handleRoleChange(index, 'offsetDays', parseInt(e.target.value) || 0)}
                              min={0}
                              max={10}
                              disabled={role.role === 'rep'}
                              data-testid={`input-offset-${index}`}
                            />
                            <span className="text-sm text-gray-500 whitespace-nowrap">
                              {role.offsetDays === 0 ? '(Same day)' : `(+${role.offsetDays} day${role.offsetDays > 1 ? 's' : ''})`}
                            </span>
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs text-gray-500">Color</Label>
                          <div className="flex items-center gap-2">
                            <input
                              type="color"
                              value={role.colorHex}
                              onChange={(e) => handleRoleChange(index, 'colorHex', e.target.value)}
                              className="w-10 h-10 rounded border cursor-pointer"
                              data-testid={`input-color-${index}`}
                            />
                            <span className="text-sm text-gray-500">{role.colorHex}</span>
                          </div>
                        </div>
                        <div className="flex items-end gap-4">
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={role.isActive}
                              onCheckedChange={(checked) => handleRoleChange(index, 'isActive', checked)}
                              disabled={role.role === 'rep'}
                              data-testid={`switch-active-${index}`}
                            />
                            <Label className="text-sm">Active</Label>
                          </div>
                          {role.role !== 'rep' && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-red-500 hover:text-red-700 hover:bg-red-50"
                              onClick={() => handleRemoveRole(index)}
                              data-testid={`btn-remove-role-${index}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                    {index < roles.length - 1 && (
                      <div className="flex justify-center py-2">
                        <ArrowDown className="h-4 w-4 text-gray-400" />
                      </div>
                    )}
                  </div>
                ))}

                <div className="flex justify-end gap-3 pt-4 border-t">
                  <Button
                    variant="outline"
                    onClick={() => regenerateSchedulesMutation.mutate(selectedRepId)}
                    disabled={regenerateSchedulesMutation.isPending}
                    data-testid="btn-regenerate-schedules"
                  >
                    {regenerateSchedulesMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Calendar className="h-4 w-4 mr-2" />
                    )}
                    Regenerate Schedules
                  </Button>
                  <Button
                    onClick={handleSave}
                    disabled={saveHierarchyMutation.isPending}
                    data-testid="btn-save-hierarchy"
                  >
                    {saveHierarchyMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    Save Hierarchy
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Schedule Preview</CardTitle>
          <CardDescription>
            Visual representation of how roles follow the Sales Rep's schedule
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-3 font-medium">Role</th>
                  <th className="text-center py-2 px-3 font-medium">Mon</th>
                  <th className="text-center py-2 px-3 font-medium">Tue</th>
                  <th className="text-center py-2 px-3 font-medium">Wed</th>
                  <th className="text-center py-2 px-3 font-medium">Thu</th>
                  <th className="text-center py-2 px-3 font-medium">Fri</th>
                </tr>
              </thead>
              <tbody>
                {roles.filter(r => r.isActive).map((role, roleIdx) => (
                  <tr key={roleIdx} className="border-b">
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full"
                          style={{ backgroundColor: role.colorHex }}
                        />
                        <span>{role.roleName}</span>
                        <Badge variant="outline" className="text-xs">
                          +{role.offsetDays}
                        </Badge>
                      </div>
                    </td>
                    {[1, 2, 3, 4, 5].map(day => {
                      const repVisitDay = day;
                      const thisRoleDay = repVisitDay + role.offsetDays;
                      const adjustedDay = thisRoleDay > 5 ? thisRoleDay - 5 : thisRoleDay;
                      const isVisitDay = adjustedDay === day;

                      return (
                        <td key={day} className="text-center py-2 px-3">
                          {isVisitDay && (
                            <div
                              className="w-6 h-6 rounded-full mx-auto flex items-center justify-center text-white text-xs"
                              style={{ backgroundColor: role.colorHex }}
                            >
                              {role.offsetDays === 0 ? 'R' : role.role === 'merchandiser' ? 'M' : 'C'}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 mt-4">
            This preview shows Week 1. If Rep visits outlets on Monday, Merchandiser visits Tuesday, Collection Agent visits Wednesday.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
