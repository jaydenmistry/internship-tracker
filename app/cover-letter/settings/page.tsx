import type { Metadata } from "next";
import { loadLetterProfile } from "@/lib/coverletter/profile";
import LetterProfileForm from "./LetterProfileForm";

export const metadata: Metadata = {
  title: "Letterhead · Internship Tracker",
  description: "Your name, contact lines and signature for exported cover letters.",
};

export const dynamic = "force-dynamic";

export default async function LetterSettingsPage() {
  const profile = await loadLetterProfile();
  const { signature, ...fields } = profile;
  return (
    <div className="px-4 py-3">
      <LetterProfileForm
        fields={fields}
        signature={
          signature
            ? { src: `data:${signature.mime};base64,${signature.base64}`, width: signature.width, height: signature.height }
            : null
        }
      />
    </div>
  );
}
