import { useState, useEffect, useRef } from "react";
import { X, Phone, Mail, Loader2, ArrowRight, CheckCircle, UserPlus, ShieldCheck, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { ClientSession } from "@shared/schema";

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: (session: ClientSession, sessionId?: string) => void;
}

type LoginStep = "phone" | "otp" | "new_account" | "success";
type LoginMethod = "phone" | "email";

export function LoginModal({ isOpen, onClose, onLoginSuccess }: LoginModalProps) {
  const [step, setStep] = useState<LoginStep>("phone");
  const [loginMethod, setLoginMethod] = useState<LoginMethod>("phone");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpId, setOtpId] = useState("");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [clientName, setClientName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const otpInputRef = useRef<HTMLInputElement>(null);

  // After a failed attempt the code field is cleared — put the cursor back so
  // the client can immediately type a new code (important on mobile keyboards).
  const clearOtpAndRefocus = () => {
    setOtpCode("");
    requestAnimationFrame(() => otpInputRef.current?.focus());
  };

  useEffect(() => {
    if (resendCooldown > 0) {
      const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [resendCooldown]);

  const handleLoginSuccess = (data: any) => {
    if (data.sessionId) {
      localStorage.setItem('kozeta_session_id', data.sessionId);
      localStorage.setItem('kozeta_client_id', data.session.clientId);
      if (data.sessionToken) {
        localStorage.setItem('kozeta_session_token', data.sessionToken);
      }
    }
    setStep("success");
    setTimeout(() => {
      onLoginSuccess(data.session, data.sessionId);
      onClose();
      resetForm();
    }, 1500);
  };

  const loginMutation = useMutation({
    mutationFn: async (params?: { isNewAccount?: boolean }) => {
      const body: any = {};
      if (loginMethod === 'email') {
        body.email = email.trim().toLowerCase();
      } else {
        body.phone = phone.replace(/\D/g, '');
      }
      if (params?.isNewAccount) {
        body.firstName = firstName.trim();
        body.lastName = lastName.trim();
        body.createIfNotFound = true;
      }
      const response = await apiRequest("POST", "/api/auth/login", body);
      return response.json();
    },
    onSuccess: (data: any) => {
      if (data.success && data.session) {
        handleLoginSuccess(data);
      } else if (data.otpSent) {
        setOtpId(data.otpId);
        setMaskedPhone(data.maskedPhone || '');
        setClientName(data.clientName || '');
        setStep("otp");
        setError(null);
        setResendCooldown(60);
      } else if (data.notFound) {
        if (loginMethod === 'email') {
          setError("No account found with that email. Please use your phone number to sign in or create an account.");
        } else {
          setStep("new_account");
          setError(null);
        }
      }
    },
    onError: (err: any) => {
      try {
        const parsed = JSON.parse(err.message);
        if (parsed.notFound) {
          setStep("new_account");
          setError(null);
          return;
        }
        setError(parsed.error || "Unable to sign in. Please try again.");
      } catch {
        const msg = err.message || "Unable to sign in. Please try again.";
        if (msg.includes("notFound")) {
          setStep("new_account");
          setError(null);
          return;
        }
        setError(msg);
      }
    }
  });

  const verifyMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/auth/verify", {
        otpId,
        code: otpCode.trim()
      });
      return response.json();
    },
    onSuccess: (data: any) => {
      if (data.success && data.session) {
        handleLoginSuccess(data);
      }
    },
    onError: (err: any) => {
      const raw: string = err?.message || "";
      // apiRequest errors look like "429: {json}" — strip the status prefix before parsing
      const jsonPart = raw.replace(/^\d{3}:\s*/, "");
      const isTooMany = raw.startsWith("429");
      try {
        const parsed = JSON.parse(jsonPart);
        if (isTooMany || (parsed.attemptsRemaining !== undefined && parsed.attemptsRemaining <= 0)) {
          setStep("phone");
          setOtpId("");
          setOtpCode("");
          setError("Too many attempts — please start over and request a new code.");
          return;
        }
        setError(parsed.error || "Invalid code. Please try again.");
        clearOtpAndRefocus();
      } catch {
        if (isTooMany) {
          setStep("phone");
          setOtpId("");
          setOtpCode("");
          setError("Too many attempts — please start over and request a new code.");
          return;
        }
        setError(raw || "Invalid code. Please try again.");
        clearOtpAndRefocus();
      }
    }
  });

  const resendMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/auth/resend-otp", { otpId });
      return response.json();
    },
    onSuccess: () => {
      setOtpCode("");
      setError(null);
      setResendCooldown(60);
    },
    onError: () => {
      setError("Couldn't resend code. Please try again.");
    }
  });

  const resetForm = () => {
    setStep("phone");
    setLoginMethod("phone");
    setPhone("");
    setEmail("");
    setOtpCode("");
    setOtpId("");
    setMaskedPhone("");
    setClientName("");
    setFirstName("");
    setLastName("");
    setError(null);
    setResendCooldown(0);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmitPhone = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginMethod === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        setError("Please enter a valid email address");
        return;
      }
    } else {
      const digits = phone.replace(/\D/g, '');
      if (digits.length < 10) {
        setError("Please enter a valid 10-digit phone number");
        return;
      }
    }
    setError(null);
    loginMutation.mutate({});
  };

  const handleVerifyOtp = (e: React.FormEvent) => {
    e.preventDefault();
    if (verifyMutation.isPending) return; // ignore double-submits while verifying
    if (otpCode.trim().length !== 6) {
      setError("Please enter the 6-digit code");
      return;
    }
    setError(null);
    verifyMutation.mutate();
  };

  const handleCreateAccount = (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim()) {
      setError("Please enter your first and last name");
      return;
    }
    setError(null);
    loginMutation.mutate({ isNewAccount: true });
  };

  const formatPhoneNumber = (value: string) => {
    const numbers = value.replace(/\D/g, '').slice(0, 10);
    if (numbers.length >= 6) {
      return `(${numbers.slice(0, 3)}) ${numbers.slice(3, 6)}-${numbers.slice(6)}`;
    } else if (numbers.length >= 3) {
      return `(${numbers.slice(0, 3)}) ${numbers.slice(3)}`;
    }
    return numbers;
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm"
        onClick={handleClose}
      />

      <div className="fixed z-[70] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(400px,calc(100%-32px))]">
        <Card className="shadow-2xl rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 pt-4 pb-2 border-b border-border">
            <h2 className="font-serif text-lg font-semibold">
              {step === "new_account" ? "Create Account" : step === "otp" ? "Enter Code" : "Sign In"}
            </h2>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleClose}
              className="rounded-full"
              data-testid="button-close-login"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>

          <CardContent className="p-5">
            {step === "phone" && (
              <form onSubmit={handleSubmitPhone} className="space-y-4">
                <div className="flex rounded-xl border overflow-hidden">
                  <button
                    type="button"
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm transition-colors ${loginMethod === 'phone' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    onClick={() => { setLoginMethod('phone'); setError(null); }}
                    data-testid="button-login-method-phone"
                  >
                    <Phone className="w-3.5 h-3.5" />
                    Phone
                  </button>
                  <button
                    type="button"
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm transition-colors ${loginMethod === 'email' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    onClick={() => { setLoginMethod('email'); setError(null); }}
                    data-testid="button-login-method-email"
                  >
                    <Mail className="w-3.5 h-3.5" />
                    Email
                  </button>
                </div>

                <p className="text-sm text-muted-foreground">
                  {loginMethod === 'email'
                    ? "Enter your email address. We'll text a code to your phone on file."
                    : "Enter your phone number and we'll text you a code to sign in."}
                </p>

                {loginMethod === 'phone' ? (
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      type="tel"
                      placeholder="(416) 555-1234"
                      value={phone}
                      onChange={(e) => {
                        setPhone(formatPhoneNumber(e.target.value));
                        setError(null);
                      }}
                      className="rounded-xl pl-10"
                      autoFocus
                      data-testid="input-login-phone"
                    />
                  </div>
                ) : (
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setError(null);
                      }}
                      className="rounded-xl pl-10"
                      autoFocus
                      data-testid="input-login-email"
                    />
                  </div>
                )}

                {error && (
                  <p className="text-xs text-destructive">{error}</p>
                )}

                <Button
                  type="submit"
                  className="w-full rounded-full"
                  disabled={loginMutation.isPending}
                  data-testid="button-send-code"
                >
                  {loginMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <ArrowRight className="w-4 h-4 mr-2" />
                  )}
                  Send Code
                </Button>

                <p className="text-[10px] text-muted-foreground text-center">
                  We'll send a verification code via text message
                </p>
              </form>
            )}

            {step === "otp" && (
              <form onSubmit={handleVerifyOtp} className="space-y-4">
                <div className="text-center space-y-2">
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                    <ShieldCheck className="w-6 h-6 text-primary" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {clientName ? (
                      <>Welcome back, <span className="font-semibold text-foreground">{clientName}</span>! </>
                    ) : null}
                    Enter the 6-digit code sent to <span className="font-semibold text-foreground">{maskedPhone}</span>
                  </p>
                </div>

                <Input
                  ref={otpInputRef}
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  value={otpCode}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                    setOtpCode(val);
                    setError(null);
                  }}
                  className="rounded-xl text-center text-2xl tracking-[0.5em] font-mono"
                  autoFocus
                  autoComplete="one-time-code"
                  data-testid="input-otp-code"
                />

                {error && (
                  <p className="text-xs text-destructive">{error}</p>
                )}

                <Button
                  type="submit"
                  className="w-full rounded-full"
                  disabled={verifyMutation.isPending || otpCode.length !== 6}
                  data-testid="button-verify-code"
                >
                  {verifyMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <ShieldCheck className="w-4 h-4 mr-2" />
                  )}
                  Verify & Sign In
                </Button>

                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => { setStep("phone"); setOtpCode(""); setOtpId(""); setError(null); }}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    data-testid="button-back-to-phone"
                  >
                    Change number
                  </button>
                  <button
                    type="button"
                    onClick={() => resendMutation.mutate()}
                    disabled={resendCooldown > 0 || resendMutation.isPending}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 flex items-center gap-1"
                    data-testid="button-resend-code"
                  >
                    <RefreshCw className="w-3 h-3" />
                    {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend code"}
                  </button>
                </div>
              </form>
            )}

            {step === "new_account" && (
              <form onSubmit={handleCreateAccount} className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  We didn't find an account with that number. Enter your name below and we'll set you up and send a verification code.
                </p>

                <div className="bg-muted/50 rounded-lg px-3 py-2 text-sm text-muted-foreground flex items-center gap-2">
                  <Phone className="w-3.5 h-3.5" />
                  {phone}
                </div>

                <Input
                  type="text"
                  placeholder="First name"
                  value={firstName}
                  onChange={(e) => { setFirstName(e.target.value); setError(null); }}
                  className="rounded-xl"
                  autoFocus
                  data-testid="input-first-name"
                />

                <Input
                  type="text"
                  placeholder="Last name"
                  value={lastName}
                  onChange={(e) => { setLastName(e.target.value); setError(null); }}
                  className="rounded-xl"
                  data-testid="input-last-name"
                />

                {error && (
                  <p className="text-xs text-destructive">{error}</p>
                )}

                <Button
                  type="submit"
                  className="w-full rounded-full"
                  disabled={loginMutation.isPending}
                  data-testid="button-create-account"
                >
                  {loginMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <UserPlus className="w-4 h-4 mr-2" />
                  )}
                  Create Account & Send Code
                </Button>

                <button
                  type="button"
                  onClick={() => { setStep("phone"); setError(null); }}
                  className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
                  data-testid="button-back-to-phone"
                >
                  Try a different number
                </button>
              </form>
            )}

            {step === "success" && (
              <div className="text-center py-6 space-y-3">
                <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
                  <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
                </div>
                <h3 className="font-semibold text-lg">Welcome!</h3>
                <p className="text-sm text-muted-foreground">
                  Loading your profile...
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
