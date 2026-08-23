import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { useTrial } from "@/hooks/use-trial";
import { Upload, CloudUpload, AlertTriangle, Download, FileText, X, CheckCircle2, BarChart3 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import UpgradeModal from "@/components/upgrade-modal";
import type { FileAnalysis } from "@shared/schema";

interface UploadReport {
  totalRowsProcessed: number;
  validOutlets: number;
  skippedRows: number;
  skippedDetails: { row: number; reason: string }[];
  vf1Count: number;
  vf2Count: number;
  vf4Count: number;
  recommendedReps: number;
}

interface PendingFileInfo {
  file: File;
  name: string;
  size: string;
  type: string;
  estimatedRows: number | null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getFileTypeLabel(file: File): string {
  if (file.name.endsWith(".csv")) return "CSV";
  if (file.name.endsWith(".xlsx")) return "Excel (XLSX)";
  if (file.name.endsWith(".xls")) return "Excel (XLS)";
  return "Unknown";
}

function downloadTemplate() {
  const headers = "Outlet Name,Address,Latitude,Longitude,VF,District,Time Per Visit";
  const rows = [
    "Al-Salam Market,Beirut Downtown,33.8938,35.5018,2,Beirut,30",
    "Cedar Pharmacy,Hamra Street,33.8969,35.4830,4,Hamra,20",
    "Golden Supermarket,Jounieh Highway,33.9806,35.6178,1,Jounieh,45",
  ];
  const csv = [headers, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "outlet_template.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function FileUpload() {
  const [isDragOver, setIsDragOver] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [pendingFile, setPendingFile] = useState<PendingFileInfo | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStage, setUploadStage] = useState<string>("");
  const [uploadResult, setUploadResult] = useState<UploadReport | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { status, canAddOutlet } = useTrial();

  const { data: analysis } = useQuery<FileAnalysis>({
    queryKey: ["/api/analysis"],
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      setUploadProgress(0);
      setUploadStage("Preparing...");
      setUploadResult(null);

      return new Promise<any>((resolve, reject) => {
        const formData = new FormData();
        formData.append("file", file);

        const xhr = new XMLHttpRequest();
        xhr.withCredentials = true;

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const pct = Math.round((event.loaded / event.total) * 100);
            setUploadProgress(pct);
            setUploadStage(`Uploading... ${pct}%`);
          }
        };

        xhr.upload.onloadend = () => {
          setUploadProgress(100);
          setUploadStage("Processing...");
        };

        xhr.onload = () => {
          if (xhr.status === 402) {
            setShowUpgradeModal(true);
            reject(new Error("Upgrade required to add more outlets"));
            return;
          }
          if (xhr.status >= 400) {
            try {
              const error = JSON.parse(xhr.responseText);
              reject(new Error(error.message || "Upload failed"));
            } catch {
              reject(new Error("Upload failed"));
            }
            return;
          }
          try {
            const data = JSON.parse(xhr.responseText);
            setUploadStage("Complete!");
            resolve(data);
          } catch {
            reject(new Error("Failed to parse server response"));
          }
        };

        xhr.onerror = () => {
          reject(new Error("Network error during upload"));
        };

        xhr.open("POST", "/api/upload");
        xhr.send(formData);
      });
    },
    onSuccess: (data) => {
      if (data.report) {
        setUploadResult(data.report);
      }
      toast({
        title: "File uploaded successfully",
        description: `Processed ${data.analysis.outlets} outlets`,
      });
      setPendingFile(null);
      queryClient.invalidateQueries({ queryKey: ["/api/analysis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/outlets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trial/status"] });
    },
    onError: (error: Error) => {
      setUploadStage("");
      setUploadProgress(0);
      if (!error.message.includes("Upgrade required")) {
        toast({
          title: "Upload failed",
          description: error.message,
          variant: "destructive",
        });
      }
    },
  });

  const estimateRowCount = useCallback((file: File): Promise<number | null> => {
    return new Promise((resolve) => {
      if (!file.name.endsWith(".csv")) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        if (!text) { resolve(null); return; }
        const lines = text.split("\n").filter((l) => l.trim().length > 0);
        resolve(Math.max(0, lines.length - 1));
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(file.slice(0, 1024 * 512));
    });
  }, []);

  const prepareFile = useCallback(async (file: File) => {
    if (!file) return;

    if (!canAddOutlet) {
      setShowUpgradeModal(true);
      return;
    }

    const validTypes = [
      "text/csv",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
    ];

    const isValidType =
      validTypes.includes(file.type) ||
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

    if (file.size > 50 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Please upload a file smaller than 50MB",
        variant: "destructive",
      });
      return;
    }

    const estimatedRows = await estimateRowCount(file);

    setPendingFile({
      file,
      name: file.name,
      size: formatFileSize(file.size),
      type: getFileTypeLabel(file),
      estimatedRows,
    });
    setUploadResult(null);
    setUploadStage("");
    setUploadProgress(0);
  }, [canAddOutlet, toast, estimateRowCount]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      prepareFile(file);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      prepareFile(file);
      e.target.value = "";
    }
  };

  const confirmUpload = () => {
    if (pendingFile) {
      uploadMutation.mutate(pendingFile.file);
    }
  };

  const cancelPending = () => {
    setPendingFile(null);
    setUploadStage("");
    setUploadProgress(0);
  };

  return (
    <>
      <Card className="border-2 border-[#8B0000]">
        <CardHeader>
          <CardTitle className="flex items-center">
            <Upload className="mr-2 h-5 w-5 text-[#1d1d1f] dark:text-white" />
            Step 1: Data Upload & Analysis
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {status?.isTrialMode && status.outletsRemaining <= 10 && status.outletsRemaining > 0 && (
            <Alert className="border-amber-200 bg-amber-50">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-amber-800">
                Only {status.outletsRemaining} outlet{status.outletsRemaining !== 1 ? "s" : ""} remaining in your trial. Upgrade to add unlimited outlets.
              </AlertDescription>
            </Alert>
          )}
          {status?.isTrialMode && status.outletsRemaining <= 0 && (
            <Alert className="border-red-200 bg-red-50">
              <AlertTriangle className="h-4 w-4 text-red-600" />
              <AlertDescription className="text-red-800">
                You've reached your outlet limit. Upgrade to add more outlets.
              </AlertDescription>
            </Alert>
          )}

          {/* File Upload Area */}
          {!pendingFile && !uploadMutation.isPending && (
            <div
              className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer ${
                isDragOver
                  ? "border-[#8B0000] bg-[#8B0000]/5"
                  : "border-[#d2d2d7] dark:border-[#424245] hover:border-[#8B0000]/50"
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
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
                Drop your CSV or Excel file here
              </p>
              <p className="text-xs text-gray-500 mb-1">
                Required: <span className="font-semibold text-gray-700 dark:text-gray-300">Outlet Name</span>, <span className="font-semibold text-gray-700 dark:text-gray-300">Latitude</span>, <span className="font-semibold text-gray-700 dark:text-gray-300">Longitude</span>
              </p>
              <p className="text-xs text-gray-400 mb-3">
                .csv, .xlsx, .xls up to 50MB
              </p>
              <div className="flex items-center justify-center gap-2">
                <Button variant="outline" size="sm">
                  Browse Files
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    downloadTemplate();
                  }}
                >
                  <Download className="mr-1 h-3.5 w-3.5" />
                  Download Template
                </Button>
              </div>
              <Input
                id="file-input"
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={handleFileInput}
                className="hidden"
              />
            </div>
          )}

          {/* File Preview (pending file) */}
          {pendingFile && !uploadMutation.isPending && (
            <div className="border rounded-xl p-5 bg-gray-50 dark:bg-[#1c1c1e] space-y-4">
              <div className="flex items-start gap-3">
                <FileText className="h-10 w-10 text-[#8B0000] flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{pendingFile.name}</p>
                  <div className="flex flex-wrap gap-2 mt-1.5">
                    <Badge variant="secondary" className="text-xs">{pendingFile.type}</Badge>
                    <Badge variant="secondary" className="text-xs">{pendingFile.size}</Badge>
                    {pendingFile.estimatedRows !== null && (
                      <Badge variant="secondary" className="text-xs">~{pendingFile.estimatedRows} rows</Badge>
                    )}
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" onClick={cancelPending}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex gap-2">
                <Button size="sm" className="bg-[#8B0000] hover:bg-[#8B0000]/90 text-white" onClick={confirmUpload}>
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  Upload
                </Button>
                <Button size="sm" variant="outline" onClick={cancelPending}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Upload Progress */}
          {uploadMutation.isPending && (
            <div className="border rounded-xl p-5 bg-gray-50 dark:bg-[#1c1c1e] space-y-3">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-[#8B0000] animate-pulse" />
                <p className="text-sm font-medium text-gray-900 dark:text-white">{uploadStage || "Uploading..."}</p>
              </div>
              <div className="w-full h-3 rounded-full bg-gray-200 dark:bg-[#2c2c2e] overflow-hidden">
                <div
                  className="h-full bg-[#8B0000] transition-all duration-300 rounded-full"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-xs text-gray-500">{uploadProgress}% complete</p>
            </div>
          )}

          {/* Upload Result / Data Quality Report */}
          {uploadResult && !uploadMutation.isPending && (
            <div className="border rounded-xl p-5 bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800 space-y-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                <p className="text-sm font-semibold text-green-800 dark:text-green-300">Upload Complete — Data Quality Report</p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="bg-white dark:bg-[#1c1c1e] rounded-lg p-3 text-center border">
                  <p className="text-lg font-bold text-gray-900 dark:text-white">{uploadResult.totalRowsProcessed}</p>
                  <p className="text-xs text-gray-500">Total Rows</p>
                </div>
                <div className="bg-white dark:bg-[#1c1c1e] rounded-lg p-3 text-center border">
                  <p className="text-lg font-bold text-green-700 dark:text-green-400">{uploadResult.validOutlets}</p>
                  <p className="text-xs text-gray-500">Valid Outlets</p>
                </div>
                <div className="bg-white dark:bg-[#1c1c1e] rounded-lg p-3 text-center border">
                  <p className="text-lg font-bold text-gray-900 dark:text-white">{uploadResult.recommendedReps}</p>
                  <p className="text-xs text-gray-500">Recommended Reps</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {uploadResult.vf1Count > 0 && (
                  <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">VF1: {uploadResult.vf1Count}</Badge>
                )}
                <Badge className="bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">VF2: {uploadResult.vf2Count}</Badge>
                <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">VF4: {uploadResult.vf4Count}</Badge>
              </div>
              {uploadResult.skippedRows > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-1">
                    <AlertTriangle className="inline h-3 w-3 mr-1" />
                    {uploadResult.skippedRows} row{uploadResult.skippedRows !== 1 ? "s" : ""} skipped
                  </p>
                  <ul className="text-xs text-gray-600 dark:text-gray-400 space-y-0.5 max-h-24 overflow-y-auto">
                    {uploadResult.skippedDetails.map((s, i) => (
                      <li key={i}>Row {s.row}: {s.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Existing File Status (when no fresh report) */}
          {!uploadResult && analysis && analysis.outlets > 0 && !uploadMutation.isPending && (
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
