import { prisma } from "@/lib/db";
import {
  LETTER_PROFILE_KEY,
  LetterProfileSchema,
  parseLetterProfile,
  type LetterProfile,
  type LetterProfileFields,
  type Signature,
} from "./profile-schema";

/** Reads and writes the letterhead profile (one `Setting` row). */

export async function loadLetterProfile(): Promise<LetterProfile> {
  const row = await prisma.setting.findUnique({ where: { key: LETTER_PROFILE_KEY } });
  return parseLetterProfile(row?.value);
}

/** Serializable, so a field save and a signature upload from two tabs can't
 *  both read the old row and drop each other's change. */
async function update(change: (p: LetterProfile) => LetterProfile): Promise<LetterProfile> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { key: LETTER_PROFILE_KEY } });
    const next = LetterProfileSchema.parse(change(parseLetterProfile(row?.value)));
    await tx.setting.upsert({
      where: { key: LETTER_PROFILE_KEY },
      create: { key: LETTER_PROFILE_KEY, value: next },
      update: { value: next },
    });
    return next;
  }, { isolationLevel: "Serializable" });
}

export function saveLetterProfileFields(fields: LetterProfileFields): Promise<LetterProfile> {
  return update((p) => ({ ...p, ...fields }));
}

export function saveSignature(signature: Signature | null): Promise<LetterProfile> {
  return update((p) => ({ ...p, signature }));
}
