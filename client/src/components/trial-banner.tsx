import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { 
  X, 
  ChevronDown, 
  ChevronUp, 
  AlertTriangle, 
  Clock, 
  Store, 
  Car,
  Sparkles
} from "lucide-react";
import type { TrialStatus } from "@shared/schema";

interface TrialBannerProps {
  onUpgradeClick?: () => void;
}

export default function TrialBanner({ onUpgradeClick }: TrialBannerProps) {
  const [isDismissed, setIsDismissed] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const { data: trialStatus, isLoading } = useQuery<TrialStatus>({
    queryKey: ["/api/trial/status"],
  });

  if (isLoading || !trialStatus?.isTrialMode || isDismissed) {
    return null;
  }

  const outletUsagePercent = (trialStatus.outletCount / trialStatus.outletLimit) * 100;
  const isWarning = outletUsagePercent >= 80;
  const isLimitReached = outletUsagePercent >= 100;

  const isExpired = trialStatus.isExpired;
  const isBlocked = trialStatus.isBlocked;

  const getStatusColor = () => {
    if (isBlocked || isExpired) return "bg-red-500";
    if (isLimitReached) return "bg-red-500";
    if (isWarning) return "bg-orange-500";
    return "bg-blue-500";
  };

  const getBannerBg = () => {
    if (isBlocked || isExpired) return "bg-red-50 border-red-200";
    if (isLimitReached) return "bg-red-50 border-red-200";
    if (isWarning) return "bg-orange-50 border-orange-200";
    return "bg-blue-50 border-blue-200";
  };

  const getProgressColor = (percent: number) => {
    if (percent >= 100) return "bg-red-500";
    if (percent >= 80) return "bg-orange-500";
    return "bg-blue-500";
  };

  const getStatusBadge = () => {
    if (isBlocked) {
      return <Badge variant="destructive">Blocked</Badge>;
    }
    if (isExpired) {
      return <Badge variant="destructive">Expired</Badge>;
    }
    return <Badge className="bg-green-500 hover:bg-green-600">Active Trial</Badge>;
  };

  const showUpgradeButton = isWarning || isLimitReached || isExpired || trialStatus.upgradeRequired;

  return (
    <div 
      className={`fixed top-0 left-0 right-0 z-50 border-b ${getBannerBg()} transition-all duration-300`}
    >
      <div className="max-w-7xl mx-auto px-4 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {getStatusBadge()}
            
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Clock className="h-4 w-4" />
              <span className="font-medium">
                {trialStatus.daysRemaining > 0 
                  ? `${trialStatus.daysRemaining} days remaining`
                  : "Trial expired"
                }
              </span>
            </div>

            {!isCollapsed && (
              <div className="hidden md:flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <Store className="h-4 w-4 text-gray-500" />
                  <span className="text-sm text-gray-600">
                    {trialStatus.outletCount}/{trialStatus.outletLimit} outlets
                  </span>
                  <div className="w-20 h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div 
                      className={`h-full ${getProgressColor(outletUsagePercent)} transition-all`}
                      style={{ width: `${Math.min(outletUsagePercent, 100)}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Car className="h-4 w-4 text-gray-500" />
                  <span className="text-sm text-gray-600">
                  </span>
                  <div className="w-20 h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div 
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {showUpgradeButton && (
              <Button 
                size="sm" 
                onClick={onUpgradeClick}
                className={`${getStatusColor()} hover:opacity-90`}
              >
                <Sparkles className="h-4 w-4 mr-1" />
                Upgrade
              </Button>
            )}
            
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsCollapsed(!isCollapsed)}
              className="h-8 w-8 p-0"
            >
              {isCollapsed ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronUp className="h-4 w-4" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsDismissed(true)}
              className="h-8 w-8 p-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {!isCollapsed && (isWarning || isLimitReached || isBlocked) && (
          <div className="mt-2 flex items-center gap-2 text-sm">
            <AlertTriangle className={`h-4 w-4 ${isLimitReached || isBlocked ? 'text-red-500' : 'text-orange-500'}`} />
            <span className={isLimitReached || isBlocked ? 'text-red-700' : 'text-orange-700'}>
              {isBlocked && trialStatus.blockReason 
                ? trialStatus.blockReason
                : isLimitReached 
                  ? "You've reached your trial limits. Upgrade to continue adding resources."
                  : "You're approaching your trial limits. Consider upgrading soon."
              }
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
