import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Store, Car, Sparkles } from "lucide-react";
import type { TrialStatus } from "@shared/schema";
import UpgradeModal from "./upgrade-modal";

interface CircularProgressProps {
  value: number;
  max: number;
  size?: number;
  strokeWidth?: number;
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
}

function CircularProgress({
  value,
  max,
  size = 40,
  strokeWidth = 4,
  icon,
  label,
  onClick,
}: CircularProgressProps) {
  const percentage = Math.min((value / max) * 100, 100);
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  const getColor = () => {
    if (percentage >= 100) return "#ef4444";
    if (percentage >= 80) return "#f97316";
    return "#3b82f6";
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onClick}
            className="relative flex items-center justify-center cursor-pointer hover:opacity-80 transition-opacity"
            style={{ width: size, height: size }}
          >
            <svg
              width={size}
              height={size}
              className="transform -rotate-90"
            >
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke="#e5e7eb"
                strokeWidth={strokeWidth}
              />
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={getColor()}
                strokeWidth={strokeWidth}
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                className="transition-all duration-300"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              {icon}
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-sm">
          <p className="font-medium">{label}</p>
          <p className="text-muted-foreground">
            {value} / {max} used ({Math.round(percentage)}%)
          </p>
          {percentage >= 80 && (
            <p className="text-orange-500 text-xs mt-1">
              {percentage >= 100 ? "Limit reached!" : "Approaching limit"}
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface TrialUsageIndicatorProps {
  compact?: boolean;
}

export default function TrialUsageIndicator({ compact = false }: TrialUsageIndicatorProps) {
  const [upgradeModal, setUpgradeModal] = useState<{
    isOpen: boolean;
    limitType: 'outlet';
  }>({
    isOpen: false,
    limitType: 'outlet',
  });

  const { data: trialStatus, isLoading } = useQuery<TrialStatus>({
    queryKey: ["/api/trial/status"],
  });

  if (isLoading || !trialStatus?.isTrialMode) {
    return null;
  }

  const outletPercent = (trialStatus.outletCount / trialStatus.outletLimit) * 100;
  const showUpgrade = outletPercent >= 80 || trialStatus.upgradeRequired;

  const handleOutletClick = () => {
    if (outletPercent >= 100) {
      setUpgradeModal({ isOpen: true, limitType: 'outlet' });
    }
  };


  if (compact) {
    return (
      <>
        <div className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
        </div>

        <UpgradeModal
          isOpen={upgradeModal.isOpen}
          onClose={() => setUpgradeModal({ ...upgradeModal, isOpen: false })}
          limitType={upgradeModal.limitType}
          currentCount={trialStatus.outletCount}
          maxCount={trialStatus.outletLimit}
        />
      </>
    );
  }

  return (
    <>
      <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Trial Usage
          </span>
          {showUpgrade && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setUpgradeModal({ isOpen: true, limitType: 'outlet' })}
                    className="text-orange-500 hover:text-orange-600"
                  >
                    <Sparkles className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Upgrade for unlimited access</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        <div className="flex items-center justify-center gap-4">
          <div className="flex flex-col items-center gap-1">
          </div>
        </div>

        <div className="mt-2 text-center">
          <span className="text-xs text-gray-500">
            {trialStatus.daysRemaining > 0
              ? `${trialStatus.daysRemaining} days left`
              : "Trial expired"
            }
          </span>
        </div>
      </div>

      <UpgradeModal
        isOpen={upgradeModal.isOpen}
        onClose={() => setUpgradeModal({ ...upgradeModal, isOpen: false })}
        limitType={upgradeModal.limitType}
        currentCount={trialStatus.outletCount}
        maxCount={trialStatus.outletLimit}
      />
    </>
  );
}
