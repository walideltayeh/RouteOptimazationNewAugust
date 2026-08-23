import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  AlertCircle, 
  Check, 
  Sparkles, 
  Store,  
  Zap,
  BarChart3,
  Users,
  Shield
} from "lucide-react";

interface UpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  limitType?: 'outlet';
  currentCount: number;
  maxCount: number;
}

export default function UpgradeModal({
  isOpen,
  onClose,
  limitType,
  currentCount,
  maxCount,
}: UpgradeModalProps) {
  const LimitIcon = Store;
  const limitLabel = 'outlets';

  const benefits = [
    { icon: Store, label: "Unlimited outlets" },
    { icon: Users, label: "Unlimited sales reps" },
    { icon: BarChart3, label: "Advanced analytics" },
    { icon: Zap, label: "Priority optimization" },
    { icon: Shield, label: "Premium support" },
  ];

  const handleUpgrade = () => {
    window.open('mailto:sales@routeoptima.com?subject=Upgrade%20Request', '_blank');
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-2">
            <div className="p-2 bg-red-100 rounded-full">
              <AlertCircle className="h-5 w-5 text-red-500" />
            </div>
            <Badge variant="destructive">Limit Reached</Badge>
          </div>
          <DialogTitle className="text-xl">
            Outlet Limit Reached
          </DialogTitle>
          <DialogDescription className="text-base">
            You've used <span className="font-semibold">{currentCount}</span> of{" "}
            <span className="font-semibold">{maxCount}</span> {limitLabel} in your trial.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg mb-4">
            <LimitIcon className="h-5 w-5 text-amber-600" />
            <p className="text-sm text-amber-800">
              To add more {limitLabel}, please upgrade to a paid plan.
            </p>
          </div>

          <div className="space-y-3">
            <p className="text-sm font-medium text-gray-700">
              Upgrade to unlock:
            </p>
            <div className="grid grid-cols-2 gap-2">
              {benefits.map((benefit, index) => {
                const Icon = benefit.icon;
                return (
                  <div 
                    key={index}
                    className="flex items-center gap-2 text-sm text-gray-600"
                  >
                    <Check className="h-4 w-4 text-green-500" />
                    <span>{benefit.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            variant="outline"
            onClick={onClose}
            className="w-full sm:w-auto"
          >
            Close
          </Button>
          <Button
            onClick={handleUpgrade}
            className="w-full sm:w-auto bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
          >
            <Sparkles className="h-4 w-4 mr-2" />
            Contact Sales
          </Button>
        </DialogFooter>

        <p className="text-xs text-center text-gray-500 mt-2">
          Note: Your current action cannot be completed until you upgrade.
        </p>
      </DialogContent>
    </Dialog>
  );
}
