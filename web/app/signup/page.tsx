"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { PasswordStrengthIndicator } from "@/components/password-strength";
import { SocialLogin } from "@/components/social-login";
import {
  SignupFormData,
  FormErrors,
  validateEmail,
  validatePassword,
} from "@/types/auth";
import { signUp } from "@/lib/auth-client";

export default function SignupPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<SignupFormData>({
    fullName: "",
    email: "",
    password: "",
    confirmPassword: "",
    companyName: "",
    acceptTerms: false,
  });
  const [errors, setErrors] = useState<FormErrors>({});

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    if (!formData.fullName.trim()) {
      newErrors.fullName = "Full name is required";
    }

    const emailError = validateEmail(formData.email);
    if (emailError) newErrors.email = emailError;

    const passwordError = validatePassword(formData.password);
    if (passwordError) newErrors.password = passwordError;

    if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match";
    }

    if (!formData.acceptTerms) {
      newErrors.acceptTerms = "You must accept the terms and conditions";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!validateForm()) return;

    setIsLoading(true);

    try {
      const result = await signUp({
        email: formData.email,
        password: formData.password,
        name: formData.fullName,
      });

      if (result.error) {
        setError(result.error.message || "Failed to create account");
        setIsLoading(false);
        return;
      }

      // Redirect to dashboard on success
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setIsLoading(false);
    }
  };

  const updateField = (
    field: keyof SignupFormData,
    value: string | boolean
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setError(null);
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Start streaming video in minutes"
      topLink={
        <>
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-primary hover:underline font-medium"
          >
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Social Login */}
        <SocialLogin />

        {/* Error Banner */}
        {error && (
          <div className="p-3 rounded-sm bg-destructive/10 border border-destructive/20 text-destructive text-sm">
            {error}
          </div>
        )}

        {/* Full Name */}
        <div className="space-y-2">
          <Label htmlFor="fullName" required>
            Full Name
          </Label>
          <Input
            id="fullName"
            type="text"
            placeholder="John Doe"
            value={formData.fullName}
            onChange={(e) => updateField("fullName", e.target.value)}
            error={errors.fullName}
            disabled={isLoading}
            autoComplete="name"
            className="pr-12 bg-mauve-500/40 mt-1 rounded-sm placeholder:text-mauve-400"
          />
        </div>

        {/* Email */}
        <div className="space-y-2">
          <Label htmlFor="email" required>
            Email
          </Label>
          <Input
            id="email"
            type="email"
            placeholder="you@company.com"
            value={formData.email}
            onChange={(e) => updateField("email", e.target.value)}
            error={errors.email}
            disabled={isLoading}
            autoComplete="email"
            className="pr-12 bg-mauve-500/40 mt-1 rounded-sm placeholder:text-mauve-400"
          />
        </div>

        {/* Company (Optional) */}
        <div className="space-y-2">
          <Label htmlFor="companyName">Company (Optional)</Label>
          <Input
            id="companyName"
            type="text"
            placeholder="Acme Inc."
            value={formData.companyName}
            onChange={(e) => updateField("companyName", e.target.value)}
            disabled={isLoading}
            autoComplete="organization"
            className="pr-12 bg-mauve-500/40 mt-1 rounded-sm placeholder:text-mauve-400"
          />
        </div>

        {/* Password */}
        <div className="space-y-2">
          <Label htmlFor="password" required>
            Password
          </Label>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              placeholder="Create a strong password"
              value={formData.password}
              onChange={(e) => updateField("password", e.target.value)}
              error={errors.password}
              disabled={isLoading}
              autoComplete="new-password"
              className="pr-12 bg-mauve-500/40 mt-1 rounded-sm placeholder:text-mauve-400"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-mauve-400 hover:text-mauve-300 transition-colors"
              tabIndex={-1}
            >
              {showPassword ? (
                <EyeOff className="w-5 h-5" />
              ) : (
                <Eye className="w-5 h-5" />
              )}
            </button>
          </div>
          <PasswordStrengthIndicator password={formData.password} />
        </div>

        {/* Confirm Password */}
        <div className="space-y-2">
          <Label htmlFor="confirmPassword" required>
            Confirm Password
          </Label>
          <div className="relative">
            <Input
              id="confirmPassword"
              type={showConfirmPassword ? "text" : "password"}
              placeholder="Confirm your password"
              value={formData.confirmPassword}
              onChange={(e) => updateField("confirmPassword", e.target.value)}
              error={errors.confirmPassword}
              disabled={isLoading}
              autoComplete="new-password"
              className="pr-12 bg-mauve-500/40 mt-1 rounded-sm placeholder:text-mauve-400"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-mauve-400 hover:text-mauve-300 transition-colors"
              tabIndex={-1}
            >
              {showConfirmPassword ? (
                <EyeOff className="w-5 h-5" />
              ) : (
                <Eye className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>

        {/* Terms Checkbox */}
        <div className="space-y-1">
          <Checkbox
            id="acceptTerms"
            checked={formData.acceptTerms}
            onChange={(e) => updateField("acceptTerms", e.target.checked)}
            label={
              <span>
                I agree to the{" "}
                <Link href="/terms" className="text-accent hover:underline">
                  Terms of Service
                </Link>{" "}
                and{" "}
                <Link href="/privacy" className="text-accent hover:underline">
                  Privacy Policy
                </Link>
              </span>
            }
          />
          {errors.acceptTerms && (
            <p className="text-sm text-destructive">{errors.acceptTerms}</p>
          )}
        </div>

        {/* Submit Button */}
        <Button
          type="submit"
          className="w-full h-auto py-2 md:py-3"
          disabled={isLoading}
        >
          {isLoading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Creating account...
            </>
          ) : (
            "Create Account"
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}
