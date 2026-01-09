// Auth form types

export interface SignupFormData {
    fullName: string;
    email: string;
    password: string;
    confirmPassword: string;
    companyName?: string;
    acceptTerms: boolean;
}

export interface LoginFormData {
    email: string;
    password: string;
    rememberMe: boolean;
}

export interface FormErrors {
    [key: string]: string | undefined;
}

export type PasswordStrength = "weak" | "medium" | "strong";

export function validateEmail(email: string): string | undefined {
    if (!email) return "Email is required";
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return "Please enter a valid email";
    return undefined;
}

export function validatePassword(password: string): string | undefined {
    if (!password) return "Password is required";
    if (password.length < 8) return "Password must be at least 8 characters";
    return undefined;
}

export function getPasswordStrength(password: string): PasswordStrength {
    if (!password || password.length < 8) return "weak";

    let score = 0;
    if (password.length >= 12) score++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
    if (/\d/.test(password)) score++;
    if (/[!@#$%^&*(),.?":{}|<>]/.test(password)) score++;

    if (score >= 3) return "strong";
    if (score >= 2) return "medium";
    return "weak";
}
