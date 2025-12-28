import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  Car, 
  Plus, 
  AlertTriangle, 
  Wrench, 
  Fuel, 
  CircleDot,
  Calendar,
  Gauge,
  Edit,
  Trash2,
  Bell,
  ExternalLink
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Vehicle, VehicleMaintenance, VehicleAlert, Rep } from "@shared/schema";

export default function VehiclesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isAddVehicleOpen, setIsAddVehicleOpen] = useState(false);
  const [isAddMaintenanceOpen, setIsAddMaintenanceOpen] = useState(false);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);

  const { data: vehicles = [], isLoading: vehiclesLoading } = useQuery<Vehicle[]>({
    queryKey: ["/api/vehicles"],
  });

  const { data: maintenanceRecords = [] } = useQuery<VehicleMaintenance[]>({
    queryKey: ["/api/vehicle-maintenance"],
  });

  const { data: alerts = [] } = useQuery<VehicleAlert[]>({
    queryKey: ["/api/vehicle-alerts"],
  });

  const { data: reps = [] } = useQuery<Rep[]>({
    queryKey: ["/api/reps"],
  });

  // Filter out reps that are already assigned to vehicles
  const assignedRepIds = new Set(vehicles.filter(v => v.assignedRepId).map(v => v.assignedRepId));
  const availableReps = reps.filter(rep => !assignedRepIds.has(rep.id));

  const createVehicleMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiRequest("POST", "/api/vehicles", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vehicles"] });
      setIsAddVehicleOpen(false);
      toast({ title: "Success", description: "Vehicle added successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to add vehicle", variant: "destructive" });
    }
  });

  const createMaintenanceMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiRequest("POST", "/api/vehicle-maintenance", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-maintenance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-alerts"] });
      setIsAddMaintenanceOpen(false);
      toast({ title: "Success", description: "Maintenance record added" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to add maintenance record", variant: "destructive" });
    }
  });

  const deleteVehicleMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/vehicles/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vehicles"] });
      toast({ title: "Success", description: "Vehicle deleted" });
    }
  });

  const handleAddVehicle = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    createVehicleMutation.mutate({
      plateNumber: formData.get("plateNumber"),
      model: formData.get("model"),
      year: parseInt(formData.get("year") as string),
      startingMileage: parseFloat(formData.get("startingMileage") as string),
      currentMileage: parseFloat(formData.get("startingMileage") as string),
      assignedRepId: formData.get("assignedRepId") || null
    });
  };

  const handleAddMaintenance = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const vehicle = vehicles.find(v => v.id === selectedVehicleId);
    createMaintenanceMutation.mutate({
      vehicleId: selectedVehicleId,
      maintenanceType: formData.get("maintenanceType"),
      description: formData.get("description") || null,
      mileageAtService: vehicle?.currentMileage || 0,
      serviceDate: new Date().toISOString(),
      cost: formData.get("cost") ? parseFloat(formData.get("cost") as string) : null,
      oilType: formData.get("oilType") || null,
      tireType: formData.get("tireType") || null,
      notes: formData.get("notes") || null
    });
  };

  const getAlertSeverityColor = (severity: string) => {
    switch (severity) {
      case 'high': return 'bg-red-100 text-red-800 border-red-200';
      case 'medium': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      default: return 'bg-blue-100 text-blue-800 border-blue-200';
    }
  };

  const getMaintenanceIcon = (type: string) => {
    switch (type) {
      case 'oil_change': return <Fuel className="h-4 w-4" />;
      case 'tire_change': return <CircleDot className="h-4 w-4" />;
      case 'service': return <Wrench className="h-4 w-4" />;
      default: return <Wrench className="h-4 w-4" />;
    }
  };

  if (vehiclesLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <header className="bg-white shadow-sm border-b border-gray-200 px-6 py-4 rounded-lg">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Vehicle Management</h2>
              <p className="text-sm text-gray-600 mt-1">Track and maintain your fleet vehicles</p>
            </div>
            <Dialog open={isAddVehicleOpen} onOpenChange={setIsAddVehicleOpen}>
              <DialogTrigger asChild>
                <Button data-testid="button-add-vehicle">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Vehicle
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add New Vehicle</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleAddVehicle} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="plateNumber">Plate Number</Label>
                      <Input id="plateNumber" name="plateNumber" required data-testid="input-plate-number" />
                    </div>
                    <div>
                      <Label htmlFor="model">Model</Label>
                      <Input id="model" name="model" required data-testid="input-model" />
                    </div>
                    <div>
                      <Label htmlFor="year">Year</Label>
                      <Input id="year" name="year" type="number" required data-testid="input-year" />
                    </div>
                    <div>
                      <Label htmlFor="startingMileage">Current Mileage (km)</Label>
                      <Input id="startingMileage" name="startingMileage" type="number" required data-testid="input-mileage" />
                    </div>
                    <div className="col-span-2">
                      <Label htmlFor="assignedRepId">Assign to Rep ({availableReps.length} available)</Label>
                      <Select name="assignedRepId">
                        <SelectTrigger data-testid="select-rep">
                          <SelectValue placeholder="Select a rep" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableReps.map(rep => (
                            <SelectItem key={rep.id} value={rep.id}>{rep.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Button type="submit" className="w-full" disabled={createVehicleMutation.isPending} data-testid="button-submit-vehicle">
                    {createVehicleMutation.isPending ? "Adding..." : "Add Vehicle"}
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </header>

        {/* Alerts Section */}
        {alerts.length > 0 && (
          <Card className="border-yellow-200 bg-yellow-50">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center text-yellow-800">
                <Bell className="mr-2 h-5 w-5" />
                Maintenance Alerts ({alerts.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {alerts.map((alert, idx) => (
                  <div 
                    key={idx} 
                    className={`p-3 rounded-lg border ${getAlertSeverityColor(alert.severity)}`}
                    data-testid={`alert-${idx}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4" />
                        <span className="font-medium">{alert.plateNumber}</span>
                        <Badge variant="outline">{alert.alertType.replace(/_/g, ' ')}</Badge>
                      </div>
                      <span className="text-sm">{alert.message}</span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Tabs defaultValue="fleet" className="space-y-6">
          <TabsList>
            <TabsTrigger value="fleet" className="flex items-center gap-2">
              <Car className="h-4 w-4" />
              Fleet
            </TabsTrigger>
            <TabsTrigger value="maintenance" className="flex items-center gap-2">
              <Wrench className="h-4 w-4" />
              Maintenance History
            </TabsTrigger>
          </TabsList>

          <TabsContent value="fleet">
            <Card>
              <CardHeader>
                <CardTitle>Vehicle Fleet</CardTitle>
                <CardDescription>{vehicles.length} vehicles registered</CardDescription>
              </CardHeader>
              <CardContent>
                {vehicles.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <Car className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>No vehicles registered yet</p>
                    <p className="text-sm">Add your first vehicle to get started</p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Plate Number</TableHead>
                        <TableHead>Model</TableHead>
                        <TableHead>Year</TableHead>
                        <TableHead>Mileage</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Assigned To</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {vehicles.map(vehicle => {
                        const assignedRep = reps.find(r => r.id === vehicle.assignedRepId);
                        const vehicleAlerts = alerts.filter(a => a.vehicleId === vehicle.id);
                        
                        return (
                          <TableRow key={vehicle.id} data-testid={`vehicle-row-${vehicle.id}`}>
                            <TableCell className="font-medium">{vehicle.plateNumber}</TableCell>
                            <TableCell>{vehicle.model}</TableCell>
                            <TableCell>{vehicle.year}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Gauge className="h-4 w-4 text-gray-500" />
                                {vehicle.currentMileage.toLocaleString()} km
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant={vehicle.status === 'active' ? 'default' : 'secondary'}>
                                {vehicle.status}
                              </Badge>
                              {vehicleAlerts.length > 0 && (
                                <Badge variant="destructive" className="ml-2">
                                  {vehicleAlerts.length} alerts
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell>{assignedRep?.name || '-'}</TableCell>
                            <TableCell>
                              <div className="flex gap-2">
                                <Link href={`/vehicles/${vehicle.id}`}>
                                  <Button 
                                    size="sm" 
                                    variant="default"
                                    data-testid={`button-dashboard-${vehicle.id}`}
                                  >
                                    <ExternalLink className="h-4 w-4 mr-1" />
                                    Dashboard
                                  </Button>
                                </Link>
                                <Button 
                                  size="sm" 
                                  variant="outline"
                                  onClick={() => {
                                    setSelectedVehicleId(vehicle.id);
                                    setIsAddMaintenanceOpen(true);
                                  }}
                                  data-testid={`button-maintenance-${vehicle.id}`}
                                >
                                  <Wrench className="h-4 w-4" />
                                </Button>
                                <Button 
                                  size="sm" 
                                  variant="outline"
                                  onClick={() => deleteVehicleMutation.mutate(vehicle.id)}
                                  data-testid={`button-delete-${vehicle.id}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="maintenance">
            <Card>
              <CardHeader>
                <CardTitle>Maintenance History</CardTitle>
                <CardDescription>All maintenance records across your fleet</CardDescription>
              </CardHeader>
              <CardContent>
                {maintenanceRecords.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <Wrench className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>No maintenance records yet</p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Vehicle</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Mileage</TableHead>
                        <TableHead>Details</TableHead>
                        <TableHead>Cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {maintenanceRecords.map(record => {
                        const vehicle = vehicles.find(v => v.id === record.vehicleId);
                        return (
                          <TableRow key={record.id} data-testid={`maintenance-row-${record.id}`}>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Calendar className="h-4 w-4 text-gray-500" />
                                {new Date(record.serviceDate).toLocaleDateString()}
                              </div>
                            </TableCell>
                            <TableCell>{vehicle?.plateNumber || 'Unknown'}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                {getMaintenanceIcon(record.maintenanceType)}
                                <span className="capitalize">{record.maintenanceType.replace(/_/g, ' ')}</span>
                              </div>
                            </TableCell>
                            <TableCell>{record.mileageAtService.toLocaleString()} km</TableCell>
                            <TableCell>
                              {record.oilType && <Badge variant="outline" className="mr-1">Oil: {record.oilType}</Badge>}
                              {record.tireType && <Badge variant="outline">Tires: {record.tireType}</Badge>}
                              {record.description && <span className="text-sm text-gray-600">{record.description}</span>}
                            </TableCell>
                            <TableCell>{record.cost ? `$${record.cost}` : '-'}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Add Maintenance Dialog */}
        <Dialog open={isAddMaintenanceOpen} onOpenChange={setIsAddMaintenanceOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Maintenance Record</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleAddMaintenance} className="space-y-4">
              <div>
                <Label htmlFor="maintenanceType">Maintenance Type</Label>
                <Select name="maintenanceType" required>
                  <SelectTrigger data-testid="select-maintenance-type">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="oil_change">Oil Change</SelectItem>
                    <SelectItem value="tire_change">Tire Change</SelectItem>
                    <SelectItem value="service">General Service</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="description">Description</Label>
                <Input id="description" name="description" data-testid="input-description" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="oilType">Oil Type (if applicable)</Label>
                  <Input id="oilType" name="oilType" placeholder="e.g., 5W-30" data-testid="input-oil-type" />
                </div>
                <div>
                  <Label htmlFor="tireType">Tire Type (if applicable)</Label>
                  <Input id="tireType" name="tireType" placeholder="e.g., Michelin 205/55R16" data-testid="input-tire-type" />
                </div>
              </div>
              <div>
                <Label htmlFor="cost">Cost ($)</Label>
                <Input id="cost" name="cost" type="number" step="0.01" data-testid="input-cost" />
              </div>
              <div>
                <Label htmlFor="notes">Notes</Label>
                <Input id="notes" name="notes" data-testid="input-notes" />
              </div>
              <Button type="submit" className="w-full" disabled={createMaintenanceMutation.isPending} data-testid="button-submit-maintenance">
                {createMaintenanceMutation.isPending ? "Adding..." : "Add Record"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
