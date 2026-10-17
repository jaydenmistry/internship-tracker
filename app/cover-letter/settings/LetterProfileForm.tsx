"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { LetterProfileFields } from "@/lib/coverletter/profile-schema";
import { SIGNATURE_MAX_BYTES } from "@/lib/coverletter/profile-schema";
import { FONT_MAX_BYTES, FONT_WEIGHTS, type LetterFontsInfo } from "@/lib/coverletter/fonts-schema";
import {
  removeFontAction,
  removeSignatureAction,
  saveLetterProfileAction,
  uploadFontAction,
  uploadSignatureAction,
} from "./actions";

/**
 * The letterhead every exported cover letter uses: your name and contact
 * lines (centred at the top), the closing, the default recipient and
 * greeting, and a signature image placed between the closing and your name.
 */

const INPUT = "h-7 w-full rounded border border-line bg-raised px-2 text-[13px] text-ink placeholder:text-faint";
const BTN = "rounded border border-line px-3 py-1 text-[12px] text-dim hover:text-ink disabled:opacity-60";
const PRIMARY = "rounded border border-accent bg-accent px-3 py-1 text-[12px] text-accent-ink disabled:opacity-60";

interface Props {
  fields: LetterProfileFields;
  /** Names of the uploaded PDF fonts. */
  fonts: LetterFontsInfo;
  /** A data: URL of the stored signature, for the preview only. */
  signature: { src: string; width: number; height: number } | null;
}

export default function LetterProfileForm({ fields, fonts, signature }: Props) {
  const [f, setF] = useState(() => ({
    ...fields,
    contactLines: [0, 1, 2].map((i) => fields.contactLines[i] ?? ""),
  }));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>, done: string) => {
    setMessage(null);
    startTransition(async () => {
      let res: { ok: true } | { ok: false; message: string };
      try {
        res = await action();
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      setMessage(res.ok ? { ok: true, text: done } : { ok: false, text: res.message });
    });
  };

  const set = <K extends keyof typeof f>(key: K, value: (typeof f)[K]) => setF((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3">
      <header className="flex items-baseline gap-3">
        <Link href="/" className="text-[12px] text-faint hover:text-ink">
          ← Listings
        </Link>
        <h1 className="text-[15px] font-medium text-ink">Cover letter letterhead</h1>
      </header>
      <p className="text-[12px] text-dim">
        Used on every exported PDF and .docx. Your name goes in capitals at the top, the contact lines centred under
        it, and your name again under the signature.
      </p>

      <form
        className="flex flex-col gap-3 rounded border border-line bg-panel p-3 text-[12px]"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => saveLetterProfileAction({ ...f, contactLines: f.contactLines.map((l) => l.trim()) }), "Saved.");
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-dim">Your name</span>
          <input
            value={f.name}
            maxLength={100}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Your full name"
            className={INPUT}
          />
          {!fields.name.trim() && (
            <span className="text-[11px] text-warn">
              Not set — downloads print no name at the top or under the signature until you save one.
            </span>
          )}
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-dim">Contact lines (up to three)</legend>
          {f.contactLines.map((line, i) => (
            <input
              key={i}
              aria-label={`Contact line ${i + 1}`}
              value={line}
              maxLength={200}
              onChange={(e) => set("contactLines", f.contactLines.map((l, j) => (j === i ? e.target.value : l)))}
              placeholder={i === 0 ? "City, ST | phone | email" : i === 1 ? "website | linkedin.com/in/you | github.com/you" : ""}
              className={INPUT}
            />
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-dim">Recipient (first line)</span>
            <input value={f.recipient} maxLength={100} onChange={(e) => set("recipient", e.target.value)} className={INPUT} />
            <span className="text-[11px] text-faint">The company name goes on the line under it.</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-dim">Closing</span>
            <input value={f.closing} maxLength={60} onChange={(e) => set("closing", e.target.value)} className={INPUT} />
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-dim">Default greeting</span>
          <input value={f.greeting} maxLength={200} onChange={(e) => set("greeting", e.target.value)} className={INPUT} />
          <span className="text-[11px] text-faint">
            <code>{"{company}"}</code> becomes the company name. Each letter can override it.
          </span>
        </label>
        <div>
          <button type="submit" disabled={pending} className={PRIMARY}>
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>

      <section aria-label="Signature" className="flex flex-col gap-2 rounded border border-line bg-panel p-3 text-[12px]">
        <h2 className="font-mono text-[10px] font-semibold tracking-wide text-faint uppercase">Signature</h2>
        {signature ? (
          // A data: URL from our own database; the bytes were checked to be a PNG/JPEG on upload.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={signature.src}
            alt="Your signature"
            className="h-12 w-auto self-start rounded bg-white p-1"
            width={signature.width}
            height={signature.height}
          />
        ) : (
          <p className="text-faint">No signature yet — exports go straight from the closing to your name.</p>
        )}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            run(() => uploadSignatureAction(form), "Signature saved.");
            e.currentTarget.reset();
          }}
        >
          <input
            type="file"
            name="signature"
            accept="image/png,image/jpeg"
            required
            className="text-[12px] text-dim file:mr-2 file:rounded file:border file:border-line file:bg-raised file:px-2 file:py-0.5 file:text-dim"
          />
          <button type="submit" disabled={pending} className={BTN}>
            Upload
          </button>
          {signature && (
            <button type="button" disabled={pending} onClick={() => run(() => removeSignatureAction(), "Signature removed.")} className={`${BTN} hover:text-bad`}>
              Remove
            </button>
          )}
        </form>
        <p className="text-[11px] text-faint">
          PNG or JPEG, under {Math.round(SIGNATURE_MAX_BYTES / 1024)} KB. A scan on a white background works; it&apos;s drawn
          about 2&quot; wide.
        </p>
      </section>

      <section aria-label="PDF font" className="flex flex-col gap-2 rounded border border-line bg-panel p-3 text-[12px]">
        <h2 className="font-mono text-[10px] font-semibold tracking-wide text-faint uppercase">PDF font</h2>
        <p className="text-dim">
          PDFs use Helvetica unless you upload your own font — upload Aptos to match Word. It stays in this app&apos;s
          database (fonts can&apos;t be shipped with the app). Word files ask Word for the regular font&apos;s family
          {fonts.regular ? ` (${fonts.regular.family})` : " (Aptos)"}.
        </p>
        {FONT_WEIGHTS.map((weight) => {
          const current = fonts[weight];
          return (
            <form
              key={weight}
              aria-label={`${weight === "regular" ? "Regular" : "Bold"} font`}
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                form.set("weight", weight);
                run(() => uploadFontAction(form), "Font saved.");
                e.currentTarget.reset();
              }}
            >
              <span className="w-28 text-dim">
                {weight === "regular" ? "Regular" : "Bold (your name)"}
              </span>
              <span className={`w-36 truncate ${current ? "text-ink" : "text-faint"}`} data-testid={`font-${weight}`}>
                {current ? `${current.family} ${current.style}`.trim() : weight === "regular" ? "Helvetica" : "—"}
              </span>
              <input
                type="file"
                name="font"
                accept=".ttf,.otf,font/ttf,font/otf"
                required
                aria-label={`${weight === "regular" ? "Regular" : "Bold"} font file`}
                className="w-52 text-[12px] text-dim file:mr-2 file:rounded file:border file:border-line file:bg-raised file:px-2 file:py-0.5 file:text-dim"
              />
              <button type="submit" disabled={pending} className={BTN}>
                Upload
              </button>
              {current && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => removeFontAction(weight), "Font removed.")}
                  className={`${BTN} hover:text-bad`}
                >
                  Remove
                </button>
              )}
            </form>
          );
        })}
        <p className="text-[11px] text-faint">
          A single .ttf or .otf, under {Math.round(FONT_MAX_BYTES / 1024 / 1024)} MB. Without a bold font your name is
          emboldened from the regular one. Aptos is free from Microsoft&apos;s Aptos font download; on Windows with
          Office, the regular face is often already in
          <code className="mx-1">%LOCALAPPDATA%\Microsoft\FontCache\4\CloudFonts\Aptos</code>
          (a .ttf with a numeric name).
        </p>
      </section>

      {message && (
        <p role={message.ok ? "status" : "alert"} className={`text-[12px] ${message.ok ? "text-ok" : "text-bad"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
