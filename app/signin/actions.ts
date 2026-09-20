"use server";

import { z } from "zod";
import { signIn, signOut } from "@/lib/auth";

/**
 * Where to land after signing in.
 *
 * Only a site-relative path is accepted, and `//host` is rejected explicitly —
 * a browser reads `//evil.test` as protocol-relative and would happily leave
 * the site, which is how an open redirect gets built out of a `next=` param.
 */
const NextPath = z
  .string()
  .max(512)
  .refine((v) => v.startsWith("/") && !v.startsWith("//"), "must be a site-relative path");

export async function startSignIn(formData: FormData): Promise<void> {
  const parsed = NextPath.safeParse(formData.get("next") ?? "/");
  await signIn("authentik", { redirectTo: parsed.success ? parsed.data : "/" });
}

export async function endSession(): Promise<void> {
  await signOut({ redirectTo: "/signin" });
}
