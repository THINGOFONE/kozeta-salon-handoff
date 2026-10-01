import { useState } from "react";
import { Phone, Mail, Loader2, ArrowRight, CheckCircle, UserPlus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { ClientSession } from "@shared/schema";

interface AuthPanelProps {
  onLoginSuccess: (session: ClientSession, sessionId?: string) => void;
  onCancel?: () => void;
}

type LoginStep = "identifier" | "new_account" | "success";
type IdentifierType = "phone" | "email";

export function AuthPanel({ onLoginSuccess, onCancel }: AuthPanelProps) {
  const [step, setStep] = useState<LoginStep>("identifier");
  const [identifierType, setIdentifierType] = useState<IdentifierType>("phone");
  const [identifier, setIdentifier] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loginMutation = useMutation({
    mutationFn: async (params: { isNewAccount?: boolean }) => {
      const normalizedIdentifier = identifierType === 'phone' 
        ? identifier.replace(/\D/g, '')
        : identifier.trim().toLowerCase();
      const body: any = {
        identifier: normalizedIdentifier,
        type: identifierType
      };
      if (params.isNewAccount) {
        body.firstName = firstName.trim();
        body.lastName = lastName.trim();
        body.createIfNotFound = true;
      }
      const response = await apiRequest("POST", "/api/auth/login", body);
      return response.json();
    },
    onSuccess: (data: any) => {
      if (data.success && data.session) {
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
        }, 1000);
      } else if (data.notFound) {
        setStep("new_account");
        setError(null);
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

  const handleSubmitIdentifier = (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim()) {
      setError("Please enter your phone number or email");
      return;
    }
    setError(null);
    loginMutation.mutate({});
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

  return (
    <div className="flex items-center justify-center min-h-[400px] p-6">
      <Card className="w-full max-w-md shadow-2xl rounded-3xl overflow-hidden border-0 bg-card/95 backdrop-blur-sm">
        <div className="px-8 pt-8 pb-4 text-center">
          <h2 className="font-serif text-2xl font-semibold text-foreground mb-2">
            {step === "new_account" ? "Create Account" : "Welcome"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {step === "new_account"
              ? "Enter your name to set up your salon profile"
              : "Sign in with the phone number or email on file to access your profile and book appointments"}
          </p>
        </div>

        <CardContent className="px-8 pb-8">
          {step === "identifier" && (
            <form onSubmit={handleSubmitIdentifier} className="space-y-5">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={identifierType === "phone" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setIdentifierType("phone");
                    setIdentifier("");
                    setError(null);
                  }}
                  className="flex-1 rounded-full"
                  data-testid="button-auth-phone"
                >
                  <Phone className="w-3.5 h-3.5 mr-1.5" />
                  Phone
                </Button>
                <Button
                  type="button"
                  variant={identifierType === "email" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setIdentifierType("email");
                    setIdentifier("");
                    setError(null);
                  }}
                  className="flex-1 rounded-full"
                  data-testid="button-auth-email"
                >
                  <Mail className="w-3.5 h-3.5 mr-1.5" />
                  Email
                </Button>
              </div>

              <Input
                type={identifierType === "email" ? "email" : "tel"}
                placeholder={identifierType === "phone" ? "(416) 555-1234" : "you@example.com"}
                value={identifier}
                onChange={(e) => {
                  if (identifierType === "phone") {
                    setIdentifier(formatPhoneNumber(e.target.value));
                  } else {
                    setIdentifier(e.target.value);
                  }
                  setError(null);
                }}
                className="rounded-xl h-12 text-center text-lg"
                autoFocus
                data-testid="input-auth-identifier"
              />

              {error && (
                <p className="text-xs text-destructive text-center">{error}</p>
              )}

              <Button
                type="submit"
                className="w-full rounded-full"
                disabled={loginMutation.isPending}
                data-testid="button-auth-sign-in"
              >
                {loginMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <ArrowRight className="w-4 h-4 mr-2" />
                )}
                Sign In
              </Button>

              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
                  data-testid="button-auth-cancel"
                >
                  Cancel
                </button>
              )}

              <p className="text-[11px] text-muted-foreground text-center">
                We'll look you up using your salon records
              </p>
            </form>
          )}

          {step === "new_account" && (
            <form onSubmit={handleCreateAccount} className="space-y-5">
              <div className="bg-muted/50 rounded-lg px-3 py-2 text-sm text-muted-foreground text-center">
                {identifier}
              </div>

              <Input
                type="text"
                placeholder="First name"
                value={firstName}
                onChange={(e) => { setFirstName(e.target.value); setError(null); }}
                className="rounded-xl h-12 text-center text-lg"
                autoFocus
                data-testid="input-auth-first-name"
              />

              <Input
                type="text"
                placeholder="Last name"
                value={lastName}
                onChange={(e) => { setLastName(e.target.value); setError(null); }}
                className="rounded-xl h-12 text-center text-lg"
                data-testid="input-auth-last-name"
              />

              {error && (
                <p className="text-xs text-destructive text-center">{error}</p>
              )}

              <Button
                type="submit"
                className="w-full rounded-full"
                disabled={loginMutation.isPending}
                data-testid="button-auth-create-account"
              >
                {loginMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <UserPlus className="w-4 h-4 mr-2" />
                )}
                Create Account
              </Button>

              <button
                type="button"
                onClick={() => { setStep("identifier"); setError(null); }}
                className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
                data-testid="button-auth-back"
              >
                Try a different phone or email
              </button>
            </form>
          )}

          {step === "success" && (
            <div className="text-center py-8 space-y-4">
              <div className="w-20 h-20 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
                <CheckCircle className="w-10 h-10 text-green-600 dark:text-green-400" />
              </div>
              <h3 className="font-serif text-xl font-semibold">Welcome!</h3>
              <p className="text-sm text-muted-foreground">
                Opening your stylist portal...
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
