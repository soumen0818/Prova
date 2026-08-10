/**
 * Short statements about what Prova can do *today*, shared by the app and the website.
 *
 * Defined once because a capability claim that drifts between two surfaces is how a product ends up
 * promising something on its website that its app cannot do.
 */

/**
 * One line explaining the current shape of the corridor.
 *
 * Wording chosen carefully, and worth preserving:
 *
 *  - **"withdraw to a bank account"**, not "direct bank transfer". Prova will never move money to a
 *    bank itself — a licensed partner does, and Prova hands off to it. Implying otherwise describes
 *    a regulated activity Prova does not perform.
 *  - **no date and no "soon"**, because the blocker is a commercial and regulatory arrangement, not
 *    a piece of code, and neither of those runs to a schedule we control.
 *  - It says what works today first. A limitation stated after the capability reads as honest; the
 *    same sentence reversed reads as an apology.
 */
export const CORRIDOR_STATUS_NOTE =
  'Today you can send to other Prova users. Withdrawals to a bank account will follow once a licensed partner is connected.';
