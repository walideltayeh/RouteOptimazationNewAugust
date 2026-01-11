import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { useTrial } from "@/hooks/use-trial";
import { Upload, CloudUpload, AlertTriangle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import UpgradeModal from "@/components/upgrade-modal";
import type { FileAnalysis } from "@shared/schema";

export default function FileUpload() {
  const [isDragOver, setIsDragOver] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { status, canAddOutlet } = useTrial();

  const { data: analysis } = useQuery<FileAnalysis>({
    queryKey: ["/api/analysis"],
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      
      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      
      if (!response.ok) {
        if (response.status === 402) {
          setShowUpgradeModal(true);
          throw new Error("Upgrade required to add more outlets");
        }
        const error = await response.json();
        throw new Error(error.message || "Upload failed");
      }
      
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "File uploaded successfully",
        description: `Processed ${data.analysis.outlets} outlets`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/analysis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/outlets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trial/status"] });
    },
    onError: (error: Error) => {
      if (!error.message.includes("Upgrade required")) {
        toast({
          title: "Upload failed",
          description: error.message,
          variant: "destructive",
        });
      }
    },
  });

  const handleFileUpload = (file: File) => {
    if (!file) return;

    if (!canAddOutlet) {
      setShowUpgradeModal(true);
      return;
    }

    const validTypes = [
      "text/csv",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel"
    ];

    const isValidType = validTypes.includes(file.type) || 
                       file.name.endsWith(".csv") || 
                       file.name.endsWith(".xlsx") || 
                       file.name.endsWith(".xls");

    if (!isValidType) {
      toast({
        title: "Invalid file type",
        description: "Please upload a CSV or Excel file",
        variant: "destructive",
      });
      return;
    }

    if (file.size > 10 * 1024 * 1024) { // 10MB
      toast({
        title: "File too large",
        description: "Please upload a file smaller than 10MB",
        variant: "destructive",
      });
      return;
    }

    uploadMutation.mutate(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    
    const file = e.dataTransfer.files[0];
    if (file) {
      handleFileUpload(file);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileUpload(file);
      // Reset the input value to allow re-uploading the same file
      e.target.value = '';
    }
  };

  return (
    <>
    <Card className="border-2 border-primary">
      <CardHeader>
        <CardTitle className="flex items-center">
          <Upload className="mr-2 h-5 w-5 text-primary" />
          Step 1: Data Upload & Analysis
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {status?.outletsRemaining !== undefined && status.outletsRemaining <= 10 && status.outletsRemaining > 0 && (
          <Alert className="border-amber-200 bg-amber-50">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-800">
              Only {status.outletsRemaining} outlet{status.outletsRemaining !== 1 ? 's' : ''} remaining in your trial. Upgrade to add unlimited outlets.
            </AlertDescription>
          </Alert>
        )}
        {status?.outletsRemaining !== undefined && status.outletsRemaining <= 0 && (
          <Alert className="border-red-200 bg-red-50">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-red-800">
              You've reached your outlet limit. Upgrade to add more outlets.
            </AlertDescription>
          </Alert>
        )}
        {/* File Upload Area */}
        <div
          className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
            isDragOver 
              ? "border-primary bg-primary/5" 
              : "border-gray-300 hover:border-primary/50"
          }`}
          onDrop={handleDrop}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onClick={() => document.getElementById("file-input")?.click()}
        >
          <CloudUpload className="mx-auto h-12 w-12 text-gray-400 mb-3" />
          <p className="text-sm font-medium text-gray-900 mb-1">
            Drop your CSV or Excel file here
          </p>
          <p className="text-xs text-gray-500 mb-3">
            Supports .csv, .xlsx, .xls files up to 10MB
          </p>
          <Button 
            variant="outline" 
            size="sm"
            disabled={uploadMutation.isPending}
          >
            {uploadMutation.isPending ? "Uploading..." : "Browse Files"}
          </Button>
          <Input
            id="file-input"
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleFileInput}
            className="hidden"
          />
        </div>

        {/* File Status */}
        {analysis && analysis.outlets > 0 && (
          <div className="p-4 bg-green-50 rounded-lg border border-green-200">
            <p className="text-sm text-green-800 font-medium">
              ✓ File uploaded successfully
            </p>
            <p className="text-xs text-green-600 mt-1">
              {analysis.outlets} outlets processed. See Step 2 for detailed analysis.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
    
    <UpgradeModal
      isOpen={showUpgradeModal}
      onClose={() => setShowUpgradeModal(false)}
      limitType="outlet"
      currentCount={status?.outletCount ?? 0}
      maxCount={status?.outletLimit ?? 100}
    />
    </>
  );
}
