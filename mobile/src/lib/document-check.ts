/**
 * On-device sanity checks for a captured identity document.
 *
 * ## What this is for
 *
 * The capture step used to accept any image at all — a wall, a desk, a thumb over the lens. That is
 * a bad experience long before it is a compliance question: the user finds out days later that their
 * verification failed, having done nothing obviously wrong. These checks catch that at the moment of
 * capture, while the document is still in their hand.
 *
 * ## What it can and cannot tell you
 *
 * It answers *"does this look like an identity document at all?"* — using signals that a photograph
 * of something else simply cannot produce:
 *
 *   - a **face** on the photo page (ML Kit face detection)
 *   - **machine-readable text** (ML Kit OCR); IDs are text-dense, a wall is not
 *   - for passports, a valid **MRZ** — and the MRZ carries ICAO 9303 check digits, so a line of
 *     random OCR noise cannot accidentally satisfy it
 *
 * It cannot tell you the document is **genuine**, or that it belongs to the person holding it. A
 * photo of somebody else's real passport passes all of these. Authenticity, tamper detection and
 * face-to-document matching are the verification provider's job (Docs/kyc-verification.md §8).
 * Treat this as input quality control, not verification.
 */

import FaceDetection from '@react-native-ml-kit/face-detection';
import TextRecognition from '@react-native-ml-kit/text-recognition';

/**
 * What is being captured — each carries different evidence, so each is checked differently.
 * `selfie` is the fallback path when the guided liveness check cannot run; it asks only for a
 * single clear face, since a person has no document number or expiry date.
 */
export type DocumentSide = 'front' | 'back' | 'selfie';

export interface DocumentCheck {
  ok: boolean;
  /** Shown to the user when `ok` is false. Says what to change, not what failed internally. */
  reason?: string;
}

/**
 * Enough recognised characters to call the image "text-bearing".
 *
 * Low on purpose: OCR through a phone camera at an angle drops a lot, and rejecting a real document
 * is far worse than letting a marginal one through — the provider re-checks everything anyway.
 */
const MIN_TEXT_CHARS = 12;

/** ICAO 9303 MRZ lines are fixed width: 2×44 (passport), 2×36 or 3×30 (ID cards). */
const MRZ_WIDTHS = [44, 36, 30];

/**
 * Words that appear on identity documents and almost nothing else a camera gets pointed at.
 *
 * Deliberately spans the corridor's real documents rather than assuming a passport: Emirates ID and
 * passports on the UAE side, and Aadhaar / voter ID / PAN / driving licence on the Indian side.
 * Matching is substring-based on uppercased OCR text, so partial reads still land.
 */
const ID_KEYWORDS = [
  // Generic
  'PASSPORT',
  'IDENTITY',
  'IDENTIFICATION',
  'GOVERNMENT',
  'REPUBLIC',
  'NATIONALITY',
  'DATE OF BIRTH',
  'DATE OF ISSUE',
  'DATE OF EXPIRY',
  'ISSUING',
  'AUTHORITY',
  'SURNAME',
  'GIVEN NAME',
  // UAE
  'EMIRATES',
  'UNITED ARAB',
  'RESIDENT IDENTITY',
  // India
  'AADHAAR',
  'UNIQUE IDENTIFICATION',
  'ELECTION COMMISSION',
  'ELECTOR',
  'INCOME TAX',
  'PERMANENT ACCOUNT',
  'DRIVING LICENCE',
  'DRIVING LICENSE',
  'TRANSPORT',
];

/**
 * Does the text carry the marks of an identity document, beyond merely being text?
 *
 * Any *one* of these is enough — requiring all three would fail real documents whenever OCR has a
 * bad moment, and a false rejection with the ID in the user's hand is the worst outcome here.
 */
function hasIdSignals(text: string): boolean {
  const upper = text.toUpperCase();

  if (ID_KEYWORDS.some((k) => upper.includes(k))) return true;

  // A date — every ID carries at least one (birth, issue or expiry), in some separator style.
  if (/\b\d{1,2}[\s./-]\d{1,2}[\s./-]\d{2,4}\b/.test(upper)) return true;
  if (
    /\b\d{1,2}[\s.-]?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*[\s.-]?\d{2,4}\b/.test(
      upper,
    )
  )
    return true;

  // A document number: a long digit run, or the mixed letter/digit shape IDs tend to use
  // (e.g. PAN `ABCDE1234F`, a licence like `DL0420110149646`).
  if (/\d{6,}/.test(upper.replace(/\s/g, ''))) return true;
  if (/\b[A-Z]{2,5}\d{4,}[A-Z]?\b/.test(upper.replace(/\s/g, ''))) return true;

  return false;
}

/**
 * ICAO 9303 check digit: weights cycle 7,3,1 over the field, letters are A=10…Z=35, `<` is 0.
 * Returning the digit lets the caller compare it against the one printed in the MRZ.
 */
function mrzCheckDigit(field: string): number {
  const WEIGHTS = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const c = field[i];
    let v: number;
    if (c >= '0' && c <= '9') v = c.charCodeAt(0) - 48;
    else if (c >= 'A' && c <= 'Z') v = c.charCodeAt(0) - 55;
    else if (c === '<') v = 0;
    else return -1; // character that cannot appear in an MRZ
    sum += v * WEIGHTS[i % 3];
  }
  return sum % 10;
}

/**
 * Look for an MRZ and verify at least one of its check digits.
 *
 * A real MRZ is self-validating, which makes this the single strongest signal available here: OCR
 * noise that happens to be 44 characters wide will not also satisfy a weighted mod-10 checksum.
 */
function hasValidMrz(text: string): boolean {
  const candidates = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s/g, '').toUpperCase())
    .filter((l) => MRZ_WIDTHS.includes(l.length) && /^[A-Z0-9<]+$/.test(l));

  for (const line of candidates) {
    // Passport line 2 layout: passport number (0-8) then its check digit at 9.
    if (line.length === 44) {
      const printed = line.charCodeAt(9) - 48;
      if (printed >= 0 && printed <= 9 && mrzCheckDigit(line.slice(0, 9)) === printed) return true;
    }
    // TD1 (30-char) line 1: document number (5-13) with its check digit at 14.
    if (line.length === 30) {
      const printed = line.charCodeAt(14) - 48;
      if (printed >= 0 && printed <= 9 && mrzCheckDigit(line.slice(5, 14)) === printed) return true;
    }
  }
  return false;
}

/**
 * Check a captured document image.
 *
 * Fails **open** on detector errors: if ML Kit itself throws, that is our problem, not the user's,
 * and blocking them from continuing over an internal fault would be the wrong trade.
 */
export async function checkDocument(uri: string, side: DocumentSide): Promise<DocumentCheck> {
  try {
    const [ocr, faces] = await Promise.all([
      TextRecognition.recognize(uri),
      // A face is expected on the photo page and in a selfie, but not on the reverse of a card.
      side === 'back'
        ? Promise.resolve([])
        : FaceDetection.detect(uri, { performanceMode: 'fast' }),
    ]);

    const text = ocr?.text ?? '';
    const letters = text.replace(/[^A-Za-z0-9]/g, '');
    const hasText = letters.length >= MIN_TEXT_CHARS;

    // Selfie fallback: exactly one clearly-detected face is the whole requirement.
    if (side === 'selfie') {
      if (faces.length === 0) {
        return {
          ok: false,
          reason: 'We could not see your face. Move somewhere brighter and look at the camera.',
        };
      }
      if (faces.length > 1) {
        return { ok: false, reason: 'More than one face in frame — make sure it is just you.' };
      }
      return { ok: true };
    }

    // A verified MRZ is conclusive on its own — it is a real document layout with a real checksum.
    if (hasValidMrz(text)) return { ok: true };

    if (side === 'front') {
      if (faces.length === 0 && !hasText) {
        return {
          ok: false,
          reason:
            'That does not look like an ID. Capture the photo side of a government-issued document, filling the frame.',
        };
      }
      if (faces.length === 0) {
        return {
          ok: false,
          reason:
            'We could not find the photo on your ID. Make sure the photo page is showing and fully in frame.',
        };
      }
      if (!hasText) {
        return {
          ok: false,
          reason:
            'We could not read any text. Move somewhere brighter, avoid glare, and keep the ID flat.',
        };
      }
      // A face and some words is also what a magazine page or a business card looks like. Real IDs
      // additionally carry a document number, a date, or issuing-authority wording.
      if (!hasIdSignals(text)) {
        return {
          ok: false,
          reason:
            'That does not look like an official ID. Use a government-issued document — passport, Emirates ID, Aadhaar, voter ID, PAN or driving licence.',
        };
      }
      return { ok: true };
    }

    // Back of a card: no face, but it is still covered in printed text (and usually an MRZ).
    if (!hasText) {
      return {
        ok: false,
        reason:
          'We could not read this side. Make sure the back of the card fills the frame, without glare.',
      };
    }
    return { ok: true };
  } catch {
    // Detector unavailable or failed — do not punish the user for our fault.
    return { ok: true };
  }
}
