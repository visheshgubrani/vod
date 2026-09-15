import { APP_NAME } from "@/lib/site";
import { SetupWizard } from "@/components/setup/setup-wizard";
import { Navigation } from "@/components/navigation";

export const metadata = {
  title: `${APP_NAME} — Setup`,
  description: "Bring-your-own-keys deployment status and next steps",
};

export default function SetupPage() {
  return (
    <>
      <Navigation />
      <main className="mx-auto max-w-3xl px-6 pt-28 pb-20 md:pt-32">
        <h1 className="dash-title text-foreground">{APP_NAME} setup</h1>
        <p className="dash-body mt-3 max-w-[62ch] text-muted-foreground">
          {APP_NAME} runs on your own Cloudflare R2, Modal and Postgres
          accounts. This page checks what the API reports as configured.
        </p>
        <SetupWizard />
      </main>
    </>
  );
}
