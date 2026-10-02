import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingForm } from "@/components/account/onboarding-form";
import { requireUser } from "@/lib/auth-server";
import { isMockProvider } from "@/lib/env";

export const metadata: Metadata = { title: "入门设置" };

export default async function OnboardingPage() {
  const u = await requireUser({ allowNotOnboarded: true });
  if (u.mustChangePassword) redirect("/change-password");
  return (
    <OnboardingForm
      mock={isMockProvider()}
      defaults={{ targetBand: u.targetBand ?? "6.5", selfLevel: u.selfLevel ?? "intermediate" }}
      consented={!!u.consentAt}
    />
  );
}
