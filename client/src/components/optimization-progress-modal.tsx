import { useEffect, useState, useRef } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { CheckCircle2, XCircle, Circle, Loader2 } from 'lucide-react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';

interface ProgressUpdate {
  percent: number;
  stage: string;
  detail: string;
}

interface OptimizationProgressModalProps {
  isOpen: boolean;
  progressId: string;
  onReady?: () => void;
  onComplete: () => void;
  onError: (message: string) => void;
}

const mainStages = [
  { key: 'start', label: 'Start', completedAt: 5 },
  { key: 'clustering', label: 'Clustering', completedAt: 45 },
  { key: 'creating_reps', label: 'Creating Reps', completedAt: 70 },
  { key: 'done', label: 'Done', completedAt: 95 },
  { key: 'complete', label: 'Complete', completedAt: 100 },
];

export default function OptimizationProgressModal({
  isOpen,
  progressId,
  onReady,
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
  const readyCalledRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  
  // Store callbacks in refs to avoid effect re-runs
  const onReadyRef = useRef(onReady);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  
  useEffect(() => {
    onReadyRef.current = onReady;
    onCompleteRef.current = onComplete;
    onErrorRef.current = onError;
  }, [onReady, onComplete, onError]);

  useEffect(() => {
    if (!isOpen || !progressId) return;
    
    // Prevent duplicate connections
    if (eventSourceRef.current) {
      return;
    }

    setProgress({ percent: 0, stage: 'Starting', detail: 'Connecting...' });
    setIsComplete(false);
    setHasError(false);
    readyCalledRef.current = false;

    const eventSource = new EventSource(`/api/optimize/progress/${progressId}`);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      if (!readyCalledRef.current && onReadyRef.current) {
        readyCalledRef.current = true;
        setTimeout(() => onReadyRef.current?.(), 100);
      }
    };

    eventSource.onmessage = (event) => {
      try {
        const data: ProgressUpdate = JSON.parse(event.data);
        setProgress(data);

        if (data.percent === 100) {
          setIsComplete(true);
          eventSource.close();
          eventSourceRef.current = null;
          setTimeout(() => onCompleteRef.current(), 1500);
        } else if (data.percent === -1) {
          setHasError(true);
          eventSource.close();
          eventSourceRef.current = null;
          onErrorRef.current(data.detail);
        }
      } catch (e) {
        console.error('Failed to parse progress:', e);
      }
    };

    eventSource.onerror = () => {
      if (!readyCalledRef.current && onReadyRef.current) {
        readyCalledRef.current = true;
        onReadyRef.current();
      }
    };

    return () => {
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, [isOpen, progressId]);

  const getStageStatus = (stage: typeof mainStages[0], percent: number) => {
    if (percent >= stage.completedAt) return 'completed';
    const prevStage = mainStages[mainStages.indexOf(stage) - 1];
    if (!prevStage || percent >= prevStage.completedAt) return 'active';
    return 'pending';
  };

  return (
    <Dialog open={isOpen}>
      <DialogContent 
        className="sm:max-w-md" 
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        aria-describedby="optimization-progress-description"
      >
        <VisuallyHidden>
          <DialogTitle>Optimization Progress</DialogTitle>
        </VisuallyHidden>
        <DialogDescription id="optimization-progress-description" className="sr-only">
          Route optimization is in progress. Please wait while your routes are being optimized.
        </DialogDescription>
        
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
              <div className="text-center mb-6">
                <div className="text-5xl font-bold text-blue-600 mb-1">
                  {Math.round(progress.percent)}%
                </div>
                <p className="text-sm text-gray-500">Overall Progress</p>
              </div>
              
              <div className="w-full mb-6">
                <Progress value={progress.percent} className="h-3" />
              </div>
              
              <div className="w-full space-y-3">
                {mainStages.map((stage) => {
                  const status = getStageStatus(stage, progress.percent);
                  return (
                    <div 
                      key={stage.key}
                      className={`flex items-center gap-3 p-2 rounded-lg transition-all ${
                        status === 'active' ? 'bg-blue-50' : ''
                      }`}
                    >
                      {status === 'completed' ? (
                        <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0" />
                      ) : status === 'active' ? (
                        <Loader2 className="h-5 w-5 text-blue-500 animate-spin flex-shrink-0" />
                      ) : (
                        <Circle className="h-5 w-5 text-gray-300 flex-shrink-0" />
                      )}
                      <span className={`text-sm font-medium ${
                        status === 'completed' ? 'text-green-600' :
                        status === 'active' ? 'text-blue-600' : 'text-gray-400'
                      }`}>
                        {stage.label}
                      </span>
                      {status === 'active' && (
                        <span className="ml-auto text-xs text-gray-400">
                          {progress.detail}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
