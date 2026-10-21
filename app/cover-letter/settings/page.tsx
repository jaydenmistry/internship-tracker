import type { Metadata } from "next";
import { loadLetterProfile } from "@/lib/coverletter/profile";
import { loadLetterFonts } from "@/lib/coverletter/fonts";
import { letterFontsInfo } from "@/lib/coverletter/fonts-schema";
import LetterProfileForm from "./LetterProfileForm";

export const metadata: Metadata = {
  title: "Letterhead · Internship Tracker",
  description: "Your name, contact lines, signature and font for exported cover letters.",
};

export const dynamic = "force-dynamic";

export default async function LetterSettingsPage() {
  const profile = await loadLetterProfile();
  const fonts = letterFontsInfo(await loadLetterFonts());
  const { signature, ...fields } = profile;
  return (
    <div className="px-6 py-7 lg:px-10 lg:py-9">
      <LetterProfileForm
        fields={fields}
        fonts={fonts}
        signature={
          signature
            ? { src: `data:${signature.mime};base64,${signature.base64}`, width: signature.width, height: signature.height }
            : null
        }
      />
    </div>
  );
}
