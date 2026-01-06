import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';

interface ProgressUpdate {
  percent: number;
  stage: string;
  detail: string;
}

interface OptimizationProgressModalProps {
  isOpen: boolean;
  progressId: string;
  onComplete: () => void;
  onError: (message: string) => void;
}

const stages = [
  { name: 'Starting', minPercent: 0 },
  { name: 'Analyzing', minPercent: 5 },
  { name: 'Preparing', minPercent: 10 },
  { name: 'Clustering', minPercent: 15 },
  { name: 'Zones Created', minPercent: 45 },
  { name: 'Assigning', minPercent: 55 },
  { name: 'Creating Reps', minPercent: 60 },
  { name: 'Scheduling', minPercent: 70 },
  { name: 'Role Schedules', minPercent: 85 },
  { name: 'Finalizing', minPercent: 95 },
  { name: 'Complete', minPercent: 100 },
];

export default function OptimizationProgressModal({
  isOpen,
  progressId,
  onComplete,
  onError
}: OptimizationProgressModalProps) {
  const [progress, setProgress] = useState<ProgressUpdate>({
    percent: 0,
    stage: 'Starting',
    detail: 'Initializing optimization...'
  });
  const [isComplete, setIsComplete] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (!isOpen || !progressId) return;

    setProgress({ percent: 0, stage: 'Starting', detail: 'Initializing optimization...' });
    setIsComplete(false);
    setHasError(false);

    const eventSource = new EventSource(`/api/optimize/progress/${progressId}`);

    eventSource.onmessage = (event) => {
      try {
        const data: ProgressUpdate = JSON.parse(event.data);
        setProgress(data);

        if (data.percent === 100) {
          setIsComplete(true);
          eventSource.close();
          setTimeout(() => onComplete(), 1500);
        } else if (data.percent === -1) {
          setHasError(true);
          eventSource.close();
          onError(data.detail);
        }
      } catch (e) {
        console.error('Failed to parse progress:', e);
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [isOpen, progressId, onComplete, onError]);

  const getStageIndex = (stageName: string) => {
    return stages.findIndex(s => s.name === stageName);
  };

  const currentStageIndex = getStageIndex(progress.stage);

  return (
    <Dialog open={isOpen}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
        <div className="flex flex-col items-center py-6">
          {hasError ? (
            <>
              <div className="relative mb-6">
                <XCircle className="h-16 w-16 text-red-500" />
              </div>
              <h3 className="text-lg font-semibold text-red-600 mb-2">Optimization Failed</h3>
              <p className="text-sm text-gray-500 text-center">{progress.detail}</p>
            </>
          ) : isComplete ? (
            <>
              <div className="relative mb-6">
                <div className="absolute inset-0 animate-ping">
                  <CheckCircle2 className="h-16 w-16 text-green-400 opacity-50" />
                </div>
                <CheckCircle2 className="h-16 w-16 text-green-500 relative z-10" />
              </div>
              <h3 className="text-lg font-semibold text-green-600 mb-2">Optimization Complete!</h3>
              <p className="text-sm text-gray-500">Your routes have been optimized successfully.</p>
            </>
          ) : (
            <>
              <div className="relative mb-6">
                <div className="h-24 w-24 rounded-full border-4 border-blue-100 flex items-center justify-center relative overflow-hidden">
                  <svg className="absolute inset-0 h-24 w-24 -rotate-90" viewBox="0 0 96 96">
                    <circle
                      cx="48"
                      cy="48"
                      r="44"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="8"
                      className="text-blue-500"
                      strokeDasharray={`${2 * Math.PI * 44}`}
                      strokeDashoffset={`${2 * Math.PI * 44 * (1 - progress.percent / 100)}`}
                      style={{ transition: 'stroke-dashoffset 0.5s ease-out' }}
                    />
                  </svg>
                  <span className="text-2xl font-bold text-blue-600 z-10">
                    {Math.round(progress.percent)}%
                  </span>
                </div>
                <Loader2 className="absolute -bottom-2 right-0 h-6 w-6 text-blue-500 animate-spin" />
              </div>
              
              <h3 className="text-lg font-semibold text-gray-800 mb-1">{progress.stage}</h3>
              <p className="text-sm text-gray-500 text-center mb-6">{progress.detail}</p>
              
              <div className="w-full space-y-3">
                <Progress value={progress.percent} className="h-2" />
                
                <div className="flex justify-between text-xs text-gray-400">
                  {stages.filter((_, i) => i % 3 === 0 || i === stages.length - 1).map((stage, i) => (
                    <span
                      key={stage.name}
                      className={`transition-colors ${
                        currentStageIndex >= getStageIndex(stage.name)
                          ? 'text-blue-500 font-medium'
                          : ''
                      }`}
                    >
                      {i === 0 ? 'Start' : i === 3 ? 'Done' : stage.name}
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
