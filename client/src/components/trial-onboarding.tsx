import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { collectFingerprint, generateFingerprintHash } from "@/lib/fingerprint";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { 
  MapPin, 
  Truck, 
  BarChart3, 
  Shield, 
  CheckCircle2, 
  ArrowRight,
  Building2,
  Mail,
  Loader2,
  LogIn
} from "lucide-react";
import LoginModal from "./login-modal";
import pinLogo from "@assets/image_1769535972472.png";

const accountFormSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  companyName: z.string().optional(),
});

const consentFormSchema = z.object({
  consentGiven: z.boolean().refine((val) => val === true, {
    message: "You must consent to continue with the trial",
  }),
});

type AccountFormValues = z.infer<typeof accountFormSchema>;
type ConsentFormValues = z.infer<typeof consentFormSchema>;

type OnboardingStep = "welcome" | "account" | "consent" | "ready";

interface TrialOnboardingProps {
  open: boolean;
  onComplete: () => void;
}

export default function TrialOnboarding({ open, onComplete }: TrialOnboardingProps) {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [accountData, setAccountData] = useState<AccountFormValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const { toast } = useToast();

  const handleAdminLoginSuccess = () => {
    setShowLoginModal(false);
    onComplete();
  };

  const accountForm = useForm<AccountFormValues>({
    resolver: zodResolver(accountFormSchema),
    defaultValues: {
      email: "",
      companyName: "",
    },
  });

  const consentForm = useForm<ConsentFormValues>({
    resolver: zodResolver(consentFormSchema),
    defaultValues: {
      consentGiven: false,
    },
  });

  const startTrialMutation = useMutation({
    mutationFn: async (data: { email: string; companyName?: string; consentGiven: boolean }) => {
      const response = await apiRequest("POST", "/api/trial/start", data);
      return response.json();
    },
    onSuccess: async (data) => {
      if (data.trialId) {
        try {
          const signals = await collectFingerprint();
          const fingerprintHash = await generateFingerprintHash(signals);
          
          await apiRequest("POST", "/api/trial/fingerprint", {
            trialId: data.trialId,
            signals,
            fingerprintHash,
          });
        } catch (fingerprintError) {
          console.error("Failed to collect fingerprint:", fingerprintError);
        }
        
        await queryClient.invalidateQueries({ queryKey: ["/api/trial/status"] });
        setStep("ready");
      }
    },
    onError: (error: Error) => {
      const message = error.message;
      if (message.includes("blocked")) {
        setError("Your trial request has been blocked. Please contact support for assistance.");
      } else if (message.includes("existing")) {
        setError("An account with this email already exists. Please sign in instead.");
      } else if (message.includes("limit")) {
        setError("Trial limit reached for your organization. Please contact sales for enterprise options.");
      } else {
        setError(message || "Failed to start trial. Please try again.");
      }
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleAccountSubmit = (data: AccountFormValues) => {
    setAccountData(data);
    setStep("consent");
  };

  const handleConsentSubmit = (data: ConsentFormValues) => {
    if (accountData) {
      startTrialMutation.mutate({
        email: accountData.email,
        companyName: accountData.companyName,
        consentGiven: data.consentGiven,
      });
    }
  };

  const handleGetStarted = () => {
    onComplete();
  };

  return (
    <Dialog open={open} modal>
      <DialogContent className="sm:max-w-lg" onPointerDownOutside={(e) => e.preventDefault()}>
        {step === "welcome" && (
          <>
            <DialogHeader className="text-center">
              <div className="mx-auto mb-4">
                <img src={pinLogo} alt="RouteOptima" className="h-16 w-16 object-contain" />
              </div>
              <DialogTitle className="text-2xl">Welcome to RouteOptima</DialogTitle>
              <DialogDescription className="text-base">
                Smart route optimization for your field sales team
              </DialogDescription>
            </DialogHeader>
            
            <div className="space-y-4 py-4">
              <div className="flex items-start gap-3">
                <MapPin className="h-5 w-5 text-[#1d1d1f] dark:text-white mt-0.5 shrink-0" />
                <div>
                  <h4 className="font-medium text-[#1d1d1f] dark:text-white">Territory Management</h4>
                  <p className="text-sm text-[#86868b]">
                    Automatically cluster outlets into optimal territories
                  </p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <Truck className="h-5 w-5 text-[#1d1d1f] dark:text-white mt-0.5 shrink-0" />
                <div>
                  <h4 className="font-medium text-[#1d1d1f] dark:text-white">Vehicle Intelligence</h4>
                  <p className="text-sm text-[#86868b]">
                    Track vehicles and predict maintenance needs
                  </p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <BarChart3 className="h-5 w-5 text-[#1d1d1f] dark:text-white mt-0.5 shrink-0" />
                <div>
                  <h4 className="font-medium text-[#1d1d1f] dark:text-white">Analytics & Insights</h4>
                  <p className="text-sm text-[#86868b]">
                    ML-powered forecasting and route analytics
                  </p>
                </div>
              </div>
            </div>
            
            <Button onClick={() => setStep("account")} className="w-full" size="lg">
              Start Free Trial
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            
            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-[#e5e5e5] dark:border-[#38383a]" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-white dark:bg-[#1c1c1e] px-2 text-[#86868b]">Or</span>
              </div>
            </div>
            
            <Button 
              variant="outline" 
              onClick={() => setShowLoginModal(true)} 
              className="w-full"
              size="lg"
            >
              <LogIn className="mr-2 h-4 w-4" />
              Admin / Super User Login
            </Button>
            
            <p className="text-xs text-gray-500 text-center mt-4">Solution developed by Walid El Tayeh</p>
          </>
        )}

        <LoginModal 
          isOpen={showLoginModal} 
          onClose={() => setShowLoginModal(false)} 
          onLoginSuccess={handleAdminLoginSuccess}
        />

        {step === "account" && (
          <>
            <DialogHeader>
              <DialogTitle>Set Up Your Account</DialogTitle>
              <DialogDescription>
                Enter your details to get started with your free trial
              </DialogDescription>
            </DialogHeader>
            
            <Form {...accountForm}>
              <form onSubmit={accountForm.handleSubmit(handleAccountSubmit)} className="space-y-4">
                <FormField
                  control={accountForm.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email Address *</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#86868b]" />
                          <Input 
                            {...field} 
                            type="email" 
                            placeholder="you@company.com" 
                            className="pl-10"
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={accountForm.control}
                  name="companyName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Company Name (Optional)</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Building2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#86868b]" />
                          <Input 
                            {...field} 
                            placeholder="Your Company" 
                            className="pl-10"
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {error && (
                  <div className="rounded-xl bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-400">
                    {error}
                  </div>
                )}
                
                <div className="flex gap-2 pt-2">
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={() => setStep("welcome")}
                    className="flex-1"
                  >
                    Back
                  </Button>
                  <Button type="submit" className="flex-1">
                    Continue
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </form>
            </Form>
          </>
        )}

        {step === "consent" && (
          <>
            <DialogHeader>
              <DialogTitle>Privacy & Consent</DialogTitle>
              <DialogDescription>
                Please review our data collection practices
              </DialogDescription>
            </DialogHeader>
            
            <div className="space-y-4 py-2">
              <div className="rounded-xl bg-[#f5f5f7] dark:bg-[#2c2c2e] p-4">
                <div className="flex items-start gap-3">
                  <Shield className="h-5 w-5 text-[#1d1d1f] dark:text-white mt-0.5" />
                  <div className="space-y-2">
                    <h4 className="font-medium text-[#1d1d1f] dark:text-white">Security & Fraud Prevention</h4>
                    <p className="text-sm text-[#86868b]">
                      To protect our service and ensure fair usage, we collect a device fingerprint. 
                      This helps us prevent abuse and maintain trial integrity.
                    </p>
                  </div>
                </div>
              </div>
              
              <div className="rounded-xl border border-[#e5e5e5] dark:border-[#38383a] p-4 space-y-3">
                <h4 className="font-medium text-[#1d1d1f] dark:text-white">Trial Limits</h4>
                <ul className="space-y-2 text-sm text-[#86868b]">
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-[#34c759]" />
                    Up to 100 outlets
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-[#34c759]" />
                    Up to 2 vehicles
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-[#34c759]" />
                    14-day trial period
                  </li>
                </ul>
              </div>
              
              <Form {...consentForm}>
                <form onSubmit={consentForm.handleSubmit(handleConsentSubmit)} className="space-y-4">
                  <FormField
                    control={consentForm.control}
                    name="consentGiven"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-xl border border-[#e5e5e5] dark:border-[#38383a] p-4">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                        <div className="space-y-1 leading-none">
                          <FormLabel className="text-sm font-normal text-[#1d1d1f] dark:text-white">
                            I consent to the collection of device information for security purposes 
                            and agree to the{" "}
                            <a 
                              href="/privacy" 
                              target="_blank" 
                              className="text-[#007aff] hover:underline"
                            >
                              Privacy Policy
                            </a>
                          </FormLabel>
                          <FormMessage />
                        </div>
                      </FormItem>
                    )}
                  />

                  {error && (
                    <div className="rounded-xl bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-400">
                      {error}
                    </div>
                  )}
                  
                  <div className="flex gap-2">
                    <Button 
                      type="button" 
                      variant="outline" 
                      onClick={() => {
                        setError(null);
                        setStep("account");
                      }}
                      className="flex-1"
                      disabled={startTrialMutation.isPending}
                    >
                      Back
                    </Button>
                    <Button 
                      type="submit" 
                      className="flex-1"
                      disabled={startTrialMutation.isPending}
                    >
                      {startTrialMutation.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Starting...
                        </>
                      ) : (
                        <>
                          Start Trial
                          <ArrowRight className="ml-2 h-4 w-4" />
                        </>
                      )}
                    </Button>
                  </div>
                </form>
              </Form>
            </div>
          </>
        )}

        {step === "ready" && (
          <>
            <DialogHeader className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#34c759]/10">
                <CheckCircle2 className="h-8 w-8 text-[#34c759]" />
              </div>
              <DialogTitle className="text-2xl">You're All Set!</DialogTitle>
              <DialogDescription className="text-base">
                Your 14-day free trial has started
              </DialogDescription>
            </DialogHeader>
            
            <div className="space-y-4 py-4">
              <div className="rounded-xl bg-[#34c759]/10 p-4 text-center">
                <p className="text-sm text-[#1d1d1f] dark:text-white">
                  You can now upload outlets, create territories, and optimize routes. 
                  Enjoy exploring RouteOptima!
                </p>
              </div>
              
              <div className="grid grid-cols-2 gap-4 text-center">
                <div className="rounded-xl border border-[#e5e5e5] dark:border-[#38383a] p-3">
                  <div className="text-2xl font-bold text-[#1d1d1f] dark:text-white">100</div>
                  <div className="text-sm text-[#86868b]">Outlets Available</div>
                </div>
                <div className="rounded-xl border border-[#e5e5e5] dark:border-[#38383a] p-3">
                  <div className="text-2xl font-bold text-[#1d1d1f] dark:text-white">2</div>
                  <div className="text-sm text-[#86868b]">Vehicles Available</div>
                </div>
              </div>
            </div>
            
            <Button onClick={handleGetStarted} className="w-full" size="lg">
              Get Started
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
